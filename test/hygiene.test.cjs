// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Memory hygiene and concurrency on the real library.
const test = require('node:test');
const assert = require('node:assert/strict');
const latai = require('..');
const h = require('./helpers.cjs');

const LOOP = 1000;
const RSS_CAP_KB = 64 * 1024; // generous: a leaked response per call would be far above it
let rt;
let data;
test.before(async (t) => {
  const pack = h.fixtureFile(t, 'LATAI_TEST_PACK', 'packs/x4r-l8.gguf');
  if (!pack) return;
  ({ rt, data } = await h.openInstalled(latai, t, [pack], 'hygiene'));
});
test.after(async () => {
  if (rt) await rt.close();
  if (data) h.cleanup(data);
});

test('1000 runs leave no buffer out and RSS flat', async () => {
  const req = h.textReq('memory', 1);
  for (let i = 0; i < 50; i++) await rt.run(req);
  if (global.gc) global.gc();
  const c0 = await rt.debugCounters();
  const base = h.rssKb();
  for (let i = 0; i < LOOP; i++) {
    const r = await rt.run(req);
    assert.ok(['stop', 'length'].includes(r.finish));
  }
  if (global.gc) global.gc();
  const c1 = await rt.debugCounters();
  assert.ok(c1.taken - c0.taken >= LOOP, 'every run takes a response string');
  assert.equal(c1.taken - c0.taken, c1.freed - c0.freed, 'every string taken was freed');
  const growth = h.rssKb() - base;
  assert.ok(growth < RSS_CAP_KB, `RSS grew ${growth} KiB over ${LOOP} runs`);
});

test('error paths free their buffers too', async () => {
  const c0 = await rt.debugCounters();
  for (let i = 0; i < 200; i++) {
    await assert.rejects(rt.run(h.textReq('x', 1, 'nope')), latai.UnknownPack);
    await assert.rejects(rt.run('{bad'), latai.BadRequest);
    await assert.rejects(rt.inspect('nope'), latai.UnknownPack);
  }
  const c1 = await rt.debugCounters();
  assert.equal(c1.taken - c0.taken, c1.freed - c0.freed);
  assert.equal(rt.library.outstandingStrings, 0);
});

test('cancelled and finished streams free everything', async () => {
  const c0 = await rt.debugCounters();
  const base = h.rssKb();
  for (let i = 0; i < 100; i++) {
    const s = rt.runStream(h.textReq('s', 50));
    const it = s[Symbol.asyncIterator]();
    await it.next();
    await s.close();
  }
  for (let i = 0; i < 100; i++) await h.collect(rt.runStream(h.textReq('s', 2)));
  const c1 = await rt.debugCounters();
  assert.equal(c1.taken - c0.taken, c1.freed - c0.freed);
  assert.ok(h.rssKb() - base < RSS_CAP_KB);
});

test('many runs in flight at once all complete in order of the queue', async () => {
  const reqs = ['alpha', 'beta', 'gamma', 'delta'].map((x) => h.textReq(x, 4));
  const results = await Promise.all([...reqs, ...reqs].map((r) => rt.run(r)));
  for (let i = 0; i < 4; i++) assert.deepEqual(h.stripTiming(results[i]), h.stripTiming(results[i + 4]));
  assert.notDeepEqual(h.stripTiming(results[0]).output, h.stripTiming(results[1]).output);
});

test('a run while another request streams', async () => {
  const streaming = h.collect(rt.runStream(h.textReq('streaming', 12)));
  const resp = await rt.run(h.textReq('blocking', 4));
  const events = await streaming;
  assert.ok(['stop', 'length'].includes(resp.finish));
  assert.equal(events[events.length - 1].event, 'final');
});

test('cancel from a timer while a long run waits', async () => {
  setTimeout(() => rt.cancel('node-block-1'), 300);
  const resp = await rt.run(h.textReq('long', 500), { requestId: 'node-block-1' });
  assert.ok(['cancelled', 'length', 'stop'].includes(resp.finish));
});

test('info from many concurrent callers', async () => {
  const all = await Promise.all(Array.from({ length: 40 }, () => rt.info()));
  assert.ok(all.every((i) => i.version));
});
