/**
 * Remove the background from generated frames and write `<state>_<n>.png`.
 *
 *   node scripts/chroma-cut.mjs <inDir> [--out <dir>]
 *        [--mode chroma|flood] [--color "#00ff00"|"#ffffff"] [--tolerance 90] [--soft 45]
 *
 * chroma = remove every pixel near the key colour (green screen).
 * flood  = remove only the background connected to the frame edge (white studio
 *          background, keeps white details inside the character).
 */

import fs from 'node:fs'
import path from 'node:path'

import { makeTransparentPng, removeBackgroundFloodFill } from '../lib/core/transparent.js'

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const inDir = process.argv[2]
if (!inDir) {
  console.error('usage: node scripts/chroma-cut.mjs <inDir> [--out dir] [--color #00ff00] [--tolerance 90] [--soft 45]')
  process.exit(1)
}
const outDir = argOf('--out', inDir)
fs.mkdirSync(outDir, { recursive: true })
const mode = argOf('--mode', 'chroma')
const options = {
  color: argOf('--color', mode === 'flood' ? '#ffffff' : '#00ff00'),
  tolerance: Number(argOf('--tolerance', mode === 'flood' ? 26 : 90)),
  soft: Number(argOf('--soft', 45)),
  despill: 0.6,
}

const cut = (bytes) => (mode === 'flood' ? removeBackgroundFloodFill(bytes, options) : makeTransparentPng(bytes, options))

let total = 0
for (const file of fs.readdirSync(inDir)) {
  if (!file.toLowerCase().endsWith('.png')) continue
  const bytes = fs.readFileSync(path.join(inDir, file))
  const result = cut(bytes)
  const target = path.join(outDir, file)
  fs.writeFileSync(target, result.bytes)
  total++
  const ratio = Math.round(result.transparentRatio * 100)
  if (ratio < 5 || ratio > 95) console.log(`⚠ ${file}: transparent ${ratio}% (background may be off)`)
}
console.log(`cut ${total} frames → ${outDir}`)
