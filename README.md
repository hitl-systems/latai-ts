# latai (Node.js)

Node binding of the latai C ABI over [koffi](https://koffi.dev) (MIT): promises, async iterators,
TypeScript typings, CommonJS and ES modules. Node 18 or later. Guide: [docs/sdk.md](../../docs/sdk.md).

```text
cd sdk/node && npm install          # fetches koffi; node_modules is ignored by git
```

`liblatai` is found through `LATAI_LIB` (a file or its folder), `LATAI_LIB_DIR`, `Runtime.open({lib})`,
the package folder, a source checkout's `target/debug`, the system folders, or the loader path.
Every call into the library runs on one worker thread per runtime, so the event loop never blocks.

```js
const latai = require('latai');             // import latai, { Runtime } from 'latai'
const rt = await latai.Runtime.open();
await rt.install('x4r-l8.gguf');
console.log((await rt.run(latai.textRequest('x4r-l8', 'hello', { maxTokens: 8 }))).output);
for await (const event of rt.runStream(latai.textRequest('x4r-l8', 'hello'))) { /* ... */ }
await rt.close();
```

## Surface

| Name | What |
|---|---|
| `await Runtime.open({dataDir, bundleDir, lib})` | the runtime; `await rt.close()` |
| `await rt.run(request, {requestId, raiseOnError})` | one response |
| `rt.runStream(request, {requestId, raiseOnError: false})` | `EventStream`: async iterator (errors are events); `close()`, `cancel()`, `final`, `code` |
| `rt.cancel(id)` (sync), `await rt.sessionClose(session)` | |
| `await rt.listen(open, {onEvent, raiseOnError})` | `ListenSession`: `push(bytes)`, `close(flush)`, `cancel()`, `final`, `error`, `transcript` |
| `rt.listenIter(open, chunks)` | async generator of stream events |
| `info`, `status`, `inspect`, `stage`, `pull`, `install`, `activate`, `rollback`, `listPacks`, `pin` | packs |
| `textRequest`, `audioRequest`, `audioInput`, `readWav`, `pcm16Chunks` | request and audio helpers |
| `LataiError` and a class per category / code (`RequestError`, `UnknownPack`, ...) | `.code .hint .details .retryable .response .events` |
| `libraryCandidates`, `findLibrary`, `Library`, `rt.debugCounters()` | the FFI layer |

Types: `index.d.ts` (TypeScript 5), wire types generated into `generated/types.d.ts` by
`node ../tools/gen_types.mjs` (`--check` for drift). Example: [`examples/quickstart.cjs`](examples/quickstart.cjs).
