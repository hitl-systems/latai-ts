// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * The runtime: open, run, stream, manage packs, close.
 *
 * Rules of the C ABI that this module keeps for you (docs/c-abi.md):
 *
 * - **One runtime per process.** A second `Runtime.open` before `close` is `E0901`.
 * - **Any call from any thread.** Requests run one at a time in the library's queue (a full queue
 *   is `BusyError` / `E0701`, retryable). The calls are made on a worker thread owned by the
 *   `Runtime` (see worker.cjs), so the event loop is never blocked, callbacks run on the thread
 *   that made the call, and `last_error` is read on that thread. Your code never runs inside a
 *   callback, so `E0303` (re-entry) cannot happen from `for await` bodies. The one exception to
 *   "never blocks the loop" is `close()`, which calls the library's `close` on the main thread
 *   (it stops requests in flight and joins the runtime's thread; milliseconds).
 * - **Strings out** are copied and released with the table's `free` before the reply is sent.
 * - `cancel(requestId)` and `ListenSession.cancel()` are synchronous and safe at any moment.
 */
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { Library, findLibrary } = require('./native.cjs');
const { LataiError, errorFor } = require('./errors.cjs');

const MAX_PUSH_BYTES = 1 << 20;

/** A request as JSON text: an object, JSON text, or UTF-8 bytes. */
function toJson(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  return JSON.stringify(value);
}

/** The request as JSON text with `"stream": true` (which `run_stream` needs to send deltas). */
function withStream(value) {
  const text = toJson(value);
  let obj;
  try {
    obj = typeof value === 'object' && !(value instanceof Uint8Array) ? value : JSON.parse(text);
  } catch {
    return text; // not JSON: let the library answer E0301
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) return JSON.stringify({ ...obj, stream: true });
  return text;
}

/** The thread that makes the calls; a promise per call. */
class Channel {
  constructor(libPath) {
    this._worker = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { libPath } });
    this._pending = new Map();
    this._next = 1;
    this._exited = false;
    this._worker.on('message', (m) => {
      const p = this._pending.get(m.id);
      if (!p) return;
      if (m.ev !== undefined) {
        p.onEvent(m.ev);
        return;
      }
      this._pending.delete(m.id);
      this._settle(p);
      p.resolve(m);
    });
    const fail = (err) => {
      this._exited = true;
      const all = [...this._pending.values()];
      this._pending.clear();
      for (const p of all) {
        this._settle(p);
        p.reject(err);
      }
    };
    this._worker.on('error', (e) => fail(e));
    this._worker.on('exit', () => fail(new LataiError('', 'the latai worker thread ended', '')));
    this._holds = 0;
    this._worker.unref();
  }

  /** Keep the process alive (`+1`) or stop doing so (`-1`): the worker is ref'd while holds > 0. */
  hold(delta) {
    this._holds += delta;
    if (this._holds > 0) this._worker.ref();
    else this._worker.unref();
  }

  _settle(p) {
    if (p.hold) this.hold(-1);
  }

  /**
   * Call `op` on the worker. A pending call keeps the process alive until it is answered, except
   * a `runStream` (`hold: false`): that one may wait for a consumer that never comes, so only
   * `EventStream.next()` holds the process while it awaits an event.
   */
  call(op, a = [], onEvent = null, hold = true) {
    if (this._exited) return Promise.reject(new LataiError('', 'the latai worker thread ended', ''));
    const id = this._next++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onEvent, hold });
      if (hold) this.hold(1);
      this._worker.postMessage({ id, op, a });
    });
  }
}

/** Throw the typed error of a failed reply; a `jsError` becomes an `Error`. */
function check(reply, extra) {
  if (reply.jsError) {
    const e = reply.jsError;
    if (e.name === 'LibraryNotFoundError') {
      const { LibraryNotFoundError } = require('./errors.cjs');
      throw new LibraryNotFoundError(e.message, e.tried || []);
    }
    throw new Error(e.message);
  }
  if (reply.rc !== 0) throw errorFor(reply.err || reply.rc, extra);
  return reply;
}

