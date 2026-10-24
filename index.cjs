// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

/**
 * latai: Node binding of the C ABI of `liblatai` (`include/latai.h`) over koffi.
 *
 * Find the library with `LATAI_LIB` (a file or a folder), `LATAI_LIB_DIR`, or
 * `Runtime.open({lib})`; see `libraryCandidates` for the whole search. Quick tour:
 *
 *     const latai = require('latai');
 *     const rt = await latai.Runtime.open();
 *     await rt.install('x4r-l8.gguf');
 *     console.log((await rt.run(latai.textRequest('x4r-l8', 'hello', {maxTokens: 8}))).output);
 *     for await (const ev of rt.runStream(latai.textRequest('x4r-l8', 'hello'))) { ... }
 *     await rt.close();
 *
 * Docs: `docs/sdk.md` and `sdk/README.md` in the repository.
 */
const errors = require('./lib/errors.cjs');
const native = require('./lib/native.cjs');
const audio = require('./lib/audio.cjs');
const runtime = require('./lib/runtime.cjs');

module.exports = {
  ...errors,
  ...audio,
  Runtime: runtime.Runtime,
  EventStream: runtime.EventStream,
  ListenSession: runtime.ListenSession,
  Library: native.Library,
  API_VERSION: native.API_VERSION,
  corePackageDir: native.corePackageDir,
  corePackageName: native.corePackageName,
  findLibrary: native.findLibrary,
  libraryCandidates: native.libraryCandidates,
  libraryFileNames: native.libraryFileNames,
  version: '0.1.0',
};
