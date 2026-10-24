// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Blocking runs, streams and pack management on the real fixture pack, installed through the SDK's own install.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const latai = require('..');
const h = require('./helpers.cjs');

let rt;
let data;
let packFile;
test.before(async (t) => {
  packFile = h.fixtureFile(t, 'LATAI_TEST_PACK', 'packs/x4r-l8.gguf');
  if (!packFile) return;
  ({ rt, data } = await h.openInstalled(latai, t, [packFile], 'run'));
});
test.after(async () => {
  if (rt) await rt.close();
  if (data) h.cleanup(data);
});

const T = h.textReq;
const strip = h.stripTiming;

test('run returns the wire response', async () => {
  const resp = await rt.run(T('hello', 6));
  h.validate(assert, 'Response', resp);
  assert.ok(['stop', 'length'].includes(resp.finish));
  assert.ok(!resp.error);
  const t = resp.latai.timing;
  assert.ok(t.total_ms > 0 && t.prompt_tokens > 0 && t.gen_tokens > 0);
  assert.equal(resp.output.kind, 'text');
  assert.equal(typeof resp.output.text, 'string');
});

test('the response is JSON that round-trips unchanged', async () => {
  const resp = await rt.run(T('round trip', 5));
  assert.deepEqual(JSON.parse(JSON.stringify(resp)), resp);
  h.validate(assert, 'Response', JSON.parse(JSON.stringify(resp)));
});

test('request forms: object, string and bytes give the same answer', async () => {
  const req = T('same', 5);
  const a = await rt.run(req);
  const b = await rt.run(JSON.stringify(req));
  const c = await rt.run(new TextEncoder().encode(JSON.stringify(req)));
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(strip(a), strip(c));
});

test('non-ASCII text', async () => {
  h.validate(assert, 'Response', await rt.run(T('héllo wörld ☃ \u{1F600}', 4)));
});

test('request ids and cancel of unknown ids', async () => {
  h.validate(assert, 'Response', await rt.run(T('id', 3), { requestId: 'node-run-1' }));
  rt.cancel('node-run-1');
  rt.cancel('never-existed');
  await rt.sessionClose('no-such-session');
});

test('an unknown pack rejects with E0316 and the response', async () => {
  await assert.rejects(rt.run(T('x', 2, 'nope')), (e) => {
    assert.ok(e instanceof latai.UnknownPack && e instanceof latai.RequestError);
    assert.equal(e.code, 'E0316');
    assert.ok(e.hint);
    h.validate(assert, 'Response', e.response);
    assert.equal(e.response.finish, 'error');
    assert.equal(e.response.error.code, 'E0316');
    return true;
  });
});

test('raiseOnError false returns the error response', async () => {
  const resp = await rt.run(T('x', 2, 'nope'), { raiseOnError: false });
  h.validate(assert, 'Response', resp);
  assert.equal(resp.finish, 'error');
  assert.equal(resp.error.code, 'E0316');
  assert.ok(resp.error.hint);
});

test('a request that does not parse is E0301 without a response', async () => {
  for (const bad of ['{not json', { pack: h.PACK, inputs: { type: 'text', text: 'x' }, bogus: 1 }]) {
    await assert.rejects(rt.run(bad, { raiseOnError: false }), (e) => {
      assert.ok(e instanceof latai.BadRequest);
      assert.equal(e.code, 'E0301');
      assert.ok(e.hint);
      assert.ok(e.response == null);
      return true;
    });
  }
});

test('audio sent to a text pack is E0315', async () => {
  const req = T('x', 2);
  req.inputs = { type: 'audio', data: 'AAAA' };
  await assert.rejects(rt.run(req), (e) => e instanceof latai.InputInvalid && e.code === 'E0315');
});

test('info and status validate against the schema', async () => {
  h.validate(assert, 'RuntimeInfo', await rt.info());
  const st = await rt.status(h.PACK);
  h.validate(assert, 'Status', st);
  assert.equal(st.pack, h.PACK);
  assert.equal(st.state, 'available');
  h.validate(assert, 'RuntimeInfo', await rt.status());
});

