/**
 * Pet asset registry: user-supplied animations / meme images that extend the
 * pet's vocabulary at runtime.
 *
 * Files live in `$DSH_HOME/cerebrum/pet-assets/`; the registry (pet-assets.json)
 * maps each file to an emotion and tags, so the autonomy loop can pick "the
 * right expression for how I feel". Nothing here touches the network: the host
 * serves the files from a read-only loopback endpoint (lib/api.js /asset/...).
 */

import fs from 'node:fs'
import path from 'node:path'

import { clamp } from './math.js'

export const ASSET_EXTENSIONS = {
  anim: ['webm', 'mp4', 'gif'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
}

export const assetKindOf = (file) => {
  const ext = path.extname(String(file)).slice(1).toLowerCase()
  if (ASSET_EXTENSIONS.anim.includes(ext)) return 'anim'
  if (ASSET_EXTENSIONS.image.includes(ext)) return 'image'
  return null
}

export const sanitizeAssetName = (name) =>
  path.basename(String(name)).replace(/[^\w.\-\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

/** Pure registry operations over a plain object: {id: entry}. */
export const addAsset = (registry, entry, now = Date.now()) => {
  const name = sanitizeAssetName(entry.file ?? entry.name ?? '')
  if (!name) throw new Error('asset needs a file name')
  const kind = entry.kind ?? assetKindOf(name)
  if (!kind) throw new Error(`unsupported asset extension: ${name}`)
  const id = `pa_${now.toString(36)}_${Math.abs(hash(name)).toString(36)}`
  const record = {
    id,
    name,
    kind,
    emotion: typeof entry.emotion === 'string' && entry.emotion.length > 0 ? entry.emotion : 'calm',
    tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 8) : [],
    weight: clamp(Number(entry.weight ?? 0.5)),
    url: entry.url ?? null,
    at: now,
  }
  registry[id] = record
  return record
}

/** Weighted pick among assets matching an emotion (falling back to calm). */
export const pickAsset = (registry, { emotion = 'calm', kind = null, rng = Math.random } = {}) => {
  const all = Object.values(registry ?? {}).filter((entry) => (kind ? entry.kind === kind : true))
  const matching = all.filter((entry) => entry.emotion === emotion)
  const pool = matching.length > 0 ? matching : all.filter((entry) => entry.emotion === 'calm')
  if (pool.length === 0) return null
  const total = pool.reduce((sum, entry) => sum + Math.max(0.05, entry.weight ?? 0.5), 0)
  let roll = rng() * total
  for (const entry of pool) {
    roll -= Math.max(0.05, entry.weight ?? 0.5)
    if (roll <= 0) return entry
  }
  return pool[pool.length - 1]
}

/** Learn from an outcome: success reinforces, failure decays (bounded). */
export const learnAssetOutcome = (registry, id, success, now = Date.now()) => {
  const entry = registry?.[id]
  if (!entry) return null
  const delta = success ? 0.12 : -0.08
  entry.weight = clamp((entry.weight ?? 0.5) + delta, 0.05, 1)
  entry.uses = (entry.uses ?? 0) + 1
  entry.successes = (entry.successes ?? 0) + (success ? 1 : 0)
  entry.at = now
  return entry
}

const hash = (text) => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  return h
}

/** File-level helpers (thin wrappers around the registry file). */
export const loadAssets = (dir) => {
  try {
    const raw = fs.readFileSync(path.join(dir, 'pet-assets.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const saveAssets = (dir, registry) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pet-assets.json'), JSON.stringify(registry, null, 2), 'utf8')
}
