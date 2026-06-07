import {defineConfig} from 'vite'

// Resolve an entry HTML relative to this config (project root), without needing
// node types in the typecheck — only URL + import.meta.url, both standard ESM.
const entry = (name: string): string => new URL(`./web/${name}`, import.meta.url).pathname

// Minimal env read without pulling in @types/node (kept out of the typecheck).
declare const process: {env: Record<string, string | undefined>}
const apiTarget = (): string => process.env.LOS_API_TARGET ?? 'https://los.tre.systems'

export default defineConfig({
  root: 'web',
  test: {
    include: ['src/**/*.test.ts', '../src/**/*.test.ts', '../core/**/*.test.ts']
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page. The front door (index, route `/`) is the live GM host/table
      // client; play (route `/play`) is the player/GM-spectator client — both run
      // web/src/play.ts. edit (route `/edit`) is the authoring tool (main.tsx)
      // with the deck generator and image import.
      input: {
        index: entry('index.html'),
        play: entry('play.html'),
        edit: entry('edit.html')
      }
    }
  },
  server: {
    fs: {
      allow: ['..']
    },
    // Dev-only: proxy the multiplayer API to a Worker so `npm run dev` (and the
    // host/play pages) work locally. Defaults to the deployed Worker; set
    // LOS_API_TARGET (e.g. http://127.0.0.1:8788) to run against a local
    // `wrangler dev` when iterating on the Durable Object / server code.
    proxy: {
      '/api': {target: apiTarget(), changeOrigin: true, secure: true}
    }
  }
})