class EventStream {
  /**
   * The events of one `runStream` call, as an async iterator of event objects: `{event: "delta",
   * text, ms}` ..., then exactly one `{event: "final", response}` or `{event: "error", error}`.
   *
   * - Nothing starts until the first `next()`.
   * - Events are produced on the runtime's worker thread with a window of 64 events: a slow
   *   consumer slows the run down; no event is dropped or merged.
   * - `close()` (also `break` out of `for await`) stops the run: the C callback starts returning
   *   non-zero and `cancel` is called, so the run ends `finish: "cancelled"`; unread events are
   *   discarded.
   * - `cancel()` only asks the library to cancel the request; the iteration goes on and ends with
   *   the `final` (`finish: "cancelled"`).
   * - **Events are never thrown.** An `error` event, or a `final` with `finish: "error"`, is yielded
   *   like any event and the iteration then ends normally; look at the event (`final`, `code`).
   *   Only a call that fails before any terminal event (`E0302` closed runtime, `E0303`: the
   *   library delivers no event) throws. `raiseOnError: true` also throws the typed error of a
   *   failed terminal event after yielding it (`.response` set).
   */
  constructor(runtime, requestJson, requestId, raiseOnError) {
    this._runtime = runtime;
    this._json = requestJson;
    this.requestId = requestId;
    this._raise = raiseOnError;
    this._ctl = new SharedArrayBuffer(8);
    this._flags = new Int32Array(this._ctl);
    this._queue = [];
    this._waiter = null;
    this._started = false;
    this._done = null;
    this._finished = false;
    this._terminal = false;
    this._donePromise = null;
    /** The response of the `final` event once it was read. */
    this.final = null;
    /** The return code of the C call once the stream is done (`null` before). */
    this.code = null;
    runtime._streams.add(this);
  }

  _wake() {
    const w = this._waiter;
    this._waiter = null;
    if (w) w();
  }

