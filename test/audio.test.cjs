// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// The audio helpers build the request the CLI builds for the same file (`latai run PACK --audio FILE`,
// bins/latai/src/cli/run.rs): base64 of the file, `format` wav when it starts with RIFF else pcm16.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const latai = require('..');
const h = require('./helpers.cjs');

/** `format` is `wav` when absent (schema): fill the default in before comparing. */
function norm(req) {
  const out = JSON.parse(JSON.stringify(req));
  if (out.inputs && out.inputs.format === undefined) out.inputs.format = 'wav';
  return out;
}

function cliRequest(pack, data, fmt, opts = {}) {
  const f = fmt || (data.subarray(0, 4).toString() === 'RIFF' ? 'wav' : 'pcm16');
  const inputs = { type: 'audio', data: data.toString('base64'), format: f };
  for (const [k, from] of [['sample_rate', 'sampleRate'], ['language', 'language'], ['prompt', 'prompt'], ['prompt_before', 'promptBefore']])
    if (opts[from] !== undefined) inputs[k] = opts[from];
  if (opts.outputs && opts.outputs.length) inputs.outputs = [...opts.outputs];
  return { pack, inputs };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'latai-audio-'));
}

test('a WAV file gives the CLI request', () => {
  const d = tmp();
  try {
    const wav = h.wavFile(h.sinePcm16(0.5));
    const p = path.join(d, 'a.wav');
    fs.writeFileSync(p, wav);
    const want = cliRequest('asr', wav);
    assert.deepEqual(norm(latai.audioRequest('asr', p)), want);
    assert.deepEqual(norm(latai.audioRequest('asr', wav)), want);
    assert.deepEqual(norm(latai.audioRequest('asr', new Uint8Array(wav))), want);
    assert.deepEqual(norm({ inputs: latai.audioInput(p) }).inputs, want.inputs);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('raw pcm16 gives the CLI request', () => {
  const d = tmp();
  try {
    const pcm = h.sinePcm16(0.25);
    const p = path.join(d, 'a.pcm');
    fs.writeFileSync(p, pcm);
    const want = cliRequest('asr', pcm);
    assert.equal(want.inputs.format, 'pcm16');
    assert.deepEqual(latai.audioRequest('asr', p), want);
    assert.deepEqual(latai.audioRequest('asr', pcm, { format: 'pcm16' }), want);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('options are carried like the CLI flags', () => {
  const wav = h.wavFile(h.sinePcm16(0.1));
  const opts = { language: 'en', prompt: 'after', promptBefore: 'before', outputs: ['timestamps', 'language'] };
  assert.deepEqual(norm(latai.audioRequest('asr', wav, opts)), cliRequest('asr', wav, undefined, opts));
  const pcm = h.sinePcm16(0.1);
  assert.deepEqual(latai.audioInput(pcm, { format: 'pcm16', sampleRate: 8000 }), cliRequest('asr', pcm, 'pcm16', { sampleRate: 8000 }).inputs);
  const keys = Object.keys(latai.audioInput(wav)).filter((k) => k !== 'format').sort();
  assert.deepEqual(keys, ['data', 'type']);
});

test('base64 is standard, padded, one line, and decodes back', () => {
  const raw = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
  for (const n of [1, 2, 3, 4, 5, 1000]) {
    const inp = latai.audioInput(raw.subarray(0, n), { format: 'pcm16' });
    assert.ok(Buffer.from(inp.data, 'base64').equals(raw.subarray(0, n)));
    assert.ok(!inp.data.includes('\n'));
  }
});

test('readWav gives the samples and the header fields', () => {
  const pcm = h.sinePcm16(0.2);
  const clip = latai.readWav(h.wavFile(pcm));
  assert.ok(Buffer.from(clip.pcm).equals(pcm));
  assert.equal(clip.sampleRate, 16000);
  assert.equal(clip.channels, 1);
  assert.equal(clip.bits, 16);
  assert.equal(latai.readWav(h.wavFile(pcm, 8000)).sampleRate, 8000);
  assert.throws(() => latai.readWav(h.wavFile(Buffer.concat([pcm, pcm]), 8000, 2)), latai.AudioError);
  assert.throws(() => latai.readWav(Buffer.from('this is not a wav file at all')));
  assert.throws(() => latai.readWav(Buffer.from('RIFF')));
});

test('a missing audio file is an error', () => {
  assert.throws(() => latai.audioInput('/no/such/clip.wav'));
});

test('pcm16Chunks covers the data exactly', () => {
  const data = h.sinePcm16(1);
  const chunks = [...latai.pcm16Chunks(data)];
  assert.ok(Buffer.concat(chunks).equals(data));
  assert.ok(chunks.slice(0, -1).every((c) => c.length === 3200));
  assert.ok(chunks[chunks.length - 1].length > 0 && chunks[chunks.length - 1].length <= 3200);
  const small = [...latai.pcm16Chunks(data, 1001)];
  assert.ok(Buffer.concat(small).equals(data));
  assert.ok(small.every((c) => c.length <= 1001));
  assert.deepEqual([...latai.pcm16Chunks(Buffer.alloc(0))], []);
});

test('textRequest shape', () => {
  assert.deepEqual(latai.textRequest('p', 'hi'), { pack: 'p', inputs: { type: 'text', text: 'hi' } });
  assert.deepEqual(latai.textRequest('p', 'hi', { maxTokens: 8 }).output, { max_tokens: 8 });
  const r = latai.textRequest('p', 'hi', { maxTokens: 8, stop: ['x'] });
  assert.deepEqual(r.output, { max_tokens: 8, stop: ['x'] });
  JSON.stringify(r);
});
