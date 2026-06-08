#!/usr/bin/env node
/**
 * Smoke test wall detection on the live Line of Sight site.
 */
import {chromium} from 'playwright'
import path from 'node:path'

const baseUrl = process.env.LOS_BASE_URL ?? 'https://los.tre.systems'
const mapPath = path.resolve(process.env.LOS_MAP ?? 'Geomorphs/Standard Geomorphs/102 Research Deck.jpg')

const browser = await chromium.launch({headless: true})
const page = await browser.newPage({viewport: {width: 1400, height: 900}})
const consoleErrors = []

page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => {
  consoleErrors.push(error.message)
})

try {
  await page.goto(`${baseUrl}/`, {waitUntil: 'networkidle', timeout: 60_000})
  await page.locator('#boardCanvas').waitFor({state: 'attached', timeout: 10_000})

  await page.getByRole('tab', {name: 'Map'}).click()
  await page.locator('#fileInput').setInputFiles(mapPath)

  await page.waitForFunction(
    () => {
      const status = document.querySelector('#runtimeStatus')?.textContent ?? ''
      return /Analyzed .* tile\(s\)/i.test(status)
    },
    {timeout: 120_000}
  )

  const metrics = await page.evaluate(() => {
    const status = document.querySelector('#runtimeStatus')?.textContent?.trim() ?? ''
    const canvas = document.querySelector('#boardCanvas')
    return {
      status,
      canvasSize: canvas ? {width: canvas.width, height: canvas.height} : null
    }
  })
  await page.screenshot({path: '/tmp/los-live-smoke.png', fullPage: false})

  console.log(JSON.stringify({baseUrl, mapPath, metrics, consoleErrors}, null, 2))

  if (consoleErrors.length > 0) {
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
