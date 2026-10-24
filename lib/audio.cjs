// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * Audio helpers: WAV / raw PCM16 to the `audio` input of a request (docs/request.md#audio).
 *
 * latai takes 16-bit PCM, one channel, at the sample rate the pack declares (16 kHz for the
 * fixture packs) and never resamples (another rate is `E0319`). These helpers do not resample
 * either; they only read, check and wrap the bytes.
 */
const fs = require('node:fs');

/** The bytes are not audio latai takes (before any call is made). */
class AudioError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AudioError';
  }
}

function bytesOf(source) {
  if (typeof source === 'string') return fs.readFileSync(source);
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  throw new AudioError('audio source must be a path, a Buffer, a typed array or an ArrayBuffer');
}

const isWav = (raw) => raw.length >= 12 && raw.toString('latin1', 0, 4) === 'RIFF' && raw.toString('latin1', 8, 12) === 'WAVE';

/**
 * Parse a RIFF/WAVE file (a path or its bytes): 16-bit PCM, one channel (also as
 * `WAVE_FORMAT_EXTENSIBLE` PCM). A data size of 0 or 0xFFFFFFFF (live writers) means until the end.
 * Throws `AudioError` for anything else (the same cases as `E0318`).
 * @returns {{pcm: Buffer, sampleRate: number, channels: number, bits: number, seconds: number}}
 */
function readWav(source) {
  const data = bytesOf(source);
  if (!isWav(data)) throw new AudioError('not a RIFF/WAVE file');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= data.length) {
    const id = data.toString('latin1', pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > data.length) throw new AudioError('truncated fmt chunk');
      let tag = data.readUInt16LE(body);
      if (tag === 0xfffe && size >= 26) tag = data.readUInt16LE(body + 24); // the sub-format starts the GUID
      fmt = { tag, channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new AudioError('data chunk before fmt chunk');
      if (fmt.tag !== 1 || fmt.bits !== 16) throw new AudioError(`only 16-bit PCM is accepted (format tag ${fmt.tag}, ${fmt.bits} bits)`);
      if (fmt.channels !== 1) throw new AudioError(`only one channel is accepted (got ${fmt.channels})`);
      const end = size === 0 || size === 0xffffffff ? data.length : Math.min(body + size, data.length);
      const pcm = data.subarray(body, end);
      if (pcm.length % 2) throw new AudioError('odd number of PCM bytes');
      return { pcm, sampleRate: fmt.rate, channels: fmt.channels, bits: fmt.bits, seconds: fmt.rate ? pcm.length / 2 / fmt.rate : 0 };
    }
    pos = body + size + (size & 1);
  }
  throw new AudioError('no data chunk');
}

/**
 * The `audio` input of a request: `{type: "audio", data: <base64>, ...}`.
 *
 * `source` is a path or bytes. A WAV file is sent whole (`format` `"wav"`, detected from the
 * `RIFF....WAVE` magic); anything else is raw 16-bit little-endian samples (`"pcm16"`) and wants
 * `sampleRate` unless the pack's rate is right. `outputs` is a list of `"timestamps"`,
 * `"language"`, `"embeddings"` (each must be declared by the pack). Clips are limited to 4 MiB of
 * audio and 120 s by the library.
 * @param {string|Buffer|Uint8Array|ArrayBuffer} source
 * @param {{format?: 'wav'|'pcm16', sampleRate?: number, language?: string, prompt?: string, promptBefore?: string, outputs?: string[]}} [options]
 */
function audioInput(source, options = {}) {
  const raw = bytesOf(source);
  const format = options.format || (isWav(raw) ? 'wav' : 'pcm16');
  if (format !== 'wav' && format !== 'pcm16') throw new AudioError(`format must be 'wav' or 'pcm16', not '${format}'`);
  const input = { type: 'audio', data: raw.toString('base64') };
  if (format !== 'wav') input.format = format;
  if (options.sampleRate != null) input.sample_rate = Number(options.sampleRate);
  if (options.language != null) input.language = options.language;
  if (options.prompt != null) input.prompt = options.prompt;
  if (options.promptBefore != null) input.prompt_before = options.promptBefore;
  if (options.outputs && options.outputs.length) input.outputs = [...options.outputs];
  return input;
}

/**
 * A request that transcribes a clip: `{pack, inputs: audioInput(source, ...)}`. The options of
 * `audioInput` go to the input; `output`, `deadline_ms`, `expect_digest`, `session`, `then` go to
 * the request.
 */
function audioRequest(pack, source, options = {}) {
  const { output, deadline_ms, expect_digest, session, then, stream, ...inputOptions } = options;
  const request = { pack, inputs: audioInput(source, inputOptions) };
  for (const [k, v] of Object.entries({ output, deadline_ms, expect_digest, session, then, stream })) {
    if (v !== undefined) request[k] = v;
  }
  return request;
}

/** A request with a `text` input; `maxTokens` and other `output` keys fill `output`. */
function textRequest(pack, text, options = {}) {
  const { maxTokens, session, deadlineMs, ...output } = options;
  const request = { pack, inputs: { type: 'text', text } };
  const out = { ...output };
  if (maxTokens != null) out.max_tokens = maxTokens;
  if (Object.keys(out).length) request.output = out;
  if (session != null) request.session = session;
  if (deadlineMs != null) request.deadline_ms = deadlineMs;
  return request;
}

/**
 * Cut raw samples (bytes or a path) into pieces of `chunkBytes` (3200 = 100 ms at 16 kHz), as a
 * microphone would deliver them, for `ListenSession.push`. A WAV file is not unwrapped here: push
 * its bytes to a stream opened with `format: "wav"`, or give `readWav(path).pcm` to this function.
 * @returns {Generator<Buffer>}
 */
function* pcm16Chunks(source, chunkBytes = 3200) {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1 << 20) throw new RangeError('chunkBytes is 1 to 1048576');
  const raw = bytesOf(source);
  for (let at = 0; at < raw.length; at += chunkBytes) yield raw.subarray(at, at + chunkBytes);
}

module.exports = { AudioError, audioInput, audioRequest, pcm16Chunks, readWav, textRequest };