test('runs are greedy and repeatable; max_tokens bounds the output', async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(strip(await rt.run(T('determinism', 6))));
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[0], runs[2]);
  assert.ok((await rt.run(T('bound', 3))).latai.timing.gen_tokens <= 3);
});

// ----------------------------------------------------------------------------- streams

test('events are deltas then exactly one final, matching the blocking run', async () => {
  const req = T('stream me', 8);
  const events = await h.collect(rt.runStream(req));
  const last = events[events.length - 1];
  assert.equal(last.event, 'final');
  assert.equal(h.terminals(events).length, 1);
  const deltas = events.slice(0, -1);
  assert.ok(deltas.length > 0 && deltas.every((e) => e.event === 'delta'));
  assert.ok(deltas.every((d) => typeof d.text === 'string' && d.ms >= 0));
  assert.equal(deltas.map((d) => d.text).join(''), last.response.output.text);
  assert.deepEqual(strip(last.response), strip(await rt.run(req)));
  for (const ev of events) assert.deepEqual(JSON.parse(JSON.stringify(ev)), ev);
});

test('the stream object exposes requestId, final and code', async () => {
  const s = rt.runStream(T('ids', 4), { requestId: 'node-stream-1' });
  assert.equal(s.requestId, 'node-stream-1');
  const events = await h.collect(s);
  assert.deepEqual(s.final, events[events.length - 1].response);
  await s.close();
  await s.close();
  const g = rt.runStream(T('ids', 2));
  try {
    assert.equal(typeof g.requestId, 'string');
    assert.ok(g.requestId.length > 0);
  } finally {
    await g.close();
  }
});

test('breaking out of for-await cancels the run and frees the runtime', async () => {
  let n = 0;
  for await (const ev of rt.runStream(T('context', 400))) {
    void ev;
    if (++n === 2) break;
  }
  assert.equal(n, 2);
  assert.ok(['stop', 'length'].includes((await rt.run(T('ok', 2))).finish));
});

test('close() cancels the run; the next request runs', async () => {
  const s = rt.runStream(T('a long answer', 400));
  const it = s[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.event, 'delta');
  await s.close();
  assert.ok(['stop', 'length'].includes((await rt.run(T('after cancel', 3))).finish));
  if (s.final) assert.equal(s.final.finish, 'cancelled');
});

test('cancel by request id ends with finish cancelled', async () => {
  const s = rt.runStream(T('cancel by id', 400), { requestId: 'node-cancel-1' });
  const it = s[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.event, 'delta');
  rt.cancel('node-cancel-1');
  const rest = [];
  for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
  assert.equal(rest[rest.length - 1].event, 'final');
  assert.equal(rest[rest.length - 1].response.finish, 'cancelled');
  assert.equal(h.terminals(rest).length, 1);
});

test('stream.cancel() ends with finish cancelled', async () => {
  const s = rt.runStream(T('cancel method', 400));
  const it = s[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.event, 'delta');
  s.cancel();
  const rest = [];
  for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
  assert.equal(rest[rest.length - 1].response.finish, 'cancelled');
});

test('a slow consumer loses no event', async () => {
  const req = T('backpressure', 10);
  const want = await h.collect(rt.runStream(req));
  const got = [];
  for await (const ev of rt.runStream(req)) {
    await new Promise((r) => setTimeout(r, 5));
    got.push(ev);
  }
  assert.deepEqual(got.map((e) => e.event), want.map((e) => e.event));
  assert.deepEqual(got.slice(0, -1).map((e) => e.text), want.slice(0, -1).map((e) => e.text));
});

test('an unknown pack streams one terminal event and does not throw', async () => {
  const quiet = await h.collect(rt.runStream(T('x', 2, 'nope')));
  assert.equal(h.terminals(quiet).length, 1);
  const last = quiet[quiet.length - 1];
  const err = last.event === 'error' ? last.error : last.response.error;
  assert.equal(err.code, 'E0316');
  assert.ok(err.hint);
});

test('raiseOnError true rejects after the terminal event', async () => {
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const ev of rt.runStream(T('x', 2, 'nope'), { raiseOnError: true })) seen.push(ev);
    })(),
    (e) => e instanceof latai.UnknownPack && e.code === 'E0316',
  );
  assert.equal(h.terminals(seen).length, 1);
});

