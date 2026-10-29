/**
 * Transparent-expression helpers (no ffmpeg required for stills).
 *
 * Backgrounds from image models are opaque. Two practical routes:
 *   1. ask the model for a solid chroma background ("pure green"), then key it
 *      out here — soft alpha at the edges, despill to remove green fringe;
 *   2. ComfyUI/custom-node matting (BiRefNet/rembg) when available — better
 *      edges and works for video frames.
 *
 * Video keeps needing a real matte path (ffmpeg colorkey → VP9 alpha, or a
 * per-frame rembg workflow in ComfyUI); this module covers stills.
 */

import { decodePng, encodePng } from './png.js'

export const parseColor = (input) => {
  if (Array.isArray(input) && input.length >= 3) return input.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))))
  const hex = String(input ?? '').trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error('chroma color must be #RRGGBB')
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

/**
 * Key out the chroma colour in place.
 * - fully transparent inside `tolerance` (RGB distance)
 * - linear alpha ramp over `soft` (anti-aliased edges)
 * - despill: pull the green-dominant fringe back toward max(r,b)
 */
export const chromaKeyRgba = (rgba, { color = [0, 255, 0], tolerance = 90, soft = 45, despill = 0.6 } = {}) => {
  const [kr, kg, kb] = parseColor(color)
  const tol = Math.max(0, Number(tolerance) || 0)
  const fade = Math.max(1, Number(soft) || 1)
  const spill = Math.max(0, Math.min(1, Number(despill) ?? 0.6))
  let transparent = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const dr = r - kr
    const dg = g - kg
    const db = b - kb
    const distance = Math.sqrt(dr * dr + dg * dg + db * db)
    let alpha = 255
    if (distance <= tol) alpha = 0
    else if (distance <= tol + fade) alpha = Math.round((255 * (distance - tol)) / fade)
    if (alpha === 0) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
      rgba[i + 3] = 0
      transparent++
      continue
    }
    // Despill only near the keyed region (distance within tol+fade*2).
    if (distance < tol + fade * 2) {
      const excess = g - Math.max(r, b)
      if (excess > 0) rgba[i + 1] = Math.max(0, Math.round(g - excess * spill))
    }
    rgba[i + 3] = alpha
  }
  return { transparent, total: rgba.length / 4 }
}

/** Decode → key → re-encode. Returns { bytes, transparentRatio }. */
export const makeTransparentPng = (pngBytes, options = {}) => {
  const { width, height, rgba } = decodePng(pngBytes)
  const { transparent, total } = chromaKeyRgba(rgba, options)
  return {
    bytes: encodePng(rgba, width, height),
    width,
    height,
    transparentRatio: total > 0 ? transparent / total : 0,
  }
}
