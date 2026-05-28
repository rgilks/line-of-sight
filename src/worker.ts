type AssetFetcher = {
  fetch: (request: Request) => Promise<Response>
}

export interface Env {
  ASSETS: AssetFetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'line-of-sight'
      })
    }

    return env.ASSETS.fetch(request)
  }
}
