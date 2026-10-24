// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * Typed errors: `LataiError`, one class per error category (`RequestError` = `E03xx`, ...) and per
 * code (`UnknownPack` = `E0316`, ...), from `schema/errors.json` (`sdk/tools/gen_types.mjs`).
 */
const { LataiError } = require('./errors-base.cjs');
const generated = require('../generated/errors.generated.cjs');

const { CATEGORY_CLASSES, ERROR_CLASSES, ERROR_HINTS, RETRYABLE_CODES } = generated;

/** `liblatai` was not found or could not be loaded. `tried` lists the candidates looked at. */
class LibraryNotFoundError extends LataiError {
  constructor(message, tried = [], hint = '') {
    super('', message, hint || 'Set LATAI_LIB to the path of liblatai (or its folder), or pass lib to Runtime.open.');
    this.tried = [...tried];
  }
}

/** The loaded library is older than the call needs (for example no stream entries: API v1). */
class UnsupportedError extends LataiError {
  constructor(message) {
    super('', message, 'Use a liblatai of API version 2 or later.');
  }
}

/** `316` and `"E0316"` are both `"E0316"`. */
function codeText(code) {
  return typeof code === 'number' ? `E${String(code).padStart(4, '0')}` : code;
}

/**
 * The exception for a wire error `{code, message, hint, details?}` (or a bare code): the class of
 * the code, else of its category, else `LataiError`.
 * @param {object|number|string|null} wire
 * @param {{response?: object|null, events?: object[]}} [extra]
 */
function errorFor(wire, extra = {}) {
  if (wire === null || wire === undefined) wire = {};
  if (typeof wire === 'number' || typeof wire === 'string') wire = { code: codeText(wire) };
  const code = codeText(wire.code || '');
  const Cls = ERROR_CLASSES[code] || CATEGORY_CLASSES[code.slice(0, 3)] || LataiError;
  const message = wire.message || (code ? `latai call failed with ${code}` : 'latai call failed');
  return new Cls(code, message, wire.hint || ERROR_HINTS[code] || '', wire.details ?? null, {
    response: extra.response ?? null,
    events: extra.events ?? [],
    retryable: RETRYABLE_CODES.has(code),
  });
}

module.exports = {
  ...generated,
  LataiError,
  LibraryNotFoundError,
  UnsupportedError,
  codeText,
  errorFor,
};
