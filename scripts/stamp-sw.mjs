#!/usr/bin/env node
import {createHash} from 'node:crypto'
import {readFile, readdir, writeFile} from 'node:fs/promises'
import {join, relative} from 'node:path'

const outputDir = new URL('../dist/client/', import.meta.url)
const swPath = new URL('sw.js', outputDir)

const filesUnder = async (directory) => {
  const entries = await readdir(directory, {withFileTypes: true})
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path)))
    else if (entry.isFile() && entry.name !== 'sw.js') files.push(path)
  }
  return files
}

const files = (await filesUnder(outputDir.pathname)).sort()
const hash = createHash('sha256')
const source = await readFile(swPath, 'utf8')
hash.update(source)
for (const file of files) {
  hash.update(relative(outputDir.pathname, file))
  hash.update(await readFile(file))
}

const version = hash.digest('hex').slice(0, 16)
if (!source.includes('__CACHE_VERSION__')) {
  throw new Error('dist/client/sw.js does not contain the cache-version placeholder')
}
await writeFile(swPath, source.replaceAll('__CACHE_VERSION__', version))
console.log(`stamped sw.js cache version: ${version}`)
