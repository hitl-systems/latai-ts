// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// The TypeScript surface type-checks (`tsc --noEmit`, strict). tsc comes from PATH, LATAI_TSC, or
// `npx --no-install tsc`; when none exists this is an environment limit: it is printed, and the
// tests are skipped (the SDK's .d.ts files are then unchecked).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.cjs');

function findTsc() {
  const candidates = [];
  if (process.env.LATAI_TSC) candidates.push([process.env.LATAI_TSC, []]);
  candidates.push(['tsc', []]);
  candidates.push(['npx', ['--no-install', 'tsc']]);
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0 && /Version\s+\d+/.test(r.stdout)) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}

/** A folder holding `@types/node`: NODE_PATH entries, LATAI_TYPES_DIR, the SDK's own node_modules, `npm root -g`. */
function findTypes() {
  const dirs = [...(process.env.NODE_PATH || '').split(path.delimiter), process.env.LATAI_TYPES_DIR, path.join(h.SDK, 'node_modules')];
  const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 30000 });
  if (g.status === 0) dirs.push(g.stdout.trim());
  return dirs.filter(Boolean).find((d) => fs.existsSync(path.join(d, '@types', 'node'))) || null;
}

const tsc = findTsc();
const typesDir = tsc ? findTypes() : null;
const skip = !tsc
  ? 'tsc is not available in this environment (environment limit; install typescript to check the .d.ts)'
  : !typesDir
    ? '@types/node is not available in this environment (environment limit; set LATAI_TYPES_DIR or NODE_PATH)'
    : false;
if (skip) console.error('NOTICE: ' + skip);

function check(dir, files, extra = []) {
  const cfg = {
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', types: ['node'], skipLibCheck: false, ...Object.fromEntries(extra) },
    files,
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg));
  return spawnSync(tsc.cmd, [...tsc.pre, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8', cwd: dir, timeout: 240000 });
}

function setup(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'latai-tsc-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  // `latai` resolves to the checkout's package; @types/node is found next to the SDK or via NODE_PATH.
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.symlinkSync(h.SDK, path.join(d, 'node_modules', 'latai'), 'dir');
  fs.symlinkSync(path.join(typesDir, '@types'), path.join(d, 'node_modules', '@types'), 'dir');
  return d;
}

test('the declaration files type-check on their own', { skip }, (t) => {
  const d = setup(t);
  const r = check(d, [path.join(h.SDK, 'index.d.ts'), path.join(h.SDK, 'index.d.cts'), path.join(h.SDK, 'index.d.mts')], []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a typical program type-checks', { skip }, (t) => {
  const d = setup(t);
  fs.writeFileSync(path.join(d, 'use.ts'), `
import { Runtime, textRequest, audioRequest, UnknownPack, LataiError, errorFor, type Response, type Event, type StreamEvent } from 'latai';
export async function main(): Promise<string> {
  const rt = await Runtime.open({ dataDir: '/tmp/x' });
  try {
    const resp: Response = await rt.run(textRequest('p', 'hi', { maxTokens: 4 }));
    const finish: string = resp.finish;
    for await (const ev of rt.runStream({ pack: 'p', inputs: { type: 'text', text: 'x' } })) {
      const e: Event = ev;
      if (e.event === 'delta') { const t: string = e.text; void t; }
    }
    const session = await rt.listen({ pack: 'asr' }, { onEvent: (ev: StreamEvent) => { void ev; } });
    const events: StreamEvent[] = await session.push(Buffer.alloc(4));
    void events; await session.close();
    const packs = await rt.listPacks();
    const first: string = packs[0].name;
    void audioRequest('p', Buffer.alloc(1), { language: 'en' });
    try { await rt.inspect('nope'); } catch (e) { if (e instanceof UnknownPack) return e.code + e.hint; if (e instanceof LataiError) return e.category; }
    void errorFor('E0316');
    return finish + first;
  } finally { await rt.close(); }
}
`);
  const r = check(d, ['use.ts']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('misuse is a type error', { skip }, (t) => {
  const d = setup(t);
  fs.writeFileSync(path.join(d, 'bad.ts'), `
import { Runtime } from 'latai';
async function f() {
  const rt = Runtime.open({});            // a promise, not a Runtime
  rt.run({});                              // no runtime on a promise
  const r = await Runtime.open({ dataDir: 5 });  // wrong type
  await r.run(42);                         // not a request
  r.cancel(7);                             // id is a string
}
void f;
`);
  const r = check(d, ['bad.ts']);
  assert.notEqual(r.status, 0, 'a misuse type-checked');
  assert.match(r.stdout, /error TS/);
});
