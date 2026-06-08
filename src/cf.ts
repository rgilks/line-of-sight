// Minimal hand-rolled Cloudflare Workers types.
//
// We deliberately do NOT depend on @cloudflare/workers-types: its global
// declarations clash with the DOM lib that the browser build (and los-core)
// rely on in this shared tsconfig. These few interfaces are all the Durable
// Object surface this prototype uses. (src/worker.ts already hand-rolls its
// ASSETS fetcher type for the same reason.)

export interface DurableObjectId {
  toString(): string
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

// The slice of the Durable Object storage API the table uses: ordered key/value
// reads + writes for the event log, plus the construction-time barrier that
// holds requests until state is rebuilt. Keys sort lexicographically, so the log
// keys are zero-padded (see EVT_KEY in game-table.ts) to replay in seq order.
export interface DurableObjectStorage {
  put<T = unknown>(key: string, value: T): Promise<void>
  list<T = unknown>(options?: {prefix?: string}): Promise<Map<string, T>>
}

export interface DurableObjectState {
  readonly id: DurableObjectId
  readonly storage: DurableObjectStorage
  // Runs `callback` before any fetch is delivered, and blocks delivery until it
  // resolves — the only way to do async setup from a (synchronous) constructor.
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

// Minimal R2 surface used for GM-uploaded maps (private bucket, served only
// through the Worker — see docs/MULTIPLAYER.md).
export interface R2Object {
  writeHttpMetadata(headers: Headers): void
  readonly size: number
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream
}

export interface R2Objects {
  readonly objects: {key: string}[]
  readonly truncated: boolean
  readonly cursor?: string
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: {httpMetadata?: {contentType?: string}}
  ): Promise<R2Object>
  delete(key: string | string[]): Promise<void>
  list(options?: {prefix?: string; cursor?: string}): Promise<R2Objects>
}
