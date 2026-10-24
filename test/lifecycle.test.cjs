// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// open/close lifecycle on the real library. One process (this file) opens and closes runtimes one after the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const latai = require('..');
const h = require('./helpers.cjs');

let data;
test.before(() => {
  data = h.makeDataDir('lifecycle');
});
test.after(() => h.cleanup(data));

const open = (extra = {}) => latai.Runtime.open({ dataDir: data, lib: h.libFile(), ...extra });

test('the library wrapper reports the version, streams and no outstanding strings', () => {
  const lib = new latai.Library(h.libFile());
  assert.ok(lib.apiVersion >= 2);
  assert.equal(lib.hasStreams, true);
  assert.equal(lib.outstandingStrings, 0);
});

test('open, info, close', async () => {
  const rt = await open();
  try {
    assert.equal(rt.closed, false);
    const info = await rt.info();
    h.validate(assert, 'RuntimeInfo', info);
    assert.equal(info.data_dir.replace(/\/$/, ''), data.replace(/\/$/, ''));
  } finally {
    await rt.close();
  }
  assert.equal(rt.closed, true);
});

test('close twice is harmless', async () => {
  const rt = await open();
  await rt.close();
  await rt.close();
  assert.equal(rt.closed, true);
});

test('use after close is a typed error', async () => {
  const rt = await open();
  await rt.close();
  const calls = [
    () => rt.run(h.textReq()),
    () => rt.info(),
    () => rt.status(),
    () => rt.listPacks(),
    () => rt.inspect('x4r-l8'),
    () => rt.sessionClose('x'),
    async () => {
      for await (const _ of rt.runStream(h.textReq())) void _;
    },
  ];
  for (const call of calls) {
    await assert.rejects(call(), (e) => {
      assert.ok(e instanceof latai.LataiError, String(e));
      assert.ok(e.code === 'E0302' || e.code === '', e.code);
      assert.ok(e.message);
      return true;
    });
  }
  assert.throws(() => rt.cancel('x'), (e) => e instanceof latai.LataiError);
});

test('a second open in one process is E0901 with the class, and the first keeps working', async () => {
  const first = await open();
  try {
    await assert.rejects(open(), (e) => {
      assert.ok(e instanceof latai.ERROR_CLASSES.E0901);
      assert.ok(e instanceof latai.InternalError);
      assert.equal(e.code, 'E0901');
      assert.ok(e.hint);
      return true;
    });
    h.validate(assert, 'RuntimeInfo', await first.info());
  } finally {
    await first.close();
  }
  const again = await open();
  h.validate(assert, 'RuntimeInfo', await again.info());
  await again.close();
});

test('two opens at once: exactly one wins, the other is E0901', async () => {
  const results = await Promise.allSettled([open(), open()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  try {
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].reason.code, 'E0901');
  } finally {
    for (const r of ok) await r.value.close();
  }
});

test('a data directory that is a file is a typed error and the process can open afterwards', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const f = path.join(data, 'not-a-dir');
  fs.writeFileSync(f, 'x');
  await assert.rejects(latai.Runtime.open({ dataDir: f, lib: h.libFile() }), (e) => e instanceof latai.LataiError && e.code.startsWith('E'));
  const rt = await open();
  await rt.close();
});

test('Symbol.asyncDispose closes', async () => {
  const rt = await open();
  await rt[Symbol.asyncDispose]();
  assert.equal(rt.closed, true);
});

test('LATAI_LIB discovery without an explicit lib', async () => {
  const prev = process.env.LATAI_LIB;
  process.env.LATAI_LIB = h.libFile();
  try {
    const rt = await latai.Runtime.open({ dataDir: data });
    assert.ok(rt.library.apiVersion >= 2);
    await rt.close();
  } finally {
    h.restoreEnv('LATAI_LIB', prev);
  }
});

test('closing the runtime stops a live stream without a hang', async () => {
  // needs a pack: this runtime has none, so the stream is the unknown-pack error; the point is no hang or crash
  const rt = await open();
  const events = [];
  const s = rt.runStream(h.textReq('hi', 4, 'nope'), { raiseOnError: false });
  const it = s[Symbol.asyncIterator]();
  const first = await it.next();
  events.push(first.value);
  await rt.close();
  for (;;) {
    const n = await it.next().catch(() => ({ done: true }));
    if (n.done) break;
    events.push(n.value);
  }
  assert.ok(h.terminals(events.filter(Boolean)).length <= 1);
});
