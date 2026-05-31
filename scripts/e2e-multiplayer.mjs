#!/usr/bin/env node
/**
 * Full browser E2E against the live site (default https://los.tre.systems):
 * author map → publish → two players + GM → door fog → move → republish.
 *
 * Env:
 *   LOS_BASE_URL      target origin (default https://los.tre.systems)
 *   LOS_E2E_TABLE     table name (default e2e-<timestamp>)
 *   LOS_E2E_HEADED=1  run with visible browser
 *
 * Publish requests are normalized to a small known wall/door layout so door
 * toggling stays reliable after noisy auto-analysis of the synthetic fixture map.
 */
import {chromium} from 'playwright'
import {mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

const BASE = process.env.LOS_BASE_URL ?? 'https://los.tre.systems'
const tableId = process.env.LOS_E2E_TABLE ?? `e2e-${Date.now()}`
const headless = process.env.LOS_E2E_HEADED !== '1'

const fail = (step, message) => {
  console.error(`FAIL [${step}]: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

const pass = (step, detail = '') => {
  console.log(`PASS [${step}]${detail ? `: ${detail}` : ''}`)
}

const waitStatus = async (page, pattern, step) => {
  const status = page.locator('#runtimeStatus')
  try {
    await status.waitFor({state: 'visible', timeout: 15_000})
    await page.waitForFunction(
      (re) => {
        const el = document.querySelector('#runtimeStatus')
        return el && new RegExp(re, 'i').test(el.textContent ?? '')
      },
      pattern,
      {timeout: 120_000}
    )
  } catch {
    const text = await status.textContent().catch(() => '(missing)')
    fail(step, `Timed out waiting for status /${pattern}/ — got "${text}"`)
  }
}

const waitPlayWho = async (page, pattern, step) => {
  try {
    await page.waitForFunction(
      (re) => {
        const el = document.querySelector('#who')
        return el && new RegExp(re).test(el.textContent ?? '')
      },
      pattern,
      {timeout: 30_000}
    )
  } catch {
    const text = await page.locator('#who').textContent().catch(() => '(missing)')
    fail(step, `Timed out waiting for #who /${pattern}/ — got "${text}"`)
  }
}

const clickBoard = async (page, boardX, boardY) => {
  const canvas = page.locator('#board')
  await canvas.waitFor({state: 'visible', timeout: 15_000})
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Canvas has no bounding box')
  const size = await canvas.evaluate((el) => ({width: el.width, height: el.height}))
  const x = box.x + (boardX / size.width) * box.width
  const y = box.y + (boardY / size.height) * box.height
  await page.mouse.click(x, y)
}

const collectConsoleErrors = (page, bucket) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.push(msg.text())
  })
  page.on('pageerror', (err) => bucket.push(String(err)))
}

