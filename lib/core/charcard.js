/**
 * Character-card import (SillyTavern / tavern format) → persona.
 *
 * Cards arrive as JSON or as a PNG whose tEXt chunk carries the JSON under the
 * "chara" keyword (base64). The importer maps the card's free-text personality
 * onto the Big Five via a keyword lexicon, picks the nearest of the four
 * presets, and turns `first_meshal` into the voice. No network, no deps.
 */

import { clamp } from './math.js'

// ---- PNG chunk walker ------------------------------------------------------

export const readPngChara = (buffer) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null // not a PNG
  let offset = 8
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    if (type === 'IEND') return null
    const start = offset + 8
    if (type === 'tEXt' && start + length <= bytes.length) {
      const chunk = bytes.slice(start, start + length)
      const nul = chunk.indexOf(0)
      if (nul > 0) {
        const keyword = String.fromCharCode(...chunk.slice(0, nul))
        if (keyword === 'chara') {
          const text = String.fromCharCode(...chunk.slice(nul + 1))
          try {
            return JSON.parse(Buffer.from(text.replace(/^data:[^,]+,/, ''), 'base64').toString('utf8'))
          } catch {
            return null
          }
        }
      }
    }
    offset += 12 + length
  }
  return null
}

// ---- persona mapping -------------------------------------------------------

/** Keyword → Big Five deltas. Covers the six common anime personas and more. */
const LEXICON = [
  [/傲娇|tsundere/i, { A: -0.2, E: 0.1 }],
  [/元气|energetic|genki/i, { E: 0.2, O: 0.1 }],
  [/三无|无口|emotionless|kuudere/i, { E: -0.25, N: -0.15 }],
  [/天然呆|呆萌|airhead/i, { O: 0.15, C: -0.2 }],
  [/温柔|治愈|gentle|kind/i, { A: 0.2, N: -0.1 }],
  [/病娇|yandere/i, { A: -0.2, N: 0.25 }],
  [/冷酷|冷漠|cold/i, { A: -0.15, E: -0.1, N: -0.1 }],
  [/好奇|curious/i, { O: 0.2 }],
  [/严谨|认真|diligent|serious/i, { C: 0.2 }],
  [/毒舌|刻薄|sarcastic|snarky/i, { A: -0.2 }],
  [/胆怯|胆小|timid/i, { N: 0.2, E: -0.15 }],
  [/自信|confident/i, { E: 0.15 }],
  [/害羞|shy/i, { E: -0.1, N: 0.1 }],
  [/乐观|optimistic/i, { N: -0.15 }],
  [/悲观|pessimistic/i, { N: 0.15 }],
  [/冒失|冒冒失失|clumsy/i, { C: -0.2 }],
  [/慵懒|lazy|怠惰/i, { C: -0.2 }],
  [/聪慧|聪明|smart|wise/i, { O: 0.1 }],
  [/冷静|沉稳|calm/i, { N: -0.2, C: 0.1 }],
  [/热情|enthusiastic/i, { E: 0.2, A: 0.1 }],
  [/忠犬|忠诚|loyal/i, { A: 0.3, C: 0.1 }],
]

const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism']

/** Pick the preset whose canonical profile is closest to the derived traits. */
export const presetFor = (traits, presetGenomes) => {
  let best = { preset: 'curious-engineer', distance: Infinity }
  for (const [preset, genome] of Object.entries(presetGenomes)) {
    const distance = TRAITS.reduce((sum, key) => sum + Math.abs(traits[key] - (genome[key] ?? 0.5)), 0)
    if (distance < best.distance) best = { preset, distance }
  }
  return best.preset
}

/** Normalize a card (JSON object, JSON string, or PNG buffer) into a persona. */
export const cardToPersona = (cardInput, { presetGenomes = {} } = {}) => {
  let card = cardInput
  if (Buffer.isBuffer(card) || card instanceof Uint8Array) {
    card = readPngChara(card) ?? {}
  } else if (typeof card === 'string') {
    try {
      card = JSON.parse(card)
    } catch {
      card = readPngChara(Buffer.from(card, 'binary')) ?? {}
    }
  }
  if (!card || typeof card !== 'object') card = {}
  const text = [card?.name, card?.description, card?.personality, card?.scenario, card?.first_meshal].filter((part) => typeof part === 'string').join(' ')
  const traits = { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 }
  const FULL = { O: 'openness', C: 'conscientiousness', E: 'extraversion', A: 'agreeableness', N: 'neuroticism' }
  for (const [pattern, deltas] of LEXICON) {
    if (pattern.test(text)) {
      for (const [key, delta] of Object.entries(deltas)) {
        const full = FULL[key]
        if (full) traits[full] = clamp(traits[full] + delta)
      }
    }
  }
  const preset = presetFor(traits, presetGenomes)
  const name = typeof card?.name === 'string' && card.name.trim().length > 0 ? card.name.trim().slice(0, 40) : '未命名角色'
  const identity = [card?.description, card?.personality].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim().slice(0, 300) || `我是${name}。`
  return {
    name,
    preset,
    traits,
    identity,
    worldview: typeof card?.world === 'string' ? card.world.trim().slice(0, 300) : null,
    voice: typeof card?.first_meshal === 'string' ? card.first_meshal.trim().slice(0, 200) : null,
    scenario: typeof card?.scenario === 'string' ? card.scenario.trim().slice(0, 300) : null,
  }
}
