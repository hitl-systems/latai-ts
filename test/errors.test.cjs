// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Every code of schema/errors.json maps to an error class with .code, .hint, .details.
const test = require('node:test');
const assert = require('node:assert/strict');
const latai = require('..');
const h = require('./helpers.cjs');

const ERRORS = h.errorsJson().errors;
const BASES = { E01: 'PackError', E02: 'CompatError', E03: 'RequestError', E04: 'TrustError', E05: 'EngineError', E06: 'AccessError', E07: 'BusyError', E08: 'LifecycleError', E09: 'InternalError' };

test('the table covers every code', () => {
  for (const e of ERRORS) assert.ok(e.code in latai.ERROR_CLASSES, e.code);
  assert.ok(ERRORS.length >= 44);
});

for (const entry of ERRORS) {
  test(`${entry.code} ${entry.name}`, () => {
    const cls = latai.ERROR_CLASSES[entry.code];
    assert.equal(cls.name, entry.name);
    assert.equal(latai[entry.name], cls);
    const base = latai[BASES[entry.category]];
    assert.ok(cls.prototype instanceof base);
    assert.ok(base.prototype instanceof latai.LataiError);
    assert.ok(cls.prototype instanceof Error);

    const err = latai.errorFor({ code: entry.code, message: 'm of ' + entry.code, hint: 'h of ' + entry.code });
    assert.equal(err.constructor, cls);
    assert.equal(err.code, entry.code);
    assert.equal(err.rawMessage, 'm of ' + entry.code);
    assert.equal(err.hint, 'h of ' + entry.code);
    assert.ok(err.details === null || err.details === undefined || Object.keys(err.details).length === 0);
    assert.equal(err.category, entry.category);
    assert.equal(err.retryable, entry.retryable);
    assert.ok(err.message.includes(entry.code));
    assert.ok(err.message.includes('h of ' + entry.code), 'the message carries the hint');

    const d = { x: 1 };
    assert.deepEqual(latai.errorFor({ code: entry.code, message: 'm', hint: 'h', details: d }).details, d);

    // from the bare code the hint comes from the registry and is never empty
    const bare = latai.errorFor(entry.code);
    assert.equal(bare.constructor, cls);
    assert.ok(bare.hint && bare.hint.trim(), 'a bare error has a hint');
    assert.equal(bare.hint, entry.hint);
  });
}

test('an unknown code is a plain LataiError that keeps the code', () => {
  const e = latai.errorFor({ code: 'E9999', message: 'future', hint: 'update the sdk' });
  assert.equal(e.constructor, latai.LataiError);
  assert.equal(e.code, 'E9999');
  assert.equal(e.hint, 'update the sdk');
});

test('a numeric ABI code is turned into its text', () => {
  assert.equal(latai.codeText(316), 'E0316');
  assert.equal(latai.errorFor(316).constructor, latai.UnknownPack);
});

test('catch by category and by code', () => {
  const e = latai.errorFor('E0316');
  assert.ok(e instanceof latai.RequestError && e instanceof latai.UnknownPack && e instanceof latai.LataiError);
  assert.ok(!(e instanceof latai.BusyError));
  assert.ok(latai.errorFor('E0701') instanceof latai.BusyError);
});

test('LibraryNotFoundError is not a wire code', () => {
  assert.ok(!('' in latai.ERROR_CLASSES));
  assert.ok(new latai.LibraryNotFoundError('x', ['a']) instanceof latai.LataiError);
});
