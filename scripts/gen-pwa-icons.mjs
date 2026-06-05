// Sync the PWA / favicon assets from the shared Cepheus brand repo into this
// project, so every Cepheus tool ships the same C-Cog mark (see the brand
// guidelines, §7 "Shared icon"). Run after the brand assets change:
//   node scripts/gen-pwa-icons.mjs
//
// Source of truth: ~/Source/cepheus-branding/assets. Copies the canonical icon
// sizes and derives the two extra sizes this app's manifest/HTML reference
// (maskable-192, icon-180). Never hand-edit the generated icons.
import sharp from 'sharp'
import {copyFileSync, mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

const BRAND = process.env.CEPHEUS_BRAND ?? join(homedir(), 'Source/cepheus-branding/assets')
const ICONS = 'web/public/icons'
mkdirSync(ICONS, {recursive: true})

// Canonical assets copied verbatim.
copyFileSync(join(BRAND, 'favicon/favicon.svg'), 'web/public/favicon.svg')
copyFileSync(join(BRAND, 'favicon/favicon.ico'), 'web/public/favicon.ico')
copyFileSync(join(BRAND, 'app-icons/icon-192.png'), `${ICONS}/icon-192.png`)
copyFileSync(join(BRAND, 'app-icons/icon-512.png'), `${ICONS}/icon-512.png`)
copyFileSync(join(BRAND, 'app-icons/icon-maskable-512.png'), `${ICONS}/maskable-512.png`)
copyFileSync(join(BRAND, 'app-icons/apple-touch-icon.png'), `${ICONS}/apple-touch-icon.png`)

// Derived sizes our manifest/HTML still reference.
await sharp(join(BRAND, 'app-icons/icon-maskable-512.png')).resize(192, 192).toFile(`${ICONS}/maskable-192.png`)
await sharp(join(BRAND, 'app-icons/icon-192.png')).resize(180, 180).toFile(`${ICONS}/icon-180.png`)

console.log('synced Cepheus brand icons from', BRAND)
