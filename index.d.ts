// SPDX-License-Identifier: Apache-2.0 OR MIT
// Typings of the latai Node SDK. The wire types are generated (generated/types.d.ts).

import type * as W from './generated/types';

export type * from './generated/types';
export * from './generated/errors.generated';

/** A request: an object, JSON text, or UTF-8 bytes. */
export type RequestInput = W.Request | string | Uint8Array;
export type Bytes = Uint8Array | ArrayBuffer;
export type Environ = Record<string, string | undefined>;

export declare const API_VERSION: 2;
export declare const version: string;

// -- errors ------------------------------------------------------------------------------------

/** The base of every error latai throws. */
export declare class LataiError extends Error {
  constructor(
    code?: string | null,
    message?: string,
    hint?: string,
    details?: Record<string, unknown> | null,
    extra?: { response?: W.Response | null; events?: object[]; retryable?: boolean },
  );
  /** The stable code (`"E0316"`); empty for errors that did not come from the library. */
  code: string;
  /** The message without the code and the hint (`message` has both). */
  rawMessage: string;
  hint: string;
  details: Record<string, unknown> | null;
  retryable: boolean;
  /** `"E03"` for a request error. */
  category: string;
  /** The whole response of a run that ended `finish: "error"`. */
  response: W.Response | null;
  /** What a failed stream call delivered. */
  events: W.StreamEvent[];
  toWire(): W.Error;
  static defaultCode: string;
  static category: string;
  static retryable: boolean;
}
export declare class LibraryNotFoundError extends LataiError {
  constructor(message: string, tried?: string[], hint?: string);
  tried: string[];
}
export declare class UnsupportedError extends LataiError {
  constructor(message: string);
}
export declare function codeText(code: number | string): string;
export declare function errorFor(
  wire: Partial<W.Error> | number | string | null | undefined,
  extra?: { response?: W.Response | null; events?: object[] },
): LataiError;

// -- finding the library -----------------------------------------------------------------------

export declare function libraryFileNames(platform?: string): string[];
export declare function libraryCandidates(
  explicit?: string | null,
  options?: { environ?: Environ; platform?: string; packageDir?: string; coreDir?: string | null },
): string[];
export declare function findLibrary(
  explicit?: string | null,
  options?: { environ?: Environ; platform?: string; packageDir?: string; coreDir?: string | null },
): string;
/** The npm package that carries the core of a platform (`@latai/core-linux-x64`, ...). */
export declare function corePackageName(platform?: string, arch?: string): string;
/** The `core/` folder of the installed core package of this platform, or null. */
export declare function corePackageDir(): string | null;

/** A loaded `liblatai` (synchronous, any thread). Most programs use `Runtime` and never see it. */
export declare class Library {
  constructor(path?: string | null);
  readonly path: string;
  readonly apiVersion: number;
  readonly hasStreams: boolean;
  readonly outstandingStrings: number;
  counters(): { taken: number; freed: number };
  lastError(): W.Error | null;
}

// -- running -----------------------------------------------------------------------------------

export interface RunOptions {
  /** Names the request for `cancel`. */
  requestId?: string;
  /** `run`: reject when the response ended `finish: "error"` (default true); else return it.
   *  `runStream`: also reject, after the terminal event, when it failed (default false: errors are events). */
  raiseOnError?: boolean;
}

/** The events of one `runStream` call: `delta`..., then one `final` or `error`. */
export declare class EventStream implements AsyncIterableIterator<W.Event> {
  readonly requestId: string;
  /** The response of the `final` event once it was read. */
  final: W.Response | null;
  /** The return code of the C call once the stream is done. */
  code: number | null;
  [Symbol.asyncIterator](): this;
  next(): Promise<IteratorResult<W.Event, undefined>>;
  return(): Promise<IteratorResult<W.Event, undefined>>;
  /** Ask the library to cancel the request; the stream ends with a `cancelled` `final`. */
  cancel(): void;
  /** Stop the run now and free the worker. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface ListenOptions {
  /** Called on the main thread for each event after the call that delivered it resolved; return `true` to cancel the stream. */
  onEvent?: (event: W.StreamEvent) => boolean | void;
  /** Reject with the typed error after a call whose terminal event failed (default false: errors are events). */
  raiseOnError?: boolean;
}

