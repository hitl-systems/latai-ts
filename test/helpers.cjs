// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Shared by the Node SDK tests (phase 14, tester 14A). Runs against the built liblatai and the
// real fixture packs; nothing here builds anything. Environment (all optional when the defaults resolve):
//   LATAI_LIB                 the built library (default <repo>/target/debug/liblatai.so)
//   LATAI_FIXTURES_DIR        the fixture cache (tests/fixtures/cache)
//   LATAI_TEST_PACK / LATAI_TEST_SPEECH_PACK  pack files
//   LATAI_TEST_STAGE_CHILD    the stage_child binary (default <repo>/target/debug/stage_child)
//   LATAI_REQUIRE_FIXTURES=1  a missing fixture fails the test instead of skipping it
//   koffi must be resolvable (npm install in sdk/node, or NODE_PATH).
// `node --test` runs every test file in a process of its own, which is what the one-runtime-per-process
// rule needs: one runtime per FILE.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SDK = path.resolve(__dirname, '..');
const REPO = path.resolve(SDK, '..', '..');
const PACK = 'x4r-l8';
const SPEECH = 'speech-qwen2a';

function requireFixtures() {
  return process.env.LATAI_REQUIRE_FIXTURES === '1';
}

/** A missing fixture: a failure when required, else the test is skipped (loudly). */
function missing(t, what) {
  const msg = `fixture missing: ${what} (set LATAI_FIXTURES_DIR / LATAI_REQUIRE_FIXTURES=1)`;
  if (requireFixtures()) throw new Error(msg);
  console.error('SKIP ' + msg);
  t.skip(msg);
  return null;
}

function fixturesDir() {
  if (process.env.LATAI_FIXTURES_DIR) return process.env.LATAI_FIXTURES_DIR;
  const d = path.join(REPO, 'tests', 'fixtures', 'cache');
  return fs.existsSync(d) ? d : null;
}

/** Path of a fixture file, or null after skipping `t` (throws when fixtures are required). */
function fixtureFile(t, env, rel) {
  let p = process.env[env];
  if (!p) {
    const base = fixturesDir();
    if (!base) return missing(t, rel);
    p = path.join(base, rel);
  }
  if (!fs.existsSync(p)) return missing(t, p);
  return p;
}

/** Put back an environment variable a test set (deleted when it was unset): the suite may run with
 * `LATAI_LIB` set, and the tests after this one need it. */
function restoreEnv(name, prev) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

function libFile() {
  const explicit = process.env.LATAI_LIB;
  const names = ['liblatai.so', 'liblatai.dylib', 'latai.dll'];
  if (explicit) {
    if (fs.existsSync(explicit) && fs.statSync(explicit).isDirectory()) {
      for (const n of names) if (fs.existsSync(path.join(explicit, n))) return path.join(explicit, n);
    } else if (fs.existsSync(explicit)) return explicit;
    throw new Error(`LATAI_LIB=${explicit} is not a built liblatai (cargo build -p latai-capi)`);
  }
  for (const profile of ['debug', 'release'])
    for (const n of names) {
      const p = path.join(REPO, 'target', profile, n);
      if (fs.existsSync(p)) return p;
    }
  throw new Error('liblatai is not built: run `cargo build -p latai-capi` and set LATAI_LIB');
}

function stageChild() {
  const p = process.env.LATAI_TEST_STAGE_CHILD || path.join(REPO, 'target', 'debug', 'stage_child');
  if (!fs.existsSync(p)) throw new Error(`stage_child binary not found at ${p}: build latai-conformance first`);
  return p;
}

function libraryPathVar() {
  return process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
}

