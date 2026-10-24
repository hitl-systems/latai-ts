// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * Find and load `liblatai` and call its C table (`include/latai.h`) through koffi.
 *
 * Rules of the C ABI that this module keeps (docs/c-abi.md): JSON goes in as (pointer, length);
 * names as NUL-terminated UTF-8; a string comes out in `*out` / `*out_len`, is copied into a JS
 * string and released at once with the table's own `free`; `info` and `last_error` follow the
 * NULL-buffer rule. **`last_error` is per thread**, so every wrapper reads it on the thread that
 * made the failing call (the runtime does all its calls on one worker thread, see runtime.cjs).
 * A callback runs on the thread that made the call and its string is valid only during the call.
 *
 * Wrappers do not throw for a non-zero return code: they return `{rc, out?, handle?}`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { LibraryNotFoundError, UnsupportedError } = require('./errors.cjs');

const API_VERSION = 2;
const NAMES = [
  'open', 'close', 'info', 'run', 'run_stream', 'cancel', 'session_close', 'inspect', 'stage', 'pull',
  'install', 'activate', 'rollback', 'list', 'pin', 'status', 'stage_child', 'free', 'last_error',
  // Version 2.
  'stream_open', 'stream_push', 'stream_cancel', 'stream_close',
];

/** The file names `liblatai` has on a platform (`process.platform` text). */
function libraryFileNames(platform = process.platform) {
  if (platform === 'win32' || platform === 'cygwin') return ['latai.dll', 'liblatai.dll'];
  if (platform === 'darwin') return ['liblatai.dylib'];
  return ['liblatai.so'];
}

const join = (dir, names, platform) => {
  const sep = platform === 'win32' ? '\\' : '/';
  return names.map((n) => dir.replace(/[\\/]+$/, '') + sep + n);
};

/** The npm package that carries the core of a platform: `@latai/core-linux-x64`, ... */
function corePackageName(platform = process.platform, arch = process.arch) {
  return `@latai/core-${platform}-${arch}`;
}

/** The `core/` folder of the installed core package of this platform, or null. */
function corePackageDir() {
  try {
    return path.join(path.dirname(require.resolve(`${corePackageName()}/package.json`)), 'core');
  } catch {
    return null;
  }
}

/**
 * Where `liblatai` is looked for, in order. Pure: nothing is read from the file system.
 *
 * 1. `explicit` (a file, or a folder holding the library);
 * 2. `$LATAI_LIB` (a file, or a folder);
 * 3. `$LATAI_LIB_DIR` (a folder);
 * 4. the core package of this platform, `@latai/core-<platform>-<arch>` (an optional dependency of
 *    the published `latai`; `opts.coreDir` is its `core/` folder, found by `corePackageDir()`);
 * 5. next to the package: `<package>/` and `<package>/lib/`;
 * 6. a source checkout: `<repo>/target/debug` and `<repo>/target/release` (the package lives in
 *    `<repo>/sdk/node`);
 * 7. the usual system folders (`/usr/local/lib`, `/usr/lib`, `/opt/homebrew/lib`);
 * 8. the bare file names, which the dynamic loader resolves (`LD_LIBRARY_PATH`, `PATH` ...).
 *
 * @param {string|null} [explicit]
 * @param {{environ?: Record<string,string|undefined>, platform?: string, packageDir?: string, coreDir?: string|null}} [opts]
 * @returns {string[]}
 */
function libraryCandidates(explicit = null, opts = {}) {
  const env = opts.environ ?? process.env;
  const platform = opts.platform ?? process.platform;
  const names = libraryFileNames(platform);
  const out = [];
  const add = (c) => {
    if (c && !out.includes(c)) out.push(c);
  };
  const addPathOrDir = (p) => {
    add(p);
    join(p, names, platform).forEach(add);
  };
  if (explicit) addPathOrDir(String(explicit));
  if (env.LATAI_LIB) addPathOrDir(env.LATAI_LIB);
  if (env.LATAI_LIB_DIR) join(env.LATAI_LIB_DIR, names, platform).forEach(add);
  if (opts.coreDir) join(opts.coreDir, names, platform).forEach(add);
  const pkg = opts.packageDir ?? path.resolve(__dirname, '..');
  for (const d of [pkg, path.join(pkg, 'lib')]) join(d, names, platform).forEach(add);
  const repo = path.dirname(path.dirname(pkg));
  for (const profile of ['debug', 'release']) join(path.join(repo, 'target', profile), names, platform).forEach(add);
  if (platform !== 'win32') {
    for (const d of ['/usr/local/lib', '/usr/lib', '/opt/homebrew/lib']) join(d, names, platform).forEach(add);
  }
  names.forEach(add);
  return out;
}

