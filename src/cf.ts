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