const assertNoConsoleErrors = (label, errors) => {
  if (errors.length > 0) {
    fail(label, `Console errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  pass(label, 'no console errors')
}

const createMapFixture = async (context, path) => {
  const page = await context.newPage()
  await page.setContent(`<!doctype html><canvas id="map" width="1000" height="1000"></canvas>
    <script>
      const canvas = document.getElementById('map')
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 1000, 1000)
      ctx.fillStyle = '#000000'
      ctx.fillRect(490, 100, 20, 330)
      ctx.fillRect(490, 570, 20, 330)
      ctx.fillRect(495, 430, 10, 140)
    </script>`)
  await page.locator('#map').screenshot({path, type: 'png'})
  await page.close()
}

const SEED_OCCLUDERS = [
  {type: 'wall', id: 'e2e-wall-top', x1: 500, y1: 100, x2: 500, y2: 430},
  {type: 'door', id: 'e2e-door', x1: 500, y1: 430, x2: 500, y2: 570, open: false},
  {type: 'wall', id: 'e2e-wall-bottom', x1: 500, y1: 570, x2: 500, y2: 900}
]

console.log(`E2E multiplayer @ ${BASE} table="${tableId}" headless=${headless}`)

const artifactDir = join(tmpdir(), `los-e2e-${Date.now()}`)
mkdirSync(artifactDir, {recursive: true})
const mapPath = join(artifactDir, 'test-map.png')

const browser = await chromium.launch({headless})
const context = await browser.newContext({viewport: {width: 1280, height: 900}})
const errors = {author: [], p1: [], p2: [], gm: []}

try {
  await createMapFixture(context, mapPath)
  pass('fixture', mapPath)

  const author = await context.newPage()
  collectConsoleErrors(author, errors.author)
  await author.goto(BASE, {waitUntil: 'networkidle'})
  pass('author', 'loaded')

  await author.route(`**/api/tables/${tableId}/board`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.occluders = SEED_OCCLUDERS
    body.doorStates = {}
    body.sightRadius = body.sightRadius ?? 700
    await route.continue({postData: JSON.stringify(body)})
  })

  await author.getByRole('tab', {name: 'Map'}).click()
  await author.locator('#fileInput').setInputFiles(mapPath)
  await waitStatus(author, 'Analyzed .* tile', 'author-upload-analyze')

  await author.getByRole('tab', {name: 'Session'}).click()
  const wallCount = await author.locator('.stats.compact dd').nth(1).textContent()
  if (!wallCount || Number(wallCount) < 2) {
    fail('author-walls', `Expected detected walls/doors >= 2 before publish, got "${wallCount}"`)
  }
  pass('author-walls', `${wallCount} occluders detected`)

  await author.locator('#tableInput').fill(tableId)
  await author.locator('#publishButton').click()
  await waitStatus(author, `Published to "${tableId}"`, 'author-publish')

  const playerUrl = `${BASE}/play?table=${encodeURIComponent(tableId)}`
  const gmUrl = `${playerUrl}&gm=1`

  const p1 = await context.newPage()
  collectConsoleErrors(p1, errors.p1)
  await p1.goto(playerUrl, {waitUntil: 'domcontentloaded'})
  await waitPlayWho(p1, /You are P1 · 1 visible/, 'p1-join-fog')

  const p2 = await context.newPage()
  collectConsoleErrors(p2, errors.p2)
  await p2.goto(playerUrl, {waitUntil: 'domcontentloaded'})
  await waitPlayWho(p2, /You are P2 · 1 visible/, 'p2-join-fog')

  const gm = await context.newPage()
  collectConsoleErrors(gm, errors.gm)
  await gm.goto(gmUrl, {waitUntil: 'domcontentloaded'})
  await waitPlayWho(gm, /GM · 2 counters/, 'gm-join')

  await clickBoard(gm, 500, 500)
  await p1.waitForTimeout(800)
  await waitPlayWho(p1, /You are P1 · 2 visible/, 'p1-after-door-open')
  pass('door-open', 'P1 sees P2 after GM toggles door')

  await clickBoard(p1, 320, 500)
  await waitPlayWho(gm, /GM · 2 counters/, 'gm-after-p1-move')
  pass('p1-move', 'GM still sees both counters after P1 moves')

  await author.locator('#publishButton').click()
  await waitStatus(author, `Published to "${tableId}"`, 'author-republish')
  await waitPlayWho(p1, /You are P1 · 1 visible/, 'p1-after-republish-closed')
  await clickBoard(gm, 500, 500)
  await waitPlayWho(p1, /You are P1 · 2 visible/, 'p1-after-republish-reopen')
  pass('republish', 'Republish resets doors; GM reopens live for players')

  assertNoConsoleErrors('author-console', errors.author)
  assertNoConsoleErrors('p1-console', errors.p1)
  assertNoConsoleErrors('p2-console', errors.p2)
  assertNoConsoleErrors('gm-console', errors.gm)

  console.log(`\nAll E2E steps passed for table "${tableId}".`)
} catch (error) {
  if (!process.exitCode) process.exitCode = 1
  console.error(error instanceof Error ? error.message : error)
} finally {
  await browser.close()
  rmSync(artifactDir, {recursive: true, force: true})
}

process.exit(process.exitCode ?? 0)
