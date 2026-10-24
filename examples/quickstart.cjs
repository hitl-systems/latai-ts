#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * Install a pack, run it, stream it, cancel a stream, and (with a speech pack) transcribe a stream.
 *
 *     node sdk/node/examples/quickstart.cjs PACK.gguf [SPEECH_PACK.gguf]
 *
 * - `LATAI_DATA_DIR` is the data directory (the pack key list and `latai.toml` live there; see
 *   docs/quickstart.md). A pack is installed only if its signature is from a key in the list.
 * - `LATAI_LIB` points to `liblatai` when it is not found by itself (`libraryCandidates`).
 * - `PACK.gguf.minisig` must sit next to the pack, as for `latai install`.
 * - `koffi` must be installed (`npm install` in sdk/node, or NODE_PATH).
 *
 * The script prints one line per step and `ok` at the end; any failure exits with status 1.
 */
const latai = require('..');

/** A clip of raw 16-bit little-endian samples: silence, a tone, a pause of 1.5 s, a tone, silence. */
function syntheticClip(rate = 16000) {
  const tone = (seconds, hz) =>
    Array.from({ length: Math.floor(seconds * rate) }, (_, i) =>
      Math.floor(8000 * (1 + 0.5 * Math.sin((i / rate) * 17)) * Math.sin((2 * Math.PI * hz * i) / rate)));
  const silence = (seconds) => new Array(Math.floor(seconds * rate)).fill(0);
  const samples = [...silence(0.5), ...tone(2.5, 300), ...silence(1.5), ...tone(2.0, 520), ...silence(1.5)];
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => out.writeInt16LE(s, i * 2));
  return out;
}

async function main(argv) {
  const [packFile, speechFile] = argv;
  if (!packFile) {
    console.log('usage: node quickstart.cjs PACK.gguf [SPEECH_PACK.gguf]');
    return 2;
  }
  // One runtime per process. Close it when done: it stops requests and ends the worker thread.
  const rt = await latai.Runtime.open();
  try {
    // Install: checks the signature, measures the pack in an isolated process, makes it serve.
    const [receipt] = await rt.install(packFile);
    const pack = receipt.name;
    console.log(`installed: ${pack}`);

    // A run: an object in, a response object out. Errors are typed (latai.UnknownPack ...).
    const response = await rt.run(latai.textRequest(pack, 'hello', { maxTokens: 8 }));
    console.log(`run: ${response.output.kind} finish=${response.finish} total_ms=${response.latai.timing.total_ms.toFixed(1)}`);

    try {
      await rt.run(latai.textRequest('no-such-pack', 'hello'));
    } catch (err) {
      if (!(err instanceof latai.UnknownPack)) throw err;
      console.log(`error: ${err.code} ${JSON.stringify(err.details)}`);
    }

    // A stream: deltas, then exactly one final. Here we cancel after five deltas; the run still
    // ends with one final whose finish is "cancelled".
    let deltas = 0;
    const stream = rt.runStream(latai.textRequest(pack, 'hello', { maxTokens: 64 }));
    for await (const event of stream) {
      if (event.event === 'delta' && ++deltas === 5) stream.cancel();
    }
    console.log(`stream: ${deltas} deltas, final ${stream.final.finish}`);

    if (speechFile) {
      const [speech] = await rt.install(speechFile);
      // Audio in chunks of 100 ms, as a microphone would deliver them; the events (partial,
      // committed, utterance, ..., final) come out as they happen.
      const kinds = [];
      for await (const ev of rt.listenIter({ pack: speech.name }, latai.pcm16Chunks(syntheticClip()))) kinds.push(ev.event);
      if (kinds[kinds.length - 1] !== 'final') throw new Error(`no final: ${kinds}`);
      const count = (k) => kinds.filter((x) => x === k).length;
      console.log(`listen: ${kinds.length} events, ${count('utterance')} utterances, ${count('committed')} committed`);
    }
  } finally {
    await rt.close();
  }
  console.log('ok');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
