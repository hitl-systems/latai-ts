// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Stream sessions (open / push / close) and clip runs on the speech stand-in pack.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const latai = require('..');
const h = require('./helpers.cjs');

const OPEN = { pack: h.SPEECH, hop_ms: 1000, pause_ms: 0, window_seconds: 3 };
let rt;
let data;
let pcm;
let textPack;
test.before(async (t) => {
  const speech = h.fixtureFile(t, 'LATAI_TEST_SPEECH_PACK', 'speech-packs/speech-qwen2a.gguf');
  textPack = h.fixtureFile(t, 'LATAI_TEST_PACK', 'packs/x4r-l8.gguf');
  const parts = ['sine', 'chirp', 'noise', 'chirp'].map((n) => h.speechClipPcm16(t, n));
  if (!speech || !textPack || parts.some((p) => !p)) return;
  pcm = Buffer.concat(parts);
  ({ rt, data } = await h.openInstalled(latai, t, [speech], 'listen'));
});
test.after(async () => {
  if (rt) await rt.close();
  if (data) h.cleanup(data);
});

const chunks = (buf, n = 3200) => {
  const out = [];
  for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n));
  return out;
};
const stripped = (events) =>
  events.map((e) => {
    const c = JSON.parse(JSON.stringify(e));
    if (c.event === 'final') {
      c.response.latai.timing = 0;
      c.response.latai.stream.buffered_samples_peak = 0;
    }
    return c;
  });

function checkRules(events, pcmLen) {
  assert.ok(events.length > 0, 'no events');
  assert.equal(h.terminals(events).length, 1, events.map((e) => e.event).join());
  assert.equal(events[events.length - 1].event, 'final');
  let lastAt = 0;
  for (const e of events.slice(0, -1)) {
    assert.ok(['partial', 'committed', 'utterance', 'then'].includes(e.event), e.event);
    if (e.event === 'partial' || e.event === 'committed') {
      assert.ok(e.at_ms >= lastAt, 'at_ms never goes back');
      lastAt = e.at_ms;
    }
  }
  const final = events[events.length - 1].response;
  h.validate(assert, 'Response', final);
  assert.equal(final.output.kind, 'transcript');
  if (pcmLen !== undefined) {
    assert.equal(final.latai.stream.bytes, pcmLen);
    assert.equal(final.latai.stream.audio_ms, Math.floor(pcmLen / 2 * 1000 / 16000));
  }
  return final;
}

async function runSession(opts = {}, chunkSize = 3200, onEvent) {
  const s = await rt.listen({ ...OPEN, ...opts }, onEvent ? { onEvent } : undefined);
  const events = [];
  for (const c of chunks(pcm, chunkSize)) events.push(...(await s.push(c)));
  events.push(...(await s.close()));
  return { s, events };
}

test('clip runs from a WAV file and from raw pcm agree', async () => {
  const d = path.dirname(data);
  const wav = path.join(d, 'clip.wav');
  const raw = path.join(d, 'clip.pcm');
  fs.writeFileSync(wav, h.wavFile(pcm));
  fs.writeFileSync(raw, pcm);
  const a = await rt.run(latai.audioRequest(h.SPEECH, wav));
  const b = await rt.run(latai.audioRequest(h.SPEECH, raw));
  h.validate(assert, 'Response', a);
  assert.equal(a.output.kind, 'transcript');
  assert.deepEqual(a.output, b.output);
});

test('an undeclared output is E0315', async () => {
  const wav = h.wavFile(pcm.subarray(0, 64000));
  for (const name of ['timestamps', 'language', 'embeddings'])
    await assert.rejects(rt.run(latai.audioRequest(h.SPEECH, wav, { outputs: [name] })), (e) => e instanceof latai.InputInvalid && e.code === 'E0315' && e.message.includes(name));
});

test('session events follow the rules', async () => {
  const { s, events } = await runSession();
  const final = checkRules(events, pcm.length);
  assert.equal(final.finish, 'stop');
  assert.equal(s.ended, true);
  assert.deepEqual(s.final, final);
  assert.equal(s.transcript, final.output.text);
  assert.ok(final.latai.stream.passes >= 4);
});

test('the same events whatever the chunk size', async () => {
  const a = await runSession({}, 3200);
  const b = await runSession({}, 16000);
  const c = await runSession({}, 1001);
  assert.deepEqual(stripped(a.events), stripped(b.events));
  assert.deepEqual(stripped(a.events), stripped(c.events));
});

test('listenIter yields the same events', async () => {
  const manual = await runSession();
  const got = [];
  for await (const ev of rt.listenIter({ ...OPEN }, latai.pcm16Chunks(pcm))) got.push(ev);
  assert.deepEqual(stripped(got), stripped(manual.events));
});

test('listen accepts a pack name as the open request', async () => {
  const s = await rt.listen(h.SPEECH);
  const events = await s.close();
  assert.ok(Array.isArray(events));
});

test('wav format stream', async () => {
  const wav = h.wavFile(pcm);
  const s = await rt.listen({ ...OPEN, format: 'wav' });
  const events = [];
  for (const c of chunks(wav)) events.push(...(await s.push(c)));
  events.push(...(await s.close()));
  assert.equal(checkRules(events).finish, 'stop');
});

test('onEvent sees every event once, the final last', async () => {
  const seen = [];
  const { events } = await runSession({}, 3200, (ev) => {
    seen.push(ev);
  });
  assert.deepEqual(seen, events);
  assert.equal(h.terminals(seen).length, 1);
});

