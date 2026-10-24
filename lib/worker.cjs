// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * The thread that makes every blocking call into `liblatai` for one `Runtime`.
 *
 * Why a thread of its own: the C ABI blocks the caller (`run`, `run_stream`, `stage`, `stream_push`
 * ...), delivers callbacks on the calling thread, and keeps `last_error` per thread. Doing the
 * calls here keeps the event loop free, makes callbacks plain synchronous functions (a non-zero
 * return cancels, exactly as the ABI says) and lets `last_error` be read on the thread that failed.
 *
 * Protocol (structured-clone messages): the main thread sends `{id, op, a}`; this thread answers
 * `{id, rc, out?, handle?, err?, events?}` (`err` is the wire error of a non-zero `rc`), and, for
 * `runStream`, `{id, ev}` messages (one event string each) before the answer. Flow control of
 * `runStream`: a SharedArrayBuffer `ctl` (Int32Array: [0] events consumed by the main thread,
 * [1] cancel flag); the callback waits while `produced - consumed >= WINDOW`.
 */
const { parentPort, workerData } = require('node:worker_threads');
const { Library } = require('./native.cjs');

const WINDOW = 64;
let lib = null;
const sessions = new Map(); // String(handle) -> {reg, events: string[]}

function lastError(rc) {
  return rc !== 0 ? lib.lastError() || { code: rc } : null;
}

const ops = {
  open(cfg) {
    const { rc, handle } = lib.open(cfg);
    return { rc, handle };
  },
  close(rt) {
    return lib.close(rt);
  },
  info(rt) {
    return lib.info(rt);
  },
  run(rt, req, id) {
    return lib.run(rt, req, id);
  },
  runStream(rt, req, id, ctl, msgId) {
    const flags = new Int32Array(ctl);
    let produced = 0;
    const { rc } = lib.runStream(rt, req, id, (ptr, len) => {
      const text = lib.readEvent(ptr, len);
      for (;;) {
        if (Atomics.load(flags, 1) !== 0) return 1;
        const consumed = Atomics.load(flags, 0);
        if (produced - consumed < WINDOW) break;
        Atomics.wait(flags, 0, consumed, 50);
      }
      produced++;
      parentPort.postMessage({ id: msgId, ev: text });
      return 0;
    });
    return { rc };
  },
  sessionClose(rt, s) {
    return lib.sessionClose(rt, s);
  },
  inspect: (rt, t) => lib.inspect(rt, t),
  stage: (rt, p) => lib.stage(rt, p),
  pull: (rt, u, f) => lib.pull(rt, u, f),
  install: (rt, s, a) => lib.install(rt, s, a),
  activate: (rt, n, v) => lib.activate(rt, n, v),
  rollback: (rt, n) => lib.rollback(rt, n),
  list: (rt) => lib.list(rt),
  pin: (rt, n, p) => lib.pin(rt, n, p),
  status: (rt, n) => lib.status(rt, n),
  counters: () => ({ rc: 0, counters: lib.counters() }),
  streamOpen(rt, openJson) {
    const entry = { reg: null, events: [] };
    const { rc, handle, reg } = lib.streamOpen(rt, openJson, (ptr, len) => {
      entry.events.push(lib.readEvent(ptr, len));
      return 0;
    });
    entry.reg = reg;
    // A stream that opened keeps `entry` (the events of later pushes and the close are collected
    // in it); one that did not open returns its `error` event now.
    if (rc === 0) sessions.set(String(handle), entry);
    return { rc, handle, events: entry.events.splice(0) };
  },
  // The events of a push or close are those the callback saw during it.
  streamPush(stream, data) {
    const entry = sessions.get(String(stream));
    const { rc } = lib.streamPush(stream, data);
    return { rc, events: entry ? entry.events.splice(0) : [] };
  },
  streamClose(stream, flush) {
    const entry = sessions.get(String(stream));
    const { rc } = lib.streamClose(stream, flush);
    if (entry) {
      sessions.delete(String(stream));
      lib.unregister(entry.reg);
    }
    return { rc, events: entry ? entry.events.splice(0) : [] };
  },
};

parentPort.on('message', (msg) => {
  const { id, op, a } = msg;
  try {
    if (op === 'init') {
      lib = new Library(workerData.libPath);
      parentPort.postMessage({ id, rc: 0, info: { apiVersion: lib.apiVersion, hasStreams: lib.hasStreams, path: lib.path } });
      return;
    }
    if (op === 'exit') {
      parentPort.postMessage({ id, rc: 0 });
      parentPort.close();
      return;
    }
    const result = ops[op](...a, id);
    const reply = { id, ...result };
    reply.rc = result.rc;
    if (result.rc !== 0) reply.err = lastError(result.rc);
    parentPort.postMessage(reply);
  } catch (e) {
    parentPort.postMessage({ id, jsError: { name: e && e.name, message: e && e.message, code: e && e.code, tried: e && e.tried } });
  }
});
