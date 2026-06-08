import type {DurableObjectNamespace, R2Bucket} from './cf'

type AssetFetcher = {
  fetch: (request: Request) => Promise<Response>
}

export interface Env {
  ASSETS: AssetFetcher
  TABLES: DurableObjectNamespace
  SOLO_ROOMS: DurableObjectNamespace
  MAPS: R2Bucket
}

// Route /api/tables/<id>/(stream|commands|board) to that table's Durable Object.
const tableRoute = /^\/api\/tables\/([^/]+)\/(stream|commands|board)$/
// Route /api/solo/<id>/(stream|commands) to that game's SoloRoom Durable Object.
const soloRoute = /^\/api\/solo\/([^/]+)\/(stream|commands)$/
// GM-uploaded map storage. POST .../map uploads; GET .../map/<ref> serves.
const mapUploadRoute = /^\/api\/tables\/([^/]+)\/map$/
const mapGetRoute = /^\/api\/tables\/([^/]+)\/map\/([^/]+)$/

const MAX_MAP_BYTES = 25_000_000

export default {
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
      return serveMap(env, mapGet[1], mapGet[2])
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
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    return Response.json({error: 'Map must be an image.'}, {status: 415})
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

// Stream a stored map. Private caching only; not a public/crawlable URL. Once
// auth lands this is where game-membership gating goes.
const serveMap = async (env: Env, tableId: string, assetRef: string): Promise<Response> => {
  const object = await env.MAPS.get(`${tableId}/${assetRef}`)
  if (!object) return new Response('Not found', {status: 404})

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('cache-control', 'private, max-age=3600')
  return new Response(object.body, {headers})
}

export {GameTable} from './game-table'
export {SoloRoom} from './solo-room'
