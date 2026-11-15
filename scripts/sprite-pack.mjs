/**
 * Pack animation frames into a spritesheet atlas + manifest.
 *
 *   node scripts/sprite-pack.mjs <framesDir> [--out <dir>] [--name <name>] [--fps 6]
 *
 * Expected frame names: `<state>_<n>.png` (n starts at 0), all the same size.
 * Output: atlas.png (grid, row per state) + manifest.json in a format both
 * dsh-pet-style sprite players and our puppet page can consume.
 */

import fs from 'node:fs'
import path from 'node:path'

import { decodePng, encodePng } from '../lib/core/png.js'

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const framesDir = process.argv[2]
if (!framesDir) {
  console.error('usage: node scripts/sprite-pack.mjs <framesDir> [--out dir] [--name name] [--fps 6]')
  process.exit(1)
}

const files = fs.readdirSync(framesDir).filter((f) => f.toLowerCase().endsWith('.png'))
const groups = new Map()
for (const file of files) {
  const match = file.match(/^(.+)_(\d+)\.png$/i)
  if (!match) continue
  const state = match[1]
  if (!groups.has(state)) groups.set(state, [])
  groups.get(state).push({ file, index: Number(match[2]) })
}
if (groups.size === 0) {
  console.error('no "<state>_<n>.png" frames found')
  process.exit(1)
}

const states = [...groups.keys()].sort()
const decoded = new Map()
let frameWidth = 0
let frameHeight = 0
for (const state of states) {
  const frames = groups.get(state).sort((a, b) => a.index - b.index)
  if (frames.some((frame, index) => frame.index !== index)) {
    console.error(`state "${state}" has non-contiguous frame indices`)
    process.exit(1)
  }
  for (const frame of frames) {
    const png = decodePng(fs.readFileSync(path.join(framesDir, frame.file)))
    frameWidth = Math.max(frameWidth, png.width)
    frameHeight = Math.max(frameHeight, png.height)
    decoded.set(`${state}/${frame.index}`, png)
  }
}

const columns = Math.max(...states.map((state) => groups.get(state).length))
const atlas = Buffer.alloc(frameWidth * columns * frameHeight * states.length * 4)
for (let row = 0; row < states.length; row++) {
  const state = states[row]
  const frames = groups.get(state).sort((a, b) => a.index - b.index)
  for (let col = 0; col < frames.length; col++) {
    const png = decoded.get(`${state}/${col}`)
    // Bottom-align frames inside the cell so feet stay on the ground.
    const offsetX = Math.floor((frameWidth - png.width) / 2)
    const offsetY = frameHeight - png.height
    for (let y = 0; y < png.height; y++) {
      const src = y * png.width * 4
      const dst = ((row * frameHeight + offsetY + y) * frameWidth * columns + col * frameWidth + offsetX) * 4
      png.rgba.copy(atlas, dst, src, src + png.width * 4)
    }
  }
}

const outDir = argOf('--out', framesDir)
fs.mkdirSync(outDir, { recursive: true })
const atlasPath = path.join(outDir, 'atlas.png')
fs.writeFileSync(atlasPath, encodePng(atlas, frameWidth * columns, frameHeight * states.length))
const fps = Number(argOf('--fps', 6))
const manifest = {
  name: argOf('--name', path.basename(framesDir)),
  image: 'atlas.png',
  frameWidth,
  frameHeight,
  columns,
  rows: states.length,
  fps,
  states: Object.fromEntries(
    states.map((state, row) => [
      state,
      { row, frames: groups.get(state).length, fps, loop: state !== 'attack' },
    ]),
  ),
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`atlas: ${atlasPath} (${frameWidth * columns}x${frameHeight * states.length})`)
console.log(`states: ${states.join(', ')}`)