/**
 * The path (or loader name) of `liblatai`: the file named by `explicit` or `$LATAI_LIB` (an error
 * if nothing is there), else the first candidate that exists, else the first bare name the loader
 * can open. Throws `LibraryNotFoundError` listing what was tried.
 */
function findLibrary(explicit = null, opts = {}) {
  const env = opts.environ ?? process.env;
  const platform = opts.platform ?? process.platform;
  // A path you name (the argument, or $LATAI_LIB) is not a hint: if nothing is there, say so
  // instead of loading some other liblatai.
  for (const [what, given] of [['the library path', explicit], ['$LATAI_LIB', env.LATAI_LIB]]) {
    if (!given) continue;
    const own = [String(given), ...join(String(given), libraryFileNames(platform), platform)];
    for (const c of own) {
      try {
        if (fs.statSync(c).isFile()) return path.resolve(c);
      } catch {
        /* not there */
      }
    }
    throw new LibraryNotFoundError(`${what} ${JSON.stringify(given)} does not hold liblatai (tried: ${own.join(', ')})`, own);
  }
  const cands = libraryCandidates(explicit, { coreDir: 'coreDir' in opts ? opts.coreDir : corePackageDir(), ...opts });
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return path.resolve(c);
    } catch {
      /* not there */
    }
  }
  const koffi = require('koffi');
  for (const c of cands) {
    if (!/[\\/]/.test(c)) {
      try {
        koffi.load(c).unload();
        return c;
      } catch {
        /* not loadable by name */
      }
    }
  }
  throw new LibraryNotFoundError(`liblatai was not found (tried: ${cands.join(', ')})`, cands);
}

/** A loaded `liblatai`. Every method is synchronous and may be called from any thread. */
class Library {
  constructor(libPath = null) {
    const koffi = require('koffi');
    this.koffi = koffi;
    this.path = findLibrary(libPath);
    let lib;
    try {
      lib = koffi.load(this.path);
    } catch (e) {
      throw new LibraryNotFoundError(`cannot load ${this.path}: ${e.message}`, [this.path]);
    }
    let getApi;
    try {
      getApi = lib.func('const void *latai_get_api(uint32_t v)');
    } catch {
      throw new LibraryNotFoundError(`${this.path} has no latai_get_api: not liblatai`, [this.path]);
    }
    const ptr = getApi(API_VERSION) || getApi(1);
    if (!ptr) throw new LibraryNotFoundError(`${this.path} does not serve an API table we know`, [this.path]);
    const fields = { size: 'size_t', version: 'uint32_t' };
    for (const n of NAMES) fields[n] = 'void *';
    this._tableType = koffi.struct(`LataiApi_${process.pid}_${Library._n = (Library._n || 0) + 1}`, fields);
    // `size` and `version` are the first two fields; later entries exist only when `size` says so.
    const head = koffi.decode(ptr, koffi.struct(`LataiApiHead_${Library._n}`, { size: 'size_t', version: 'uint32_t' }));
    this.apiVersion = Number(head.version);
    this.hasStreams = Number(head.size) >= koffi.sizeof(this._tableType);
    const table = this.hasStreams ? koffi.decode(ptr, this._tableType) : this._decodeV1(ptr);
    const P = (s) => koffi.proto(s);
    const EventCb = koffi.proto(`int32_t LataiEventCallback${Library._n}(void *user, const void *ev, size_t len)`);
    this.EventCb = EventCb;
    const at = (name, proto) => (table[name] ? koffi.decode(table[name], proto) : null);
    const n = Library._n;
    this._f = {
      open: at('open', P(`int32_t f_open${n}(const void *cfg, size_t len, _Out_ void **rt)`)),
      close: at('close', P(`int32_t f_close${n}(void *rt)`)),
      info: at('info', P(`int32_t f_info${n}(void *rt, void *buf, _Inout_ size_t *len)`)),
      run: at('run', P(`int32_t f_run${n}(void *rt, const void *req, size_t len, const char *id, _Out_ void **out, _Out_ size_t *outlen)`)),
      run_stream: at('run_stream', P(`int32_t f_run_stream${n}(void *rt, const void *req, size_t len, const char *id, ${'LataiEventCallback' + n} *cb, void *user)`)),
      cancel: at('cancel', P(`int32_t f_cancel${n}(void *rt, const char *id)`)),
      session_close: at('session_close', P(`int32_t f_session_close${n}(void *rt, const char *s)`)),
      inspect: at('inspect', P(`int32_t f_inspect${n}(void *rt, const char *t, _Out_ void **out, _Out_ size_t *outlen)`)),
      stage: at('stage', P(`int32_t f_stage${n}(void *rt, const char *p, _Out_ void **out, _Out_ size_t *outlen)`)),
      pull: at('pull', P(`int32_t f_pull${n}(void *rt, const char *u, int32_t force, _Out_ void **out, _Out_ size_t *outlen)`)),
      install: at('install', P(`int32_t f_install${n}(void *rt, const char *s, int32_t activate, _Out_ void **out, _Out_ size_t *outlen)`)),
      activate: at('activate', P(`int32_t f_activate${n}(void *rt, const char *name, const char *version, _Out_ void **out, _Out_ size_t *outlen)`)),
      rollback: at('rollback', P(`int32_t f_rollback${n}(void *rt, const char *name, _Out_ void **out, _Out_ size_t *outlen)`)),
      list: at('list', P(`int32_t f_list${n}(void *rt, _Out_ void **out, _Out_ size_t *outlen)`)),
      pin: at('pin', P(`int32_t f_pin${n}(void *rt, const char *name, const char *pin, _Out_ void **out, _Out_ size_t *outlen)`)),
      status: at('status', P(`int32_t f_status${n}(void *rt, const char *name, _Out_ void **out, _Out_ size_t *outlen)`)),
      stage_child: at('stage_child', P(`int32_t f_stage_child${n}(const void *req, size_t len, _Out_ void **out, _Out_ size_t *outlen)`)),
      free: at('free', P(`void f_free${n}(void *p)`)),
      last_error: at('last_error', P(`int32_t f_last_error${n}(void *buf, _Inout_ size_t *len)`)),
    };
    if (this.hasStreams) {
      Object.assign(this._f, {
        stream_open: at('stream_open', P(`int32_t f_stream_open${n}(void *rt, const void *open, size_t len, ${'LataiEventCallback' + n} *cb, void *user, _Out_ void **out)`)),
        stream_push: at('stream_push', P(`int32_t f_stream_push${n}(void *stream, const void *data, size_t len)`)),
        stream_cancel: at('stream_cancel', P(`int32_t f_stream_cancel${n}(void *stream)`)),
        stream_close: at('stream_close', P(`int32_t f_stream_close${n}(void *stream, int32_t flush)`)),
      });
    }
    this._taken = 0;
    this._freed = 0;
  }