  _start() {
    if (this._started) return;
    this._started = true;
    this._donePromise = this._runtime
      ._call('runStream', [this._runtime._handle(), this._json, this.requestId, this._ctl], (text) => {
        if (Atomics.load(this._flags, 1) !== 0) return;
        this._queue.push(JSON.parse(text));
        this._wake();
      }, false)
      .then(
        (reply) => {
          this._done = reply;
          this._wake();
        },
        (err) => {
          this._done = { jsError: { message: err.message } };
          this._wake();
        },
      );
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next() {
    if (this._finished) return { done: true, value: undefined };
    this._start();
    for (;;) {
      if (this._queue.length) {
        const ev = this._queue.shift();
        Atomics.add(this._flags, 0, 1);
        Atomics.notify(this._flags, 0);
        if (ev.event === 'final') this.final = ev.response;
        if (ev.event === 'final' || ev.event === 'error') this._terminal = true;
        return { done: false, value: ev };
      }
      if (this._done) {
        const reply = this._done;
        this._finished = true;
        this._runtime._streams.delete(this);
        if (reply.jsError) throw new Error(reply.jsError.message);
        this.code = reply.rc;
        if (reply.rc !== 0 && (this._raise || !this._terminal)) throw errorFor(reply.err || reply.rc, { response: this.final });
        return { done: true, value: undefined };
      }
      // Waiting for an event keeps the process alive; an unread stream does not.
      this._runtime._channel.hold(1);
      await new Promise((resolve) => {
        this._waiter = resolve;
      });
      this._runtime._channel.hold(-1);
    }
  }

  async return() {
    await this.close();
    return { done: true, value: undefined };
  }

  /** Ask the library to cancel the request; the stream ends with a `cancelled` `final`. */
  cancel() {
    try {
      this._runtime.cancel(this.requestId);
    } catch {
      /* the runtime may be closing */
    }
  }

  _abort() {
    Atomics.store(this._flags, 1, 1);
    Atomics.notify(this._flags, 0);
  }

  /** Stop the run now and free the worker. Safe to call twice. */
  async close() {
    this._runtime._streams.delete(this);
    if (this._finished) return;
    this._abort();
    if (this._started && !this._done) {
      this.cancel();
      // The run's call does not hold the process (it may wait for a consumer); this wait does.
      this._runtime._channel.hold(1);
      try {
        await this._donePromise;
      } finally {
        this._runtime._channel.hold(-1);
      }
    }
    this._finished = true;
    this._queue.length = 0;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

class ListenSession {
  /**
   * An open stream session on a speech pack (docs/audio.md#streams). Made by `Runtime.listen`.
   *
   * - `await push(data)` gives audio (raw 16-bit little-endian mono samples, or WAV bytes when the
   *   stream was opened with `format: "wav"`) and returns the events delivered during that call.
   *   Calls are serialised in call order.
   * - `await close(flush = true)` ends the audio (the last utterance is decoded, `finish: "stop"`)
   *   and returns the remaining events including the `final`; `flush = false` abandons it. Always
   *   close: it releases the handle.
   * - `cancel()` is synchronous and safe at any moment, also while a `push` is running.
   * - `onEvent(ev)` (optional) is called on the main thread for each event after the call that
   *   delivered it resolved, in order; returning `true` cancels the stream (it still ends with one
   *   `final`, `cancelled`). It is not the C callback: it may freely call anything.
   *
   * **Events are never thrown.** A call that ends the stream with an error (a cap `E0312`, bad
   * audio `E0318`, a failed pass) resolves with the events it delivered, the `final` with
   * `finish: "error"` among them; `ended` is true and `error` holds the wire error. Only a call
   * that delivers no terminal event rejects (`StreamState` `E0320` after the end, `E0302`,
   * `E0303`), and so does `Runtime.listen` when the stream cannot open (the error is also its one
   * `error` event, in `.events`). With `raiseOnError: true` a failed terminal event rejects with
   * the typed error after the call, `.events` holding the events.
   */
  constructor(runtime, handle, onEvent, raiseOnError = false) {
    this._raise = raiseOnError;
    /** The wire error that ended the stream (a failed `final` or an `error` event), if any. */
    this.error = null;
    this._runtime = runtime;
    this._handle = handle;
    this._onEvent = onEvent || null;
    this._tail = Promise.resolve();
    this.closed = false;
    /** Whether the stream has ended (a `final` was seen, or a call failed); close it anyway. */
    this.ended = false;
    /** The response of the `final` event, once seen. */
    this.final = null;
  }

  /** The transcript of the `final` (empty before it). */
  get transcript() {
    return (this.final && this.final.output && this.final.output.text) || '';
  }

  _see(strings) {
    const events = strings.map((s) => JSON.parse(s));
    for (const ev of events) {
      if (ev.event === 'final') {
        this.ended = true;
        this.final = ev.response;
        this.error = (ev.response && ev.response.error) || this.error;
      } else if (ev.event === 'error') {
        this.ended = true;
        this.error = ev.error;
      }
    }
    return events;
  }

  _notify(events) {
    if (!this._onEvent) return;
    for (const ev of events) {
      if (this._onEvent(ev) === true) this.cancel();
    }
  }

  _terminalIn(events) {
    return events.some((e) => e.event === 'final' || e.event === 'error');
  }

  _serial(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.catch(() => {});
    return run;
  }

  /** @param {Uint8Array|Buffer|ArrayBuffer} data @returns {Promise<object[]>} */
  push(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    return this._serial(async () => {
      if (this.closed) throw errorFor({ code: 'E0320', message: 'the stream session is closed', hint: 'Open a new session.', details: { state: 'closed' } });
      const all = [];
      for (let at = 0; at < Math.max(bytes.length, 1); at += MAX_PUSH_BYTES) {
        const chunk = Buffer.from(bytes.subarray ? bytes.subarray(at, at + MAX_PUSH_BYTES) : bytes);
        const reply = await this._runtime._call('streamPush', [this._handle, chunk]);
        if (reply.jsError) throw new Error(reply.jsError.message);
        const events = this._see(reply.events || []);
        all.push(...events);
        if (reply.rc !== 0) {
          // A refused call (E0302, E0303, E0320: no terminal event) is not the end of the stream.
          if (!this._terminalIn(events) || this._raise) throw errorFor(reply.err || reply.rc, { events: all });
        }
        if (this.ended) break;
      }
      this._notify(all);
      return all;
    });
  }

  /** Stop the stream from any thread; the `final` (`cancelled`) arrives with the push or close that is running or comes next. */
  cancel() {
    if (!this.closed && this._handle !== null) this._runtime._lib.streamCancel(this._handle);
  }

  /** @param {boolean} [flush=true] @returns {Promise<object[]>} */
  close(flush = true) {
    return this._serial(async () => {
      if (this.closed) return [];
      const reply = await this._runtime._call('streamClose', [this._handle, flush]);
      if (reply.jsError) throw new Error(reply.jsError.message);
      // A refused close (E0303: called from an event callback) leaves the handle open.
      if (reply.rc !== 0 && reply.err && reply.err.code === 'E0303') throw errorFor(reply.err);
      this.closed = true;
      this._runtime._sessions.delete(this);
      const events = this._see(reply.events || []);
      this._notify(events);
      if (reply.rc !== 0 && (!this._terminalIn(events) || this._raise)) throw errorFor(reply.err || reply.rc, { events });
      return events;
    });
  }

  async [Symbol.asyncDispose]() {
    await this.close(false);
  }
}

class Runtime {
  /** Use `await Runtime.open(...)`. */
  constructor(channel, lib, handle) {
    this._channel = channel;
    this._lib = lib; // for the two calls that must not wait: cancel and stream cancel
    this._rt = handle;
    this._sessions = new Set();
    this._streams = new Set();
  }

  /**
   * Open the runtime of this process.
   *
   * `dataDir` and `bundleDir` default to `LATAI_DATA_DIR` / `latai.toml` / the OS default
   * (docs/config.md). `lib` is the path of `liblatai` (see `libraryCandidates`).
   * @param {{dataDir?: string, bundleDir?: string, lib?: string}} [options]
   * @returns {Promise<Runtime>}
   */
  static async open(options = {}) {
    const libPath = findLibrary(options.lib ?? null);
    const lib = new Library(libPath);
    const channel = new Channel(libPath);
    try {
      check(await channel.call('init'));
      const config = {};
      if (options.dataDir != null) config.data_dir = String(options.dataDir);
      if (options.bundleDir != null) config.bundle_dir = String(options.bundleDir);
      const reply = check(await channel.call('open', [Object.keys(config).length ? JSON.stringify(config) : null]));
      return new Runtime(channel, lib, reply.handle);
    } catch (e) {
      await channel.call('exit').catch(() => {});
      throw e;
    }
  }

  get closed() {
    return this._rt === null;
  }

  /** The loaded library (`path`, `apiVersion`, `hasStreams`). */
  get library() {
    return this._lib;
  }

  _handle() {
    if (this._rt === null) {
      throw errorFor({ code: 'E0302', message: 'the runtime is closed', hint: 'Open a new Runtime.', details: { arg: 'rt' } });
    }
    return this._rt;
  }

  _call(op, args, onEvent, hold = true) {
    return this._channel.call(op, args, onEvent, hold);
  }

  /**
   * Close the runtime (idempotent): live `listen` sessions are cancelled and closed, requests in
   * flight are stopped, queued ones answered `cancelled`, the worker thread ends.
   */
  async close() {
    const rt = this._rt;
    if (rt === null) return;
    const sessions = [...this._sessions];
    for (const s of sessions) {
      try {
        s.cancel();
      } catch {
        /* already gone */
      }
    }
    for (const es of [...this._streams]) es._abort();
    // The library's own close, on this thread: it stops requests in flight (so the worker is
    // free again) and joins the runtime's thread. The runtime counts as closed only when it worked.
    const closed = this._lib.close(rt);
    if (closed.rc !== 0) throw errorFor(this._lib.lastError() || closed.rc);
    this._rt = null;
    for (const s of sessions) {
      try {
        await s.close(false);
      } catch {
        /* the handle is released either way */
      }
    }
    await this._channel.call('exit').catch(() => {});
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  // -- running --------------------------------------------------------------------------------

  /**
   * Run a request (docs/request.md) and wait for the response.
   *
   * `request` is an object, JSON text or UTF-8 bytes. `requestId` names it for `cancel`. A
   * response that ended `finish: "error"` rejects with the error of `response.error` (`.response`
   * holds the whole response; `response.latai.started === false` for an error before the run
   * began); with `raiseOnError: false` it is returned instead. `cancelled` and `length` resolve
   * normally. A request that does not parse (`BadRequest`, `E0301`) always rejects.
   * @param {object|string|Uint8Array} request
   * @param {{requestId?: string, raiseOnError?: boolean}} [options]
   * @returns {Promise<object>}
   */
  async run(request, options = {}) {
    const { requestId = null, raiseOnError = true } = options;
    const reply = await this._call('run', [this._handle(), toJson(request), requestId]);
    if (reply.jsError) throw new Error(reply.jsError.message);
    if (reply.out === null || reply.out === undefined) throw errorFor(reply.err || reply.rc);
    const response = JSON.parse(reply.out);
    if (reply.rc !== 0 && raiseOnError) throw errorFor(response.error || reply.err || reply.rc, { response });
    return response;
  }

  /**
   * Run a request and iterate its events (`delta`..., then one `final` or `error`).
   * `"stream": true` is set on the request for you. Errors are events here (`raiseOnError`
   * defaults to false, unlike `run`). See `EventStream`.
   * @returns {EventStream}
   */
  runStream(request, options = {}) {
    const { requestId = 'js-' + require('node:crypto').randomUUID(), raiseOnError = false } = options;
    this._handle();
    return new EventStream(this, withStream(request), requestId, raiseOnError);
  }

  /** Cancel a request by id (synchronous, safe at any moment); unknown or finished ids do nothing. */
  cancel(requestId) {
    const { rc } = this._lib.cancel(this._handle(), requestId);
    if (rc !== 0) throw errorFor(this._lib.lastError() || rc);
  }

  /** End a `session` (a KV-reuse hint): its next request runs cold. Unknown ids do nothing. */
  async sessionClose(session) {
    check(await this._call('sessionClose', [this._handle(), session]));
  }

  // -- streams of audio -----------------------------------------------------------------------

  /**
   * Open a stream session on a speech pack. `openRequest` is a `StreamOpen` object
   * (`{pack: "asr", format: "pcm16", ...}`), its JSON, or just a pack name. See `ListenSession`.
   * @param {object|string} openRequest
   * @param {{onEvent?: (ev: object) => boolean|void}} [options]
   * @returns {Promise<ListenSession>}
   */
  async listen(openRequest, options = {}) {
    const open = typeof openRequest === 'string' && !openRequest.trimStart().startsWith('{') ? { pack: openRequest } : openRequest;
    const reply = await this._call('streamOpen', [this._handle(), toJson(open)]);
    if (reply.jsError) throw new Error(reply.jsError.message);
    const events = (reply.events || []).map((s) => JSON.parse(s));
    if (reply.rc !== 0) throw errorFor(reply.err || reply.rc, { events });
    const session = new ListenSession(this, reply.handle, options.onEvent, options.raiseOnError === true);
    this._sessions.add(session);
    return session;
  }

  /**
   * Push each of `chunks` (an iterable or async iterable of byte arrays) into a new session and
   * yield every event, the `final` last. Closing the generator early abandons the stream.
   * @returns {AsyncGenerator<object>}
   */
  async *listenIter(openRequest, chunks) {
    const session = await this.listen(openRequest);
    let finished = false;
    try {
      for await (const chunk of chunks) {
        let events;
        try {
          events = await session.push(chunk);
        } catch (e) {
          if (e instanceof LataiError) yield* e.events;
          throw e;
        }
        yield* events;
        if (session.ended) break;
      }
      finished = true;
      try {
        yield* await session.close(true);
      } catch (e) {
        if (e instanceof LataiError) yield* e.events;
        throw e;
      }
    } finally {
      if (!finished || !session.closed) await session.close(false).catch(() => {});
    }
  }

  // -- information and packs ------------------------------------------------------------------

  /** Version, thread budget, engine variant, data directory, loaded packs, plug-ins. */
  async info() {
    const reply = check(await this._call('info', [this._handle()]));
    return JSON.parse(reply.out);
  }

  /** The state of a pack from local state only; no name gives the `RuntimeInfo` of `info`. */
  async status(name = null) {
    return JSON.parse(check(await this._call('status', [this._handle(), name])).out);
  }

  /** What a pack says about itself, without reading a tensor; `target` is a pack file or an installed pack's name. */
  async inspect(target) {
    return JSON.parse(check(await this._call('inspect', [this._handle(), String(target)])).out);
  }

  /** Check a pack file and its `.minisig` and store it as a version that is not active. */
  async stage(file) {
    return JSON.parse(check(await this._call('stage', [this._handle(), String(file)])).out);
  }

  /** Download the pack at `url` (and `<url>.minisig`) and stage it; `force` ignores the `[pull]` rules (`E0802`). */
  async pull(url, force = false) {
    return JSON.parse(check(await this._call('pull', [this._handle(), url, Boolean(force)])).out);
  }

  /** Stage a pack file, or every pack file of a folder, and (unless `activate` is false) make it serve. One receipt per file. */
  async install(source, activate = true) {
    return JSON.parse(check(await this._call('install', [this._handle(), String(source), Boolean(activate)])).out);
  }

  /** Make a version of `name` the one that serves; `version` (a serial, a folder name or a sha256) defaults to the newest the pin allows. */
  async activate(name, version = null) {
    return JSON.parse(check(await this._call('activate', [this._handle(), name, version])).out);
  }

  /** Bring the retained version of `name` back (`NoRollbackTarget`, `E0803`, if none). */
  async rollback(name) {
    return JSON.parse(check(await this._call('rollback', [this._handle(), name])).out);
  }

  /** Every installed version with its state and pin. */
  async listPacks() {
    return JSON.parse(check(await this._call('list', [this._handle()])).out);
  }

  /** Pin `name` to a sha256 or `"channel:NAME"`; `null` clears. Resolves to the pin now in force, or `null`. */
  async pin(name, pin = null) {
    return JSON.parse(check(await this._call('pin', [this._handle(), name, pin])).out);
  }

  /** `{taken, freed}`: strings the library handed out in this runtime's calls and strings given back (equal when idle). */
  async debugCounters() {
    return (await this._call('counters')).counters;
  }
}

module.exports = { EventStream, ListenSession, Runtime, MAX_PUSH_BYTES };
