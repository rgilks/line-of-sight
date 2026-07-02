import * as Sentry from '@sentry/cloudflare'
import type {DurableObjectNamespace, R2Bucket} from './cf'
import {sentryOptions, type SentryEnv} from './sentry'

type AssetFetcher = {
  fetch: (request: Request) => Promise<Response>
}

export interface Env extends SentryEnv {
  ASSETS: AssetFetcher
  TABLES: DurableObjectNamespace
  SOLO_ROOMS: DurableObjectNamespace
  MAPS: R2Bucket
}

// Route /api/tables/<id>/(stream|commands|board|auth) to that table's Durable Object.
const tableRoute = /^\/api\/tables\/([^/]+)\/(stream|commands|board|auth)$/
// Route /api/solo/<id>/(stream|commands|import) to that game's SoloRoom DO.
const soloRoute = /^\/api\/solo\/([^/]+)\/(stream|commands|import)$/
// GM-uploaded map storage. POST .../map uploads; GET .../map/<ref> serves.
const mapUploadRoute = /^\/api\/tables\/([^/]+)\/map$/
const mapGetRoute = /^\/api\/tables\/([^/]+)\/map\/([^/]+)$/

const MAX_MAP_BYTES = 25_000_000
const MAP_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'line-of-sight'
      })
    }

    const upload = mapUploadRoute.exec(url.pathname)
    if (upload && request.method === 'POST') {
      return uploadMap(request, env, upload[1])
    }

    const mapGet = mapGetRoute.exec(url.pathname)
    if (mapGet && request.method === 'GET') {
      return serveMap(request, env, mapGet[1], mapGet[2])
    }

    const match = tableRoute.exec(url.pathname)
    if (match) {
      const stub = env.TABLES.get(env.TABLES.idFromName(match[1]))
      return stub.fetch(request)
    }

    const solo = soloRoute.exec(url.pathname)
    if (solo) {
      const stub = env.SOLO_ROOMS.get(env.SOLO_ROOMS.idFromName(solo[1]))
      return stub.fetch(request)
    }

    return env.ASSETS.fetch(request)
  }
}

// Store a GM-uploaded map under an unguessable per-table key and return its ref.
// The bucket is private; bytes are only reachable via serveMap below.
const uploadMap = async (request: Request, env: Env, tableId: string): Promise<Response> => {
  const auth = await authorizeTableMap(request, env, tableId, 'map-upload')
  if (!auth.ok) {
    await drainRequestBody(request)
    return auth
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (!MAP_CONTENT_TYPES.has(contentType)) {
    await drainRequestBody(request)
    return Response.json({error: 'Map must be a PNG, JPEG, or WebP image.'}, {status: 415})
  }
  const contentLength = Number(request.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(contentLength) && contentLength > MAX_MAP_BYTES) {
    return Response.json({error: 'Map too large.'}, {status: 413})
  }

  const bytes = await request.arrayBuffer()
  if (bytes.byteLength === 0) return Response.json({error: 'Empty upload.'}, {status: 400})
  if (bytes.byteLength > MAX_MAP_BYTES) {
    return Response.json({error: 'Map too large.'}, {status: 413})
  }

  const assetRef = crypto.randomUUID()
  const key = `${tableId}/${assetRef}`
  await env.MAPS.put(key, bytes, {httpMetadata: {contentType}})
  // Only the newest map per table is ever served, so prune the rest: this bounds
  // R2 growth to ~one image per active table even though every host visit and
  // "New map" uploads a fresh one. Best-effort — never fail the upload over it.
  await pruneOldMaps(env, tableId, key).catch(() => {})
  return Response.json({assetRef})
}

// Delete every stored map for a table except `keepKey` (the one just written).
const pruneOldMaps = async (env: Env, tableId: string, keepKey: string): Promise<void> => {
  const stale: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.MAPS.list({prefix: `${tableId}/`, cursor})
    for (const object of page.objects) {
      if (object.key !== keepKey) stale.push(object.key)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  if (stale.length > 0) await env.MAPS.delete(stale)
}

// Stream a stored map only to the GM owner key or a live table connection token.
// Private caching only; not a public/crawlable URL.
const serveMap = async (request: Request, env: Env, tableId: string, assetRef: string): Promise<Response> => {
  const auth = await authorizeTableMap(request, env, tableId, 'map-read')
  if (!auth.ok) return auth

  const object = await env.MAPS.get(`${tableId}/${assetRef}`)
  if (!object) return new Response('Not found', {status: 404})

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('cache-control', 'private, max-age=3600')
  return new Response(object.body, {headers})
}

const authorizeTableMap = async (
  request: Request,
  env: Env,
  tableId: string,
  purpose: 'map-upload' | 'map-read'
): Promise<Response> => {
  const sourceUrl = new URL(request.url)
  const url = new URL(request.url)
  url.pathname = `/api/tables/${tableId}/auth`
  url.searchParams.set('purpose', purpose)
  if (purpose === 'map-read') {
    for (const key of ['gmKey', 'playerId', 'authToken']) {
      const value = sourceUrl.searchParams.get(key)
      if (value) url.searchParams.set(key, value)
    }
  }
  const stub = env.TABLES.get(env.TABLES.idFromName(tableId))
  return stub.fetch(new Request(url, {method: 'POST', headers: request.headers}))
}

const drainRequestBody = async (request: Request): Promise<void> => {
  await request.arrayBuffer().catch(() => {})
}

export default Sentry.withSentry(sentryOptions, handler)

export {GameTable} from './game-table'
export {SoloRoom} from './solo-room'
