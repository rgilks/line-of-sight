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

export interface DurableObjectState {
  readonly id: DurableObjectId
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
