/**
 * Re-color See-through layers from the ORIGINAL illustration.
 *
 *   node scripts/layers-recolor.mjs <layers.json> <original.png> [--out dir]
 *
 * See-through's LayerDiff regenerates each layer, which can drift in colour
 * (e.g. deep blue hair turning light blue). Its real value is the *masks*.
 * This script keeps every layer's alpha mask but samples RGB from the original
 * image, so the assembled model keeps the exact original palette.
 *
 * Outputs `<out>/<name>.png` (same coordinates as the layers) and
 * `<out>/layers-recolored.json` for layers-to-psd.mjs.
 */

import fs from 'node:fs'
import path from 'node:path'

import { decodePng, encodePng } from '../lib/core/png.js'

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const jsonPath = process.argv[2]
const origPath = process.argv[3]
if (!jsonPath || !origPath) {
  console.error('usage: node scripts/layers-recolor.mjs <layers.json> <original.png> [--out dir]')
  process.exit(1)
}
const dir = path.dirname(jsonPath)
const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const orig = decodePng(fs.readFileSync(origPath))
const outDir = argOf('--out', path.join(dir, 'recolored'))
fs.mkdirSync(outDir, { recursive: true })

// Bounding boxes: original character vs. the union of layer placements.
const bboxOfAlpha = (img) => {
  let left = img.width
  let top = img.height
  let right = 0
  let bottom = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] < 16) continue
      if (x < left) left = x
      if (y < top) top = y
      if (x > right) right = x
      if (y > bottom) bottom = y
    }
  }
  return { left, top, right: right + 1, bottom: bottom + 1 }
}
const ob = bboxOfAlpha(orig)
const cb = meta.layers.reduce(
  (acc, layer) => ({
    left: Math.min(acc.left, layer.left),
    top: Math.min(acc.top, layer.top),
    right: Math.max(acc.right, layer.right),
    bottom: Math.max(acc.bottom, layer.bottom),
  }),
  { left: meta.width, top: meta.height, right: 0, bottom: 0 },
)

const sample = (x, y) => {
  if (x < 0 || y < 0 || x >= orig.width || y >= orig.height) return [255, 255, 255, 0]
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const i = (iy * orig.width + ix) * 4
  return [orig.rgba[i], orig.rgba[i + 1], orig.rgba[i + 2], orig.rgba[i + 3]]
}

const outLayers = []
for (const layer of meta.layers) {
  const png = decodePng(fs.readFileSync(path.join(dir, layer.filename)))
  const out = Buffer.alloc(png.width * png.height * 4)
  let kept = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const si = (y * png.width + x) * 4
      const alpha = png.rgba[si + 3]
      if (alpha === 0) continue
      // Map layer pixel -> original pixel via the character bbox.
      const gx = layer.left + x
      const gy = layer.top + y
      const ox = ob.left + ((gx - cb.left) / (cb.right - cb.left)) * (ob.right - ob.left)
      const oy = ob.top + ((gy - cb.top) / (cb.bottom - cb.top)) * (ob.bottom - ob.top)
      const [r, g, b, oa] = sample(ox, oy)
      if (oa < 16) continue // outside the character: drop generated bleed
      out[si] = r
      out[si + 1] = g
      out[si + 2] = b
      out[si + 3] = alpha
      kept++
    }
  }
  const name = layer.name.replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
  const file = `${name}.png`
  fs.writeFileSync(path.join(outDir, file), encodePng(out, png.width, png.height))
  outLayers.push({ ...layer, filename: file })
  console.log(`recolored ${layer.name}: ${kept} px`)
}

const outJson = { ...meta, prefix: `${meta.prefix ?? 'layers'}-recolored`, layers: outLayers }
fs.writeFileSync(path.join(outDir, 'layers-recolored.json'), JSON.stringify(outJson, null, 2))
console.log(`done → ${path.join(outDir, 'layers-recolored.json')}`)
