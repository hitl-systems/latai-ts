// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Library discovery: pure functions (no filesystem) plus the real loader paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const latai = require('..');
const h = require('./helpers.cjs');

test('file names per platform', () => {
  assert.deepEqual(latai.libraryFileNames('linux'), ['liblatai.so']);
  assert.deepEqual(latai.libraryFileNames('darwin'), ['liblatai.dylib']);
  const win = latai.libraryFileNames('win32');
  assert.equal(win[0], 'latai.dll');
  assert.ok(win.includes('liblatai.dll'));
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`candidates order on ${platform}: explicit, LATAI_LIB, LATAI_LIB_DIR, package`, () => {
    const win = platform === 'win32';
    const explicit = win ? 'C:\\opt\\x\\explicit.dll' : '/opt/x/explicit';
    const libEnv = win ? 'D:\\env\\lib' : '/env/lib';
    const dirEnv = win ? 'D:\\env\\dir' : '/env/dir';
    const c = latai.libraryCandidates(explicit, {
      environ: { LATAI_LIB: libEnv, LATAI_LIB_DIR: dirEnv },
      platform,
      packageDir: '/pkg/latai',
    });
    assert.ok(Array.isArray(c) && c.every((x) => typeof x === 'string'));
    assert.equal(new Set(c).size, c.length, 'no duplicates');
    const first = (prefix) => {
      const i = c.findIndex((x) => x.startsWith(prefix));
      assert.ok(i >= 0, `no candidate starts with ${prefix}: ${c}`);
      return i;
    };
    assert.equal(c[0], explicit);
    assert.ok(first(explicit) < first(libEnv));
    assert.ok(first(libEnv) < first(dirEnv));
    assert.ok(first(dirEnv) < first('/pkg/latai'));
    const names = latai.libraryFileNames(platform);
    assert.ok(c.some((x) => x.startsWith(dirEnv) && names.some((n) => x.endsWith(n))), String(c));
    const last = c[c.length - 1];
    assert.ok(names.some((n) => last === n || last.endsWith(n)));
  });
}

test('candidates without environment have no env entries and read nothing', () => {
  const prev = process.env.LATAI_LIB;
  process.env.LATAI_LIB = '/should/not/appear/anywhere';
  try {
    const c = latai.libraryCandidates(null, { environ: {}, platform: 'linux', packageDir: '/p/latai' });
    assert.ok(c.length > 0);
    assert.ok(!c.some((x) => x.includes('should/not/appear')));
    assert.ok(c.includes('liblatai.so'), 'the bare name for the loader');
    const m = latai.libraryCandidates('/no/such/dir/liblatai.so', { environ: {}, platform: 'linux', packageDir: '/p' });
    assert.equal(m[0], '/no/such/dir/liblatai.so');
  } finally {
    h.restoreEnv('LATAI_LIB', prev);
  }
});

test('Windows paths keep the drive and the backslashes, never the Unix names', () => {
  const c = latai.libraryCandidates('C:\\Program Files\\latai\\latai.dll', {
    environ: {},
    platform: 'win32',
    packageDir: 'C:\\py\\latai',
  });
  assert.equal(c[0], 'C:\\Program Files\\latai\\latai.dll');
  assert.ok(c.some((x) => x.startsWith('C:\\py\\latai')));
  assert.ok(!c.some((x) => x.endsWith('liblatai.so')));
});

test('macOS names are dylib, never so', () => {
  const c = latai.libraryCandidates(null, { environ: { LATAI_LIB_DIR: '/Users/me/latai/lib' }, platform: 'darwin', packageDir: '/p' });
  assert.ok(c.some((x) => x.endsWith('liblatai.dylib')));
  assert.ok(!c.some((x) => x.endsWith('liblatai.so')));
  assert.ok(c.some((x) => x.startsWith('/Users/me/latai/lib')));
});

test('findLibrary: explicit file, LATAI_LIB file and folder, LATAI_LIB_DIR', () => {
  const real = h.libFile();
  assert.equal(fs.realpathSync(latai.findLibrary(real, { environ: {} })), fs.realpathSync(real));
  assert.equal(fs.realpathSync(latai.findLibrary(null, { environ: { LATAI_LIB: real } })), fs.realpathSync(real));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'latai-disc-'));
  try {
    fs.copyFileSync(real, path.join(d, path.basename(real)));
    for (const environ of [{ LATAI_LIB_DIR: d }, { LATAI_LIB: d }]) {
      const got = latai.findLibrary(null, { environ });
      assert.equal(fs.realpathSync(got), fs.realpathSync(path.join(d, path.basename(real))));
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a missing library is a clear typed error (package copied away from the checkout, clean environment)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latai-iso-'));
  try {
    const dst = path.join(root, 'a', 'b', 'site', 'latai');
    fs.cpSync(h.SDK, dst, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}test`) });
    const nope = path.join(root, 'nope', 'liblatai.so');
    const code = `
      const latai = require(process.argv[1]);
      try { latai.findLibrary(process.argv[2], { environ: { LATAI_LIB_DIR: process.argv[3] } }); console.log('FOUND'); }
      catch (e) {
        if (!(e instanceof latai.LibraryNotFoundError) || !(e instanceof latai.LataiError) || e.code !== '') throw e;
        console.log(JSON.stringify({ tried: e.tried, text: String(e.message) }));
      }`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LATAI_|LD_LIBRARY|DYLD_)/.test(k)));
    const r = spawnSync(process.execPath, ['-e', code, dst, nope, path.join(root, 'empty')], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(r.stdout.trim(), 'FOUND', 'a library was found where none should be');
    const got = JSON.parse(r.stdout);
    assert.ok(got.tried.length > 0);
    assert.equal(got.tried[0], nope);
    assert.match(got.text, /LATAI_LIB/);
    assert.ok(got.text.includes(nope));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Library() on a file that is not a library is a typed error, not a crash', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'latai-bogus-'));
  try {
    const bogus = path.join(d, 'liblatai.so');
    fs.writeFileSync(bogus, 'not an elf');
    assert.throws(() => new latai.Library(bogus), (e) => e instanceof latai.LataiError);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('explicit path wins over the environment; LATAI_LIB is used by default', () => {
  const real = h.libFile();
  const prev = process.env.LATAI_LIB;
  process.env.LATAI_LIB = '/nonexistent/wrong.so';
  try {
    const lib = new latai.Library(real);
    assert.ok(lib.apiVersion >= 2 && lib.hasStreams);
  } finally {
    h.restoreEnv('LATAI_LIB', prev);
  }
  process.env.LATAI_LIB = real;
  try {
    const lib = new latai.Library();
    assert.ok(lib.apiVersion >= 2);
  } finally {
    h.restoreEnv('LATAI_LIB', prev);
  }
});

test('the core package of the platform comes after the environment and before the package', () => {
  const c = latai.libraryCandidates(null, {
    environ: { LATAI_LIB_DIR: '/env/dir' },
    platform: 'linux',
    packageDir: '/p/latai',
    coreDir: '/p/node_modules/@latai/core-linux-x64/core',
  });
  const at = (prefix) => c.findIndex((x) => x.startsWith(prefix));
  assert.ok(at('/env/dir') < at('/p/node_modules/@latai/core-linux-x64/core'));
  assert.ok(at('/p/node_modules/@latai/core-linux-x64/core') < at('/p/latai'));
});