  _decodeV1(ptr) {
    // A version-1 table is shorter: decode only the entries it has.
    const koffi = this.koffi;
    const fields = { size: 'size_t', version: 'uint32_t' };
    for (const n of NAMES.slice(0, 19)) fields[n] = 'void *';
    return koffi.decode(ptr, koffi.struct(`LataiApiV1_${Library._n}`, fields));
  }

  /** Strings taken from the library minus strings freed (0 outside a call). */
  get outstandingStrings() {
    return this._taken - this._freed;
  }

  /** `{taken, freed}`: strings the library handed out through `*out`, and strings given back. */
  counters() {
    return { taken: this._taken, freed: this._freed };
  }

  _take(ptr, len) {
    if (!ptr) return null;
    this._taken++;
    try {
      return len > 0 ? Buffer.from(this.koffi.view(ptr, len)).toString('utf8') : '';
    } finally {
      this._f.free(ptr);
      this._freed++;
    }
  }

  _outCall(fn, ...args) {
    const out = [null];
    const len = [0];
    const rc = fn(...args, out, len);
    return { rc, out: this._take(out[0], Number(len[0])) };
  }

  _bufferCall(fn, ...args) {
    const need = [0];
    let rc = fn(...args, null, need);
    if (rc !== 0) return { rc, out: '' };
    for (let attempt = 0; attempt < 8; attempt++) {
      const cap = Number(need[0]);
      const buf = Buffer.alloc(Math.max(cap, 1));
      const n = [cap];
      rc = fn(...args, buf, n);
      if (rc !== 0) return { rc, out: '' };
      if (Number(n[0]) <= cap) return { rc: 0, out: buf.toString('utf8', 0, Math.max(Number(n[0]) - 1, 0)) };
      need[0] = n[0];
    }
    return { rc: 0, out: '' };
  }

