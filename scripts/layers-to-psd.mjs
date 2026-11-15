/**
 * Build a PSD (RGBA, 8-bit, raw channels) from See-through layer PNGs.
 *
 *   node scripts/layers-to-psd.mjs <layers.json> [--out <file.psd>]
 *
 * The layers.json comes from ComfyUI-See-through `SeeThrough_SavePSD`:
 *   { width, height, layers: [{ name, filename, left, top, right, bottom }] }
 *
 * Layer order in the JSON is back-to-front (first = furthest back), which is
 * also the PSD stacking order PSD2Live expects.
 */

import fs from 'node:fs'
import path from 'node:path'

import { decodePng } from '../lib/core/png.js'

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const jsonPath = process.argv[2]
if (!jsonPath) {
  console.error('usage: node scripts/layers-to-psd.mjs <layers.json> [--out file.psd]')
  process.exit(1)
}
const dir = path.dirname(jsonPath)
const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const width = meta.width
const height = meta.height
const outPath = argOf('--out', path.join(dir, `${meta.prefix ?? 'layers'}.psd`))

const u16 = (value) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(value & 0xffff, 0)
  return b
}
const i16 = (value) => {
  const b = Buffer.alloc(2)
  b.writeInt16BE(value, 0)
  return b
}
const u32 = (value) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value >>> 0, 0)
  return b
}
const pascal = (name) => {
  const bytes = Buffer.from(name, 'utf8')
  const padded = Buffer.alloc(1 + bytes.length + ((4 - ((1 + bytes.length) % 4)) % 4))
  padded[0] = bytes.length
  bytes.copy(padded, 1)
  return padded
}

const layers = []
const merged = Buffer.alloc(width * height * 4)
for (const entry of meta.layers) {
  const png = decodePng(fs.readFileSync(path.join(dir, entry.filename)))
  const left = entry.left
  const top = entry.top
  layers.push({ name: entry.name, left, top, width: png.width, height: png.height, rgba: png.rgba })
  // composite (source-over) in JSON order
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const si = (y * png.width + x) * 4
      const a = png.rgba[si + 3] / 255
      if (a === 0) continue
      const dx = left + x
      const dy = top + y
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue
      const di = (dy * width + dx) * 4
      merged[di] = Math.round(png.rgba[si] * a + merged[di] * (1 - a))
      merged[di + 1] = Math.round(png.rgba[si + 1] * a + merged[di + 1] * (1 - a))
      merged[di + 2] = Math.round(png.rgba[si + 2] * a + merged[di + 2] * (1 - a))
      merged[di + 3] = Math.round(255 * a + merged[di + 3] * (1 - a))
    }
  }
}

const channelIds = [0, 1, 2, -1]
const planeOf = (layer, channelId) => {
  const w = layer.width
  const h = layer.height
  const plane = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i++) {
    const base = i * 4
    plane[i] = channelId === -1 ? layer.rgba[base + 3] : layer.rgba[base + channelId]
  }
  return plane
}

// Layer records + channel image data
const records = []
const channelChunks = []
for (const layer of layers) {
  const planes = channelIds.map((id) => planeOf(layer, id))
  const channelInfos = planes.map((plane) => ({ length: 2 + plane.length }))
  const nameBlock = pascal(layer.name)
  const extraLength = 4 + 4 + nameBlock.length
  const recordLength = 16 + 2 + 6 * channelIds.length + 8 + 4 + 4 + extraLength
  const record = Buffer.concat([
    Buffer.concat([u32(layer.top), u32(layer.left), u32(layer.top + layer.height), u32(layer.left + layer.width)]),
    u16(channelIds.length),
    ...channelIds.map((id, index) => Buffer.concat([i16(id), u32(channelInfos[index].length)])),
    Buffer.from('8BIM', 'ascii'), // blend mode signature
    Buffer.from('norm', 'ascii'), // blend mode key
    Buffer.from([255, 0, 0, 0]),
    u32(extraLength),
    u32(0), // layer mask
    u32(0), // blending ranges
    nameBlock,
  ])
  if (record.length !== recordLength) throw new Error(`record size mismatch ${record.length} != ${recordLength}`)
  records.push(record)
  for (const plane of planes) channelChunks.push(Buffer.concat([u16(0), plane]))
}

const layerInfoBody = Buffer.concat([u16(layers.length), ...records, ...channelChunks])
const layerInfo = Buffer.concat([u32(layerInfoBody.length), layerInfoBody])
const layerAndMask = Buffer.concat([u32(layerInfo.length + 4), layerInfo, u32(0)])

const header = Buffer.alloc(26)
header.write('8BPS', 0, 'ascii')
header.writeUInt16BE(1, 4)
header.writeUInt16BE(4, 12)
header.writeUInt32BE(height, 14)
header.writeUInt32BE(width, 18)
header.writeUInt16BE(8, 22)
header.writeUInt16BE(3, 24)

const mergedData = Buffer.concat([u16(0), merged])
const psd = Buffer.concat([header, u32(0), u32(0), layerAndMask, mergedData])
fs.writeFileSync(outPath, psd)
console.log(`psd: ${outPath} (${width}x${height}, ${layers.length} layers, ${Math.round(psd.length / 1024)} KB)`)
