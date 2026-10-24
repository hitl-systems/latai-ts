// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * The base class of every error latai throws (the per-category and per-code subclasses are in
 * `generated/errors.generated.cjs`).
 *
 * Fields: `code` (`"E0316"`; empty for errors that did not come from the library), `message`,
 * `hint`, `details` (the typed fields of the code, or `null`), `retryable`, `category`
 * (`"E03"`), `response` (the whole response of a run that ended `finish: "error"`, else
 * `null`), `events` (what a failed stream call delivered, else `[]`).
 */
class LataiError extends Error {
  /**
   * @param {string|null} [code]
   * @param {string} [message]
   * @param {string} [hint]
   * @param {object|null} [details]
   * @param {{response?: object|null, events?: object[], retryable?: boolean}} [extra]
   */
  constructor(code, message, hint, details, extra) {
    const c = code ?? new.target.defaultCode ?? '';
    const head = c ? `${c}: ${message ?? ''}` : String(message ?? '');
    super(hint ? `${head} (hint: ${hint})` : head);
    this.name = new.target.name;
    this.code = c;
    this.rawMessage = message ?? '';
    this.hint = hint ?? '';
    this.details = details ?? null;
    this.retryable = extra?.retryable ?? new.target.retryable ?? false;
    this.category = new.target.category ?? '';
    this.response = extra?.response ?? null;
    this.events = extra?.events ? [...extra.events] : [];
  }

  /** The wire form: `{code, message, hint, details?}`. */
  toWire() {
    const out = { code: this.code, message: this.rawMessage, hint: this.hint };
    if (this.details !== null) out.details = this.details;
    return out;
  }
}
LataiError.defaultCode = '';
LataiError.category = '';
LataiError.retryable = false;

module.exports = { LataiError };