test('bad JSON is one error event E0301, raised only on request', async () => {
  const seen = await h.collect(rt.runStream('{not json'));
  assert.deepEqual(seen.map((e) => e.event), ['error']);
  assert.equal(seen[0].error.code, 'E0301');
  await assert.rejects(h.collect(rt.runStream('{not json', { raiseOnError: true })), (e) => e instanceof latai.BadRequest);
});

test('many short streams each have one terminal', async () => {
  for (let i = 0; i < 15; i++) {
    const events = await h.collect(rt.runStream(T(`n${i}`, 2)));
    assert.equal(h.terminals(events).length, 1);
    assert.equal(events[events.length - 1].event, 'final');
  }
});

// ----------------------------------------------------------------------------- pack management

test('the installed pack is active and listed', async () => {
  const versions = await rt.listPacks();
  assert.ok(Array.isArray(versions) && versions.length > 0);
  for (const v of versions) h.validate(assert, 'PackVersion', v);
  const mine = versions.filter((v) => v.name === h.PACK);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'active');
});

test('inspect by name and by file; unknown is E0316', async () => {
  h.validate(assert, 'PackInfo', await rt.inspect(h.PACK));
  h.validate(assert, 'PackInfo', await rt.inspect(packFile));
  await assert.rejects(rt.inspect('no-such-pack'), (e) => e instanceof latai.UnknownPack && e.code === "E0316" && Boolean(e.hint));
});

test('activate with nothing waiting and for an unknown pack is E0316', async () => {
  await assert.rejects(rt.activate(h.PACK), (e) => e.code === "E0316" && Boolean(e.hint));
  await assert.rejects(rt.activate('no-such-pack'), (e) => e.code === 'E0316');
});

test('rollback without a retained version is E0803', async () => {
  await assert.rejects(rt.rollback(h.PACK), (e) => {
    assert.ok(e instanceof latai.NoRollbackTarget && e instanceof latai.LifecycleError);
    assert.equal(e.code, 'E0803');
    assert.ok(e.hint);
    return true;
  });
});

test('pin and clear', async () => {
  assert.equal(await rt.pin(h.PACK, 'channel:dev'), 'channel:dev');
  assert.ok((await rt.listPacks()).some((v) => v.name === h.PACK && v.pin === 'channel:dev'));
  assert.equal(await rt.pin(h.PACK), null);
  assert.equal(await rt.pin(h.PACK, null), null);
});

test('pull with an http or other scheme is E0801 (cause scheme)', async () => {
  await assert.rejects(rt.pull('http://127.0.0.1:9/pack.gguf'), (e) => {
    assert.ok(e instanceof latai.PullFailed && e instanceof latai.LifecycleError);
    assert.equal(e.code, 'E0801');
    assert.equal(e.details && e.details.cause, 'scheme');
    assert.ok(e.hint);
    return true;
  });
  await assert.rejects(rt.pull('ftp://example.invalid/pack.gguf', true), (e) => e instanceof latai.PullFailed);
});

test('stage of a missing file and of a bogus file are typed errors', async () => {
  await assert.rejects(rt.stage('/no/such/missing.gguf'), (e) => e instanceof latai.LataiError && e.code.startsWith("E") && Boolean(e.hint));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'latai-bogus-'));
  try {
    const bogus = path.join(d, 'bogus.gguf');
    fs.writeFileSync(bogus, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(64)]));
    fs.writeFileSync(bogus + '.minisig', 'untrusted comment: x\nAAAA\n');
    await assert.rejects(rt.stage(bogus), (e) => ['E0101', 'E0102', 'E0401', 'E0103'].includes(e.code));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('install again without activating, and stage, give receipts', async () => {
  const receipts = await rt.install(packFile, false);
  assert.equal(receipts.length, 1);
  h.validate(assert, 'StageReceipt', receipts[0]);
  const r = await rt.stage(packFile);
  h.validate(assert, 'StageReceipt', r);
  assert.equal(r.name, h.PACK);
  assert.equal((await rt.listPacks()).filter((v) => v.name === h.PACK && v.state === 'active').length, 1);
});
