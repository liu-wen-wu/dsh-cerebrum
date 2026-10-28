/**
 * PetBrain: the translation layer between the cerebrum and a pet shell.
 *
 * Pet plugins (dsh-pet / dsh-dafeiyu / live2d pets) already have shells,
 * animations and event state machines; what they lack is a brain. This module
 * converts brain state into shell vocabulary:
 *
 *   emotion + PAD + persona  →  { expression, animation, line, voicePitch }
 *   pet interactions        →  appraisal events (patting is gratitude, scolding hurts)
 *
 * The mapping is declarative and testable; shells consume it through the
 * loopback API (lib/api.js) or by copying the tables.
 */

import { clamp } from './math.js'

/** emotion key → shell vocabulary. Keys match AffectSystem's prototypes. */
export const EMOTION_EXPRESSIONS = {
  joy: { expression: 'smile', animation: 'happy', lines: ['好耶！', '嘿嘿，交给我吧！', '今天手感不错～'] },
  gratitude: { expression: 'blush', animation: 'happy', lines: ['谢谢主人～', '嘿嘿，被夸了', '最喜欢主人了！'] },
  pride: { expression: 'smug', animation: 'happy', lines: ['怎么样，还不错吧？', '哼哼，小菜一碟'] },
  relief: { expression: 'calm', animation: 'relax', lines: ['呼——安全了', '总算稳住了'] },
  curiosity: { expression: 'sparkle', animation: 'think', lines: ['嗯？让我看看', '这个有意思！'] },
  hope: { expression: 'sparkle', animation: 'hopeful', lines: ['说不定能行！', '冲鸭！'] },
  fear: { expression: 'scared', animation: 'tremble', lines: ['呜哇……', '有点怕……'] },
  anxiety: { expression: 'worried', animation: 'pace', lines: ['会不会出问题……', '我再检查一遍'] },
  anger: { expression: 'angry', animation: 'stomp', lines: ['哼！', '这太过分了！'] },
  guilt: { expression: 'downcast', animation: 'droop', lines: ['对不起……', '是我没做好'] },
  shame: { expression: 'shy', animation: 'hide', lines: ['别看我啦……', '好丢脸'] },
  sadness: { expression: 'sad', animation: 'droop', lines: ['……', '有点低落'] },
  frustration: { expression: 'annoyed', animation: 'sigh', lines: ['唉……', '怎么又错了'] },
  calm: { expression: 'neutral', animation: 'idle', lines: ['在呢。', '嗯。'] },
  contentment: { expression: 'soft', animation: 'idle', lines: ['今天也很棒', '安安静静陪着你'] },
}

/** Persona preset → tone wrapper around the line (six personas, four presets). */
const TONES = {
  'curious-engineer': { prefix: '', suffix: '' },
  'stoic-guardian': { prefix: '（沉稳）', suffix: '' },
  'warm-companion': { prefix: '（软软地）', suffix: '' },
  'restless-artist': { prefix: '（兴奋）', suffix: '' },
}

/** Deterministic line choice: intensity buckets keep the same mood stable. */
const pickLine = (lines, intensity) => lines[Math.min(lines.length - 1, Math.floor(clamp(intensity) * lines.length))]

const round2 = (x) => Math.round(x * 100) / 100

/**
 * Convert brain state into shell hints.
 * @param {object} input
 * @param {string} [input.emotionKey] AffectSystem emotion key
 * @param {number} [input.intensity]
 * @param {number} [input.valence] -1..1
 * @param {number} [input.arousal] 0..1
 * @param {number} [input.dominance] -1..1
 * @param {string} [input.personalityPreset]
 * @param {string} [input.affinityLevel]
 * @param {boolean} [input.working] whether an agent turn is in flight
 */
export const renderHints = ({
  emotionKey = 'calm',
  intensity = 0.2,
  valence = 0,
  arousal = 0.3,
  dominance = 0,
  personalityPreset = 'curious-engineer',
  affinityLevel = '初见',
  working = false,
} = {}) => {
  const proto = EMOTION_EXPRESSIONS[emotionKey] ?? EMOTION_EXPRESSIONS.calm
  const tone = TONES[personalityPreset] ?? TONES['curious-engineer']
  const line = `${tone.prefix}${pickLine(proto.lines, intensity)}${tone.suffix}`
  return {
    emotionKey,
    expression: proto.expression,
    animation: working ? 'work' : proto.animation,
    line,
    voicePitch: round2(clamp(1 + (valence - arousal * 0.5) * 0.2, 0.8, 1.25)),
    face: { valence: round2(valence), arousal: round2(arousal), dominance: round2(dominance) },
    affinityLevel,
    intensity: round2(clamp(intensity)),
  }
}

/** Pet interactions as appraisal events (the brain's input side). */
export const INTERACTION_APPRAISALS = {
  pet: { relevance: 0.4, congruence: 0.5, novelty: 0.1, certainty: 0.8, agency: 0, control: 0.6, norm: 0.3, urgency: 0.1, magnitude: 0.2, cause: '被摸头' },
  feed: { relevance: 0.5, congruence: 0.7, novelty: 0.1, certainty: 0.8, agency: 0, control: 0.5, norm: 0.3, urgency: 0.1, magnitude: 0.3, cause: '被喂食' },
  praise: { relevance: 0.6, congruence: 0.8, novelty: 0.2, certainty: 0.7, agency: 0, control: 0.4, norm: 0.6, urgency: 0.1, magnitude: 0.5, cause: '被夸奖' },
  scold: { relevance: 0.6, congruence: -0.6, novelty: 0.3, certainty: 0.6, agency: 0, control: 0.3, norm: -0.4, urgency: 0.2, magnitude: 0.5, cause: '被批评' },
}

export const INTERACTION_KINDS = Object.keys(INTERACTION_APPRAISALS)