/** An empty data folder that trusts the test key, uses the dev channel and stages through the conformance stage child. */
function makeDataDir(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `latai-sdk-node-${tag}-`));
  const d = path.join(root, 'data');
  fs.mkdirSync(path.join(d, 'keys', 'packs'), { recursive: true });
  const key = process.env.LATAI_TEST_PUB || path.join(REPO, 'tests', 'fixtures', 'keys', 'test.pub');
  fs.copyFileSync(key, path.join(d, 'keys', 'packs', 'test.pub'));
  if (process.env.LATAI_TEST_STAGE_CHILD === 'core') {
    // The core's own `latai` beside liblatai stages, as in a shipped app: no stage_child line.
    fs.writeFileSync(path.join(d, 'latai.toml'), '[runtime]\nchannel = "dev"\n');
    return d;
  }
  const libdirs = [path.dirname(libFile())];
  const v = libraryPathVar();
  if (process.env[v]) libdirs.push(process.env[v]);
  else {
    // run by hand, outside cargo: the llama libraries the newest build left
    const buildDir = path.join(REPO, 'target', 'debug', 'build');
    if (fs.existsSync(buildDir)) {
      const found = fs
        .readdirSync(buildDir)
        .filter((n) => n.startsWith('llama-cpp-sys-2-'))
        .map((n) => path.join(buildDir, n, 'out', 'lib'))
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (found[0]) libdirs.push(found[0]);
    }
  }
  let program;
  if (process.platform === 'win32') {
    // No /bin/sh to run a wrapper, and none needed: Windows finds the llama DLLs beside the
    // executable (the sys crate links them into target/<profile>, where stage_child.exe is).
    program = stageChild();
  } else {
    program = path.join(d, 'stage-child.sh');
    fs.writeFileSync(program, `#!/bin/sh\n${v}='${libdirs.join(path.delimiter)}' exec '${stageChild()}'\n`);
    fs.chmodSync(program, 0o755);
  }
  // A TOML basic string: JSON's escaping is valid TOML, and a Windows path needs it (`\U` is a unicode escape there).
  fs.writeFileSync(path.join(d, 'latai.toml'), `[runtime]\nstage_child = ${JSON.stringify(program)}\nchannel = "dev"\n`);
  return d;
}

function cleanup(dataDir) {
  try {
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
  } catch {}
}

/** Open a runtime on a fresh data folder with `files` installed through the SDK's own install. */
async function openInstalled(latai, t, files, tag) {
  const data = makeDataDir(tag);
  const rt = await latai.Runtime.open({ dataDir: data, lib: libFile() });
  for (const f of files) {
    const receipts = await rt.install(f);
    if (!Array.isArray(receipts) || receipts.length !== 1) throw new Error('install: ' + JSON.stringify(receipts));
  }
  return { rt, data };
}

function textReq(text = 'hello', maxTokens = 4, pack = PACK, extra = {}) {
  return { pack, inputs: { type: 'text', text }, output: { max_tokens: maxTokens }, ...extra };
}

/** Deterministic raw 16-bit little-endian mono samples. */
function sinePcm16(seconds = 1, rate = 16000, freq = 440, amp = 8000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.trunc(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}

function wavFile(pcm, rate = 16000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function speechClipPcm16(t, name) {
  const p = fixtureFile(t, 'LATAI_TEST_CLIP_' + name.toUpperCase(), `speech/clip-${name}.f32le`);
  if (!p) return null;
  const raw = fs.readFileSync(p);
  const n = Math.floor(raw.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, raw.readFloatLE(i * 4)));
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

// The wire schema: latai's schema/, or testdata/schema in the SDK's own public repository.
const SCHEMA_DIR = fs.existsSync(path.join(REPO, 'schema')) ? path.join(REPO, 'schema') : path.join(SDK, 'testdata', 'schema');
const schema = () => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'latai.schema.json'), 'utf8'));
const errorsJson = () => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'errors.json'), 'utf8'));

/** Structural check of an instance against `$defs/<name>`: required keys and, when closed, the key set. */
function validate(assert, name, instance) {
  const def = schema().$defs[name];
  if (def.type === 'object') {
    assert.equal(typeof instance, 'object', `${name} is an object`);
    assert.ok(instance !== null && !Array.isArray(instance), `${name} is an object`);
    for (const k of def.required || []) assert.ok(k in instance, `${name}: missing ${k}`);
    if (def.additionalProperties === false) {
      const extra = Object.keys(instance).filter((k) => !(k in (def.properties || {})));
      assert.deepEqual(extra, [], `${name}: unknown keys`);
    }
  }
}

function rssKb() {
  return Math.floor(process.memoryUsage.rss() / 1024);
}

function stripTiming(resp) {
  const out = JSON.parse(JSON.stringify(resp));
  if (out.latai) delete out.latai.timing;
  return out;
}

async function collect(stream) {
  const out = [];
  for await (const e of stream) out.push(e);
  return out;
}

const terminals = (events) => events.filter((e) => e.event === 'final' || e.event === 'error');

module.exports = {
  SDK, REPO, PACK, SPEECH, requireFixtures, missing, fixtureFile, libFile, restoreEnv, stageChild, makeDataDir, cleanup, openInstalled,
  textReq, sinePcm16, wavFile, speechClipPcm16, schema, errorsJson, validate, rssKb, stripTiming, collect, terminals,
};