  /** The wire error of the last failing call **on this thread**, or `null`. */
  lastError() {
    const { rc, out } = this._bufferCall(this._f.last_error);
    if (rc !== 0 || !out) return null;
    const v = JSON.parse(out);
    return v && typeof v === 'object' ? v : null;
  }

  open(configJson) {
    const rt = [null];
    const buf = configJson ? Buffer.from(configJson, 'utf8') : null;
    const rc = this._f.open(buf, buf ? buf.length : 0, rt);
    return { rc, handle: rc === 0 ? rt[0] : null };
  }
  close(rt) {
    return { rc: this._f.close(rt) };
  }
  info(rt) {
    return this._bufferCall(this._f.info, rt);
  }
  run(rt, requestJson, requestId) {
    const req = Buffer.from(requestJson, 'utf8');
    return this._outCall(this._f.run, rt, req, req.length, requestId ?? null);
  }
  /** Blocks until the run ends; `cb(ptr, len)` gets each event on this thread. */
  runStream(rt, requestJson, requestId, cb) {
    const req = Buffer.from(requestJson, 'utf8');
    const reg = this.koffi.register((_user, ptr, len) => cb(ptr, Number(len)), this.koffi.pointer(this.EventCb));
    try {
      return { rc: this._f.run_stream(rt, req, req.length, requestId ?? null, reg, null) };
    } finally {
      this.koffi.unregister(reg);
    }
  }
  cancel(rt, requestId) {
    return { rc: this._f.cancel(rt, requestId) };
  }
  sessionClose(rt, session) {
    return { rc: this._f.session_close(rt, session) };
  }
  inspect(rt, target) {
    return this._outCall(this._f.inspect, rt, target);
  }
  stage(rt, p) {
    return this._outCall(this._f.stage, rt, p);
  }
  pull(rt, url, force) {
    return this._outCall(this._f.pull, rt, url, force ? 1 : 0);
  }
  install(rt, source, activate) {
    return this._outCall(this._f.install, rt, source, activate ? 1 : 0);
  }
  activate(rt, name, version) {
    return this._outCall(this._f.activate, rt, name, version ?? null);
  }
  rollback(rt, name) {
    return this._outCall(this._f.rollback, rt, name);
  }
  list(rt) {
    return this._outCall(this._f.list, rt);
  }
  pin(rt, name, pin) {
    return this._outCall(this._f.pin, rt, name, pin ?? null);
  }
  status(rt, name) {
    return this._outCall(this._f.status, rt, name ?? null);
  }
  /** For `latai __stage-child` only: it limits the address space of this process. Never call it from a program that means to go on running. */
  stageChild(requestJson) {
    const req = Buffer.from(requestJson, 'utf8');
    return this._outCall(this._f.stage_child, req, req.length);
  }

  _needStreams() {
    if (!this.hasStreams) throw new UnsupportedError(`${this.path} is API version ${this.apiVersion}: no stream_* entries`);
  }
  /**
   * Open a stream session. `cb(ptr, len)` gets every event of the stream, on the thread that
   * pushes or closes it; the registration lives until `streamClose` (returned as `reg`).
   */
  streamOpen(rt, openJson, cb) {
    this._needStreams();
    const koffi = this.koffi;
    const req = Buffer.from(openJson, 'utf8');
    const reg = koffi.register((_user, ptr, len) => cb(ptr, Number(len)), koffi.pointer(this.EventCb));
    const out = [null];
    const rc = this._f.stream_open(rt, req, req.length, reg, null, out);
    if (rc !== 0 || !out[0]) {
      // The error event was delivered inside the call; the callback is not needed again.
      koffi.unregister(reg);
      return { rc, handle: null, reg: null };
    }
    return { rc, handle: out[0], reg };
  }
  streamPush(stream, data) {
    this._needStreams();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { rc: this._f.stream_push(stream, buf, buf.length) };
  }
  streamCancel(stream) {
    this._needStreams();
    return { rc: this._f.stream_cancel(stream) };
  }
  streamClose(stream, flush) {
    this._needStreams();
    return { rc: this._f.stream_close(stream, flush ? 1 : 0) };
  }
  /** Read an event string handed to a callback (valid only during the callback). */
  readEvent(ptr, len) {
    return len > 0 ? Buffer.from(this.koffi.view(ptr, len)).toString('utf8') : '';
  }
  unregister(reg) {
    if (reg !== null && reg !== undefined) this.koffi.unregister(reg);
  }
}

module.exports = {
  API_VERSION,
  Library,
  corePackageDir,
  corePackageName,
  findLibrary,
  libraryCandidates,
  libraryFileNames,
};
