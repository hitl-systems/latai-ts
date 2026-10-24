// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// 14.3.1 generated types: `gen_types.mjs --check` passes on the committed output and fails when the
// schema, the error registry or a generated file changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.cjs');

const GEN = path.join(h.REPO, 'sdk', 'tools', 'gen_types.mjs');
const OUT = path.join(h.SDK, 'generated');
const FILES = ['types.d.ts', 'errors.generated.cjs'];

// The generator and the schema stay in latai; the SDK's public repository has only their output.
if (!fs.existsSync(GEN)) {
  test('the type generator lives in latai', { skip: true }, () => {});
  return;
}

const gen = (args, cwd) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8', cwd, timeout: 120000 });
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'latai-gen-'));

test('--check passes on the committed output, from any directory', () => {
  for (const cwd of [undefined, '/']) {
    const r = gen(['--check'], cwd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('--check does not write', () => {
  const before = FILES.map((f) => sha(path.join(OUT, f)));
  gen(['--check']);
  assert.deepEqual(FILES.map((f) => sha(path.join(OUT, f))), before);
});

test('generation is deterministic and equals the committed files', () => {
  const a = tmp();
  const b = tmp();
  try {
    for (const d of [a, b]) {
      const r = gen(['--out-dir', d]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    for (const f of FILES) {
      assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), f);
      assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(OUT, f))), `${f} is out of date: run sdk/tools/gen_types.mjs`);
    }
    assert.equal(gen(['--check', '--out-dir', a]).status, 0);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('identical copies of the inputs pass', () => {
  const d = tmp();
  try {
    fs.copyFileSync(path.join(h.REPO, 'schema', 'latai.schema.json'), path.join(d, 'schema.json'));
    fs.copyFileSync(path.join(h.REPO, 'schema', 'errors.json'), path.join(d, 'errors.json'));
    const r = gen(['--check', '--schema', path.join(d, 'schema.json'), '--errors', path.join(d, 'errors.json')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const MUTATIONS = {
  'new property': (s) => { s.$defs.Request.properties.zz_new_field = { type: 'string' }; },
  'renamed property': (s) => { const p = s.$defs.Request.properties; p.packx = p.pack; delete p.pack; },
  'new definition': (s) => { s.$defs.BrandNewThing = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }; },
  'removed definition': (s) => { delete s.$defs.Timing; },
};

for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`--check fails when the schema changes: ${name}`, () => {
    const d = tmp();
    try {
      const s = h.schema();
      mutate(s);
      const p = path.join(d, 'schema.json');
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      const r = gen(['--check', '--schema', p]);
      assert.notEqual(r.status, 0, `passed on a changed schema\n${r.stdout}${r.stderr}`);
      assert.ok((r.stdout + r.stderr).length > 0, 'the failure says something');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
}

test('--check fails when the error registry changes (new code, edited hint)', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'errors.json');
    let reg = h.errorsJson();
    reg.errors.push({ code: 'E0999', name: 'TesterInvented', category: 'E09', retryable: false, hint: 'invented by a test', fields: [], details: { type: 'object', properties: {}, additionalProperties: false } });
    fs.writeFileSync(p, JSON.stringify(reg, null, 2));
    assert.notEqual(gen(['--check', '--errors', p]).status, 0);
    reg = h.errorsJson();
    reg.errors[0].hint += ' (edited)';
    fs.writeFileSync(p, JSON.stringify(reg, null, 2));
    assert.notEqual(gen(['--check', '--errors', p]).status, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

for (const victim of FILES) {
  test(`--check fails when ${victim} was edited or removed`, () => {
    const d = tmp();
    try {
      assert.equal(gen(['--out-dir', d]).status, 0);
      const f = path.join(d, victim);
      fs.appendFileSync(f, '\n// hand edit\n');
      assert.notEqual(gen(['--check', '--out-dir', d]).status, 0);
      fs.rmSync(f);
      assert.notEqual(gen(['--check', '--out-dir', d]).status, 0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
}

test('every object definition of the schema has a generated type', () => {
  const text = fs.readFileSync(path.join(OUT, 'types.d.ts'), 'utf8');
  const missing = Object.entries(h.schema().$defs)
    .filter(([n, d]) => /^[A-Za-z_]\w*$/.test(n) && d.type === 'object')
    .filter(([n]) => !new RegExp(`\\b(interface|type)\\s+${n}\\b`).test(text))
    .map(([n]) => n);
  assert.deepEqual(missing, []);
});
