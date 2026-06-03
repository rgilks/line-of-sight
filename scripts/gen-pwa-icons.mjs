// Generate PWA + Apple touch icons from the brand favicon. Standard icons keep
// the transparent-on-dark mark; the maskable icon adds the safe-zone padding
// Android/iOS need so the mark isn't clipped by a circular/rounded mask.
// Run: node scripts/gen-pwa-icons.mjs
import sharp from 'sharp'
import {mkdirSync} from 'node:fs'

const OUT = 'web/public/icons'
mkdirSync(OUT, {recursive: true})

const BG = '#050505'
const svg = 'web/favicon.svg'

const plain = async (size) => {
  const mark = await sharp(svg).resize(size, size, {fit: 'contain'}).png().toBuffer()
  await sharp({create: {width: size, height: size, channels: 4, background: BG}})
    .composite([{input: mark}])
    .png()
    .toFile(`${OUT}/icon-${size}.png`)
}

const maskable = async (size) => {
  // Mark fills ~64% of the canvas, centered, leaving the maskable safe zone.
  const inner = Math.round(size * 0.64)
  const mark = await sharp(svg).resize(inner, inner, {fit: 'contain'}).png().toBuffer()
  await sharp({create: {width: size, height: size, channels: 4, background: BG}})
    .composite([{input: mark, gravity: 'center'}])
    .png()
    .toFile(`${OUT}/maskable-${size}.png`)
}

await plain(192)
await plain(512)
await maskable(192)
await maskable(512)
// Apple touch icon (180, opaque, no transparency — iOS ignores alpha anyway).
await plain(180).then(() =>
  sharp(`${OUT}/icon-192.png`).resize(180, 180).png().toFile(`${OUT}/apple-touch-icon.png`)
)
console.log('wrote PWA icons to', OUT)
