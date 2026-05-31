import {defineConfig} from 'vite'

// Resolve an entry HTML relative to this config (project root), without needing
// node types in the typecheck — only URL + import.meta.url, both standard ESM.
const entry = (name: string): string => new URL(`./web/${name}`, import.meta.url).pathname

export default defineConfig({
  root: 'web',
  test: {
    include: ['src/**/*.test.ts', '../src/**/*.test.ts']
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page: the single-player authoring tool (index) and the multiplayer
      // client (play). The deck generator lives inside the index tool.
      input: {
        index: entry('index.html'),
        play: entry('play.html')
      }
    }
  },
  server: {
    fs: {
      allow: ['..']
    },
    // Dev-only: proxy the multiplayer API to the deployed Worker so `npm run dev`
    // (and the /play page) work locally against the real Durable Object.
    proxy: {
      '/api': {target: 'https://los.tre.systems', changeOrigin: true, secure: true}
    }
  }
})
