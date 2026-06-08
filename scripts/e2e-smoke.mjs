#!/usr/bin/env node
/**
 * Lightweight browser smoke test. Loads every route from the single Vite build
 * in headless Chromium and asserts each one boots its key element with no
 * console or page errors, plus a /healthz check on the Worker.
 *
 * Hermetic in CI: the workflow builds the client and runs the Worker in
 * wrangler's local simulator, then points LOS_BASE_URL at it. By default it
 * targets the live site, so the same script doubles as a post-deploy check.
 *
 * Env:
 *   LOS_BASE_URL      target origin (default https://los.tre.systems)
 *   LOS_E2E_HEADED=1  run with a visible browser
 *
 * It deliberately does NOT drive the multiplayer game flow (publish, join,
 * doors, movement). That lived here once, but the routes, drawer UI, and
 * movement mechanics move too fast for a fixed-coordinate browser script to
 * stay green. This smoke test catches the failures that actually matter in a
 * prototype — a route that won't serve, a bundle that won't boot, an exception
 * on load — while staying reliable enough to trust when it goes red.
 */
import {chromium} from 'playwright'

const BASE = process.env.LOS_BASE_URL ?? 'https://los.tre.systems'
const headless = process.env.LOS_E2E_HEADED !== '1'

// Each route is served from the one build. `ready` is an element that the
// route's bundle injects into the static `<div id="app">` shell during its
// first render, so waiting for it to attach proves the bundle loaded and ran.
const ROUTES = [
  {path: '/', ready: '#board', label: 'host'},
  {path: '/play', ready: '#board', label: 'player'},
  {path: '/edit', ready: '#runtimeStatus', label: 'editor'},
  {path: '/solo', ready: '#solo-canvas', label: 'solo'}
]

let failed = false
const fail = (step, message) => {
  console.error(`FAIL [${step}]: ${message}`)
  failed = true
}
const pass = (step, detail = '') => {
  console.log(`PASS [${step}]${detail ? `: ${detail}` : ''}`)
}

console.log(`E2E smoke @ ${BASE} headless=${headless}`)

// 1) Worker health endpoint.
try {
  const res = await fetch(`${BASE}/healthz`)
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok !== true) {
    fail('healthz', `Unexpected response: ${res.status} ${JSON.stringify(body)}`)
  } else {
    pass('healthz', body.service ?? '')
  }
} catch (error) {
  fail('healthz', error instanceof Error ? error.message : String(error))
}

// 2) Each route boots cleanly.
const browser = await chromium.launch({headless})
const context = await browser.newContext({viewport: {width: 1280, height: 900}})

try {
  for (const route of ROUTES) {
    const page = await context.newPage()
    const errors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(String(err)))
    try {
      // Never wait for `networkidle`: the host/player routes hold an SSE stream
      // open, so the network never goes idle and the navigation would time out.
      await page.goto(`${BASE}${route.path}`, {waitUntil: 'domcontentloaded'})
      await page.locator(route.ready).first().waitFor({state: 'attached', timeout: 30_000})
      // Let any late console/page errors surface after the first render.
      await page.waitForTimeout(1000)
      if (errors.length > 0) {
        fail(route.label, `${route.path} console/page errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
      } else {
        pass(route.label, `${route.path} booted clean`)
      }
    } catch (error) {
      fail(route.label, `${route.path}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
}

if (failed) {
  console.error('\nSmoke test failed.')
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
process.exit(0)