/** An open stream session on a speech pack. */
export declare class ListenSession {
  readonly closed: boolean;
  /** The stream has ended (a `final` was seen or a call failed); still close it. */
  readonly ended: boolean;
  readonly final: W.Response | null;
  /** The wire error that ended the stream (a failed `final` or an `error` event), if any. */
  readonly error: W.Error | null;
  readonly transcript: string;
  /** Audio in; resolves to the events delivered during this call. */
  push(data: Bytes): Promise<W.StreamEvent[]>;
  /** Synchronous, safe at any moment. */
  cancel(): void;
  /** End the audio (`flush`) or abandon the stream; resolves to the remaining events. */
  close(flush?: boolean): Promise<W.StreamEvent[]>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface OpenOptions {
  dataDir?: string;
  bundleDir?: string;
  /** Path of `liblatai` (see `libraryCandidates`). */
  lib?: string;
}

export declare class Runtime {
  static open(options?: OpenOptions): Promise<Runtime>;
  readonly closed: boolean;
  readonly library: Library;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;

  run(request: RequestInput, options?: RunOptions): Promise<W.Response>;
  runStream(request: RequestInput, options?: RunOptions): EventStream;
  /** Synchronous; unknown or finished ids do nothing. */
  cancel(requestId: string): void;
  sessionClose(session: string): Promise<void>;

  listen(openRequest: W.StreamOpen | string, options?: ListenOptions): Promise<ListenSession>;
  listenIter(
    openRequest: W.StreamOpen | string,
    chunks: Iterable<Bytes> | AsyncIterable<Bytes>,
  ): AsyncGenerator<W.StreamEvent, void, undefined>;

  info(): Promise<W.RuntimeInfo>;
  status(name?: string | null): Promise<W.Status | W.RuntimeInfo>;
  inspect(target: string): Promise<W.PackInfo>;
  stage(file: string): Promise<W.StageReceipt>;
  pull(url: string, force?: boolean): Promise<W.StageReceipt>;
  install(source: string, activate?: boolean): Promise<W.StageReceipt[]>;
  activate(name: string, version?: string | null): Promise<W.PackVersion>;
  rollback(name: string): Promise<W.PackVersion>;
  listPacks(): Promise<W.PackVersion[]>;
  pin(name: string, pin?: string | null): Promise<string | null>;
  /** Strings the library handed out in this runtime's calls and strings given back. */
  debugCounters(): Promise<{ taken: number; freed: number }>;
}

// -- audio -------------------------------------------------------------------------------------

export declare class AudioError extends Error {}
export type AudioSource = string | Buffer | Uint8Array | ArrayBuffer;
export interface WavClip {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bits: number;
  seconds: number;
}
export interface AudioInputOptions {
  format?: 'wav' | 'pcm16';
  sampleRate?: number;
  language?: string;
  prompt?: string;
  promptBefore?: string;
  outputs?: Array<'timestamps' | 'language' | 'embeddings'>;
}
export declare function readWav(source: AudioSource): WavClip;
export declare function audioInput(source: AudioSource, options?: AudioInputOptions): W.InputsAudio;
export declare function audioRequest(
  pack: string,
  source: AudioSource,
  options?: AudioInputOptions & Partial<Pick<W.Request, 'output' | 'deadline_ms' | 'expect_digest' | 'session' | 'then' | 'stream'>>,
): W.Request;
export declare function textRequest(
  pack: string,
  text: string,
  options?: { maxTokens?: number; session?: string; deadlineMs?: number } & W.OutputOptions,
): W.Request;
export declare function pcm16Chunks(source: AudioSource, chunkBytes?: number): Generator<Buffer, void, undefined>;
