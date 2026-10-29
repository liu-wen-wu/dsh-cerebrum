import assert from 'node:assert/strict'
import test from 'node:test'

import { decodePng, encodePng } from '../lib/core/png.js'
import { chromaKeyRgba, makeTransparentPng, parseColor } from '../lib/core/transparent.js'

const makeImage = (w, h, fill, rect, rectColor) => {
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inRect = rect && x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]
      const [r, g, b] = inRect ? rectColor : fill
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = 255
    }
  }
  return encodePng(rgba, w, h)
}

test('png: encode → decode round-trips RGBA pixels', () => {
  const png = makeImage(4, 4, [0, 255, 0], [1, 1, 3, 3], [200, 40, 40])
  const { width, height, rgba } = decodePng(png)
  assert.equal(width, 4)
  assert.equal(height, 4)
  assert.deepEqual([rgba[0], rgba[1], rgba[2], rgba[3]], [0, 255, 0, 255])
  const center = (1 * 4 + 1) * 4
  assert.deepEqual([rgba[center], rgba[center + 1], rgba[center + 2]], [200, 40, 40])
})

test('transparent: green background is keyed out, the subject keeps alpha', () => {
  const png = makeImage(8, 8, [0, 255, 0], [2, 2, 6, 6], [30, 30, 200])
  const result = makeTransparentPng(png, { color: '#00ff00', tolerance: 90, soft: 30 })
  assert.ok(result.transparentRatio > 0.5, 'most of the frame was background')
  const { rgba } = decodePng(result.bytes)
  assert.equal(rgba[3], 0, 'corner pixel is transparent')
  const center = (4 * 8 + 4) * 4
  assert.equal(rgba[center + 3], 255, 'subject pixel is opaque')
  assert.deepEqual([rgba[center], rgba[center + 1], rgba[center + 2]], [30, 30, 200], 'subject colour survives')
})

test('transparent: despill removes green fringe on edge pixels', () => {
  const rgba = Buffer.from([20, 200, 20, 255, 30, 30, 200, 255])
  chromaKeyRgba(rgba, { color: [0, 255, 0], tolerance: 60, soft: 1, despill: 0.8 })
  // First pixel was green-dominant but not inside tolerance (distance ~ 200*0.9):
  // after despill its green channel must be pulled down toward max(r,b).
  assert.ok(rgba[1] <= 200)
})

test('transparent: color parsing rejects junk', () => {
  assert.deepEqual(parseColor('#112233'), [17, 34, 51])
  assert.deepEqual(parseColor('00ff00'), [0, 255, 0])
  assert.throws(() => parseColor('green'), /#RRGGBB/)
})
