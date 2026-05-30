import type {DurableObjectNamespace} from './cf'

type AssetFetcher = {
  fetch: (request: Request) => Promise<Response>
}

export interface Env {
  ASSETS: AssetFetcher
  TABLES: DurableObjectNamespace
}

// Route /api/tables/<id>/(stream|commands) to that table's Durable Object.
const tableRoute = /^\/api\/tables\/([^/]+)\/(stream|commands)$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'line-of-sight'
      })
    }

    const match = tableRoute.exec(url.pathname)
    if (match) {
      const stub = env.TABLES.get(env.TABLES.idFromName(match[1]))
      return stub.fetch(request)
    }

    return env.ASSETS.fetch(request)
  }
}

export {GameTable} from './game-table'
