import {defineConfig, type Plugin, type PluginOption} from 'vite'
import {sentryVitePlugin} from '@sentry/vite-plugin'

// Resolve an entry HTML relative to this config (project root), without needing
// node types in the typecheck — only URL + import.meta.url, both standard ESM.
const entry = (name: string): string => new URL(`./web/${name}`, import.meta.url).pathname

const staticShellUrls = [
  '/',
  '/solo',
  '/controller',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icons/apple-touch-icon.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/token-portraits/officer.webp',
  '/token-portraits/marine.webp',
  '/token-portraits/scout.webp',
  '/token-portraits/engineer.webp',
  '/token-portraits/medic.webp',
  '/token-portraits/scientist.webp',
  '/token-portraits/trader.webp',
  '/token-portraits/security.webp',
  '/token-portraits/reptilian.webp',
  '/token-portraits/amphibian.webp',
  '/token-portraits/insectoid.webp',
  '/token-portraits/psion.webp'
]

// Emit `precache.json` (read by web/public/sw.js on install) listing the offline
// shell for the PWA entries — the /solo and /controller navigations, the full
// static+dynamic import closure of those two entries (which pulls in the
// lazily-imported 3D-dice chunk), and every emitted .wasm asset (the dice engine
// loads its wasm via `new URL(..., import.meta.url)`, which the chunk graph
// doesn't see). Hashed filenames come straight from the bundle, so the list can
// never drift from what shipped.
const precacheManifest = (): Plugin => ({
  name: 'precache-manifest',
  apply: 'build',
  generateBundle(_options, bundle) {
    const closure = new Set<string>()
    const visit = (fileName: string): void => {
      if (closure.has(fileName)) return
      closure.add(fileName)
      const chunk = bundle[fileName]
      if (!chunk || chunk.type !== 'chunk') return
      for (const css of chunk.viteMetadata?.importedCss ?? []) closure.add(css)
      for (const next of [...chunk.imports, ...chunk.dynamicImports]) visit(next)
    }
    for (const file of Object.values(bundle)) {
      if (file.type === 'chunk' && file.isEntry && (file.name === 'solo' || file.name === 'controller')) {
        visit(file.fileName)
      }
      if (file.type === 'asset' && file.fileName.endsWith('.wasm')) closure.add(file.fileName)
    }
    const urls = [...staticShellUrls, ...[...closure].map((f) => `/${f}`)]
    this.emitFile({type: 'asset', fileName: 'precache.json', source: JSON.stringify(urls)})
  }
})

// Every HTML entry gets the same update lifecycle, including the editor and
// read-only board routes. Keeping it as a separate entry prevents route modules
// from accidentally omitting PWA registration.
const pwaUpdateEntry = (): Plugin => ({
  name: 'pwa-update-entry',
  transformIndexHtml: {
    order: 'pre',
    handler() {
      return [
        {
          tag: 'script',
          attrs: {type: 'module', src: '/src/pwa-update.ts'},
          injectTo: 'head'
        }
      ]
    }
  }
})

// Minimal env read without pulling in @types/node (kept out of the typecheck).
declare const process: {env: Record<string, string | undefined>}
const apiTarget = (): string => process.env.LOS_API_TARGET ?? 'https://los.tre.systems'

const sentryPlugins = (): PluginOption[] => {
  if (!process.env.SENTRY_AUTH_TOKEN) {
    return []
  }

  return [
    sentryVitePlugin({
      org: process.env.SENTRY_ORG ?? 'total-reality-engineering',
      project: process.env.SENTRY_PROJECT ?? 'line-of-sight',
      url: process.env.SENTRY_URL ?? 'https://de.sentry.io',
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: {
        name: process.env.SENTRY_RELEASE ?? process.env.GITHUB_SHA
      },
      sourcemaps: {
        assets: './dist/client/**',
        filesToDeleteAfterUpload: ['./dist/client/**/*.map']
      },
      telemetry: false
    }) as PluginOption
  ]
}

export default defineConfig({
  root: 'web',
  plugins: [pwaUpdateEntry(), precacheManifest(), ...sentryPlugins()],
  test: {
    include: ['src/**/*.test.ts', '../src/**/*.test.ts', '../core/**/*.test.ts']
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: Boolean(process.env.SENTRY_AUTH_TOKEN),
    rollupOptions: {
      // Multi-page. The front door (index, route `/`) is the live GM host/table
      // client; play (route `/play`) is the player/GM-spectator client — both run
      // web/src/play.ts. edit (route `/edit`) is the authoring tool (main.tsx)
      // with the deck generator and image import.
      input: {
        index: entry('index.html'),
        play: entry('play.html'),
        edit: entry('edit.html'),
        solo: entry('solo.html'),
        // board (route `/board`) is a read-only shared-screen table display
        // (TV/monitor) with a join QR; it also runs web/src/play.ts.
        board: entry('board.html'),
        // controller (route `/controller`) is the phone gamepad for companion
        // play — the per-character SoloRoom view. See docs/COMPANION-PLAY.md.
        controller: entry('controller.html'),
        // solo-board (route `/solo-board`) is the shared-screen display of a
        // SoloRoom game (the deck on a TV) with a join QR.
        'solo-board': entry('solo-board.html')
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
