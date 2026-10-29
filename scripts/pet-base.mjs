/**
 * Make a cut-out puppet base from a flattened chibi PNG (solid background).
 *
 *   node scripts/pet-base.mjs in.png out.png [tolerance]
 *
 * Uses border-connected flood fill, so white details *inside* the character
 * (apron, highlights) survive while the studio background is removed.
 */

import fs from 'node:fs'

import { removeBackgroundFloodFill } from '../lib/core/transparent.js'

const [input, output, toleranceArg] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: node scripts/pet-base.mjs <in.png> <out.png> [tolerance=26]')
  process.exit(1)
}

const bytes = fs.readFileSync(input)
const result = removeBackgroundFloodFill(bytes, { color: [255, 255, 255], tolerance: Number(toleranceArg) || 26 })
fs.writeFileSync(output, result.bytes)
console.log(`${output}: ${result.width}x${result.height} · 透明像素 ${Math.round(result.transparentRatio * 100)}%`)