test('onEvent returning true ends the stream cancelled; a later push is E0320', async () => {
  const seen = [];
  const s = await rt.listen({ ...OPEN }, { onEvent: (ev) => { seen.push(ev.event); return true; } });
  for (const c of chunks(pcm)) {
    try {
      await s.push(c);
    } catch (e) {
      assert.ok(e instanceof latai.StreamState);
      break;
    }
    if (s.ended) break;
  }
  assert.ok(s.final && s.final.finish === 'cancelled');
  assert.equal(seen.filter((e) => e === 'final').length, 1);
  await assert.rejects(s.push(pcm.subarray(0, 3200)), (e) => e instanceof latai.StreamState && e.code === 'E0320');
  await s.close().catch(() => {});
});

test('an exception in onEvent does not crash the process', async () => {
  const s = await rt.listen({ ...OPEN }, { onEvent: () => { throw new Error('boom'); } });
  try {
    for (const c of chunks(pcm)) await s.push(c);
    await s.close();
  } catch (e) {
    assert.ok(e instanceof Error);
  }
  assert.ok((await rt.info()).version);
  await s.close().catch(() => {});
});

test('close(false) abandons: one cancelled final', async () => {
  const s = await rt.listen({ ...OPEN });
  await s.push(pcm.subarray(0, 32000));
  const events = await s.close(false);
  assert.equal(events[events.length - 1].event, 'final');
  assert.equal(events[events.length - 1].response.finish, 'cancelled');
  assert.equal(h.terminals(events).length, 1);
});

test('cancel() then the next call delivers the final', async () => {
  const s = await rt.listen({ ...OPEN });
  await s.push(pcm.subarray(0, 32000));
  s.cancel();
  try { await s.push(pcm.subarray(32000, 64000)); } catch (e) { assert.ok(e instanceof latai.StreamState); }
  await s.close().catch(() => {});
  assert.ok(s.final && s.final.finish === 'cancelled');
});

test('use after close is E0320 and a second close is harmless', async () => {
  const s = await rt.listen({ ...OPEN });
  await s.close();
  assert.equal(s.closed, true);
  await assert.rejects(s.push(pcm.subarray(0, 3200)), (e) => e instanceof latai.StreamState && e.code === 'E0320' && Boolean(e.hint));
  s.cancel();
  assert.deepEqual(await s.close(), []);
});

test('Symbol.asyncDispose ends the session', async () => {
  const s = await rt.listen({ ...OPEN });
  await s.push(pcm.subarray(0, 32000));
  await s[Symbol.asyncDispose]();
  assert.equal(s.ended, true);
});

test('open errors are typed', async () => {
  await assert.rejects(rt.listen({ pack: 'nope' }), (e) => e instanceof latai.UnknownPack && e.code === 'E0316');
  await assert.rejects(rt.listen({ ...OPEN, hop_ms: 5 }), (e) => e instanceof latai.InputInvalid);
  await assert.rejects(rt.listen('{not json'), (e) => e instanceof latai.BadRequest);
});

test('an odd byte at the end is an error final, not an exception', async () => {
  const s = await rt.listen({ ...OPEN });
  await s.push(pcm.subarray(0, 3201));
  const events = await s.close();
  const last = events[events.length - 1];
  assert.equal(last.event, 'final');
  assert.equal(last.response.finish, 'error');
  assert.equal(last.response.error.code, 'E0318');
  assert.equal(h.terminals(events).length, 1);
  assert.ok(s.ended);
  assert.equal(s.error.code, 'E0318');
});

test('raiseOnError true rejects with the typed error and the events', async () => {
  const s = await rt.listen({ ...OPEN }, { raiseOnError: true });
  await s.push(pcm.subarray(0, 3201));
  await assert.rejects(s.close(), (e) => e instanceof latai.AudioInvalid && e.code === 'E0318' && e.events.length > 0);
});

test('a push above 1 MiB is split, not refused', async () => {
  const s = await rt.listen({ ...OPEN });
  assert.deepEqual(await s.push(Buffer.alloc(1024 * 1024 + 2)), []);
  const events = await s.close(false);
  assert.equal(events[events.length - 1].response.latai.stream.bytes, 1024 * 1024 + 2);
});

test('two streams at once give the same events', async () => {
  const a = await rt.listen({ ...OPEN });
  const b = await rt.listen({ ...OPEN });
  const ea = [];
  const eb = [];
  for (const c of chunks(pcm.subarray(0, 64000))) {
    ea.push(...(await a.push(c)));
    eb.push(...(await b.push(c)));
  }
  ea.push(...(await a.close()));
  eb.push(...(await b.close()));
  assert.deepEqual(stripped(ea), stripped(eb));
});

test('audio to a text pack is E0315', async () => {
  await rt.install(textPack);
  await assert.rejects(rt.run(latai.audioRequest(h.PACK, h.wavFile(Buffer.alloc(3200)))), (e) => e instanceof latai.InputInvalid);
  await assert.rejects(rt.listen({ pack: h.PACK }), (e) => e instanceof latai.InputInvalid);
});

test('closing the runtime ends live sessions (last test of the file)', async () => {
  const s = await rt.listen({ ...OPEN });
  await s.push(pcm.subarray(0, 32000));
  await rt.close();
  assert.equal(rt.closed, true);
  assert.equal(s.ended, true);
  await assert.rejects(s.push(pcm.subarray(0, 3200)), (e) => e instanceof latai.LataiError);
});
