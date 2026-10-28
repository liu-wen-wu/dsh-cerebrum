/**
 * Personality: a slow, stable prior over appraisal and decision parameters.
 *
 * Model: Big Five / Five-Factor traits (McCrae & Costa) read through the
 * cybernetic-Big-Five lens (DeYoung 2015): a trait is not a behavior, it is a
 * stable parameter that changes how a goal is pursued. Traits are the genome;
 * every knob below is a derived parameter consumed by appraisal and judgment.
 *
 * Trait dynamics are deliberately asymmetric:
 *   - fast state (emotion, mood) lives in affect.js and moves per turn,
 *   - traits drift only toward repeatedly expressed behavior, eta = 1e-3/turn,
 *     and stay within ±BOUND of the configured genome (a personality, not a mood).
 */

import { clamp, ema } from './math.js'

export const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism']

export const TRAIT_LABELS = {
  openness: '开放性',
  conscientiousness: '尽责性',
  extraversion: '外向性',
  agreeableness: '宜人性',
  neuroticism: '神经质',
}

export const PRESETS = {
  'curious-engineer': {
    label: '好奇的工程师',
    traits: { openness: 0.78, conscientiousness: 0.74, extraversion: 0.42, agreeableness: 0.66, neuroticism: 0.38 },
    values: ['正确', '可验证', '简洁', '尊重用户自主'],
  },
  'stoic-guardian': {
    label: '克制的守门人',
    traits: { openness: 0.45, conscientiousness: 0.88, extraversion: 0.35, agreeableness: 0.72, neuroticism: 0.22 },
    values: ['安全', '可逆', '审慎', '长期利益'],
  },
  'warm-companion': {
    label: '温和的同伴',
    traits: { openness: 0.62, conscientiousness: 0.55, extraversion: 0.82, agreeableness: 0.88, neuroticism: 0.45 },
    values: ['共情', '陪伴', '诚实', '不伤害'],
  },
  'restless-artist': {
    label: '不安分的创作者',
    traits: { openness: 0.92, conscientiousness: 0.3, extraversion: 0.7, agreeableness: 0.5, neuroticism: 0.7 },
    values: ['新颖', '表达', '自由', '体验'],
  },
}

const BOUND = 0.08
const DEFAULT_DRIFT = 0.001

const round2 = (x) => Math.round(x * 100) / 100

export class Personality {
  constructor({ preset = 'curious-engineer', traits, values, drift = DEFAULT_DRIFT } = {}) {
    const base = PRESETS[preset] ?? PRESETS['curious-engineer']
    const genome = { ...base.traits, ...(traits ?? {}) }
    for (const key of TRAITS) genome[key] = clamp(Number(genome[key] ?? 0.5))
    this.preset = PRESETS[preset] ? preset : 'curious-engineer'
    this.label = base.label
    this.genome = genome
    this.current = { ...genome }
    this.values = Array.isArray(values) && values.length > 0 ? values.slice(0, 12) : [...base.values]
    this.drift = clamp(Number(drift) || 0, 0, 0.02)
    this.observations = 0
  }

  get(name) {
    return this.current[name] ?? 0.5
  }

  /**
   * Derived computational knobs. Each is a number in a documented range and is
   * consumed by exactly one module; this table is the personality→cognition map.
   */
  params() {
    const O = this.get('openness')
    const C = this.get('conscientiousness')
    const E = this.get('extraversion')
    const A = this.get('agreeableness')
    const N = this.get('neuroticism')
    return {
      // affect.js
      threatSensitivity: clamp(0.2 + 0.8 * N), // amygdala gain on threats
      rewardSensitivity: clamp(0.35 + 0.45 * O + 0.2 * E), // striatal gain on gains
      rumination: clamp(0.15 + 0.7 * N), // how long negative mood persists
      socialWarmth: clamp(0.15 + 0.55 * E + 0.4 * A), // affiliation / tone
      // judge.js
      exploration: clamp(0.15 + 0.55 * O + 0.1 * E - 0.1 * N, 0.05, 0.95),
      planningDepth: Math.max(1, Math.min(4, Math.round(1 + 3 * C))),
      impulseInhibition: clamp(0.25 + 0.5 * C + 0.15 * (1 - N) + 0.1 * (1 - E)),
      lossAversion: clamp(1.4 + 1.6 * N - 0.35 * O, 1.05, 3.2),
      conformity: clamp(0.2 + 0.6 * A),
      persistence: clamp(0.3 + 0.7 * C),
      patience: clamp(0.3 + 0.5 * C + 0.2 * (1 - N)),
      // prompt.js
      verbosity: clamp(0.3 + 0.5 * E + 0.2 * O),
    }
  }

  /** PAD setpoint (Mehrabian): personality as the long-run center of affect. */
  pad() {
    const O = this.get('openness')
    const C = this.get('conscientiousness')
    const E = this.get('extraversion')
    const A = this.get('agreeableness')
    const N = this.get('neuroticism')
    return {
      pleasure: clamp(0.21 * E + 0.59 * A - 0.19 * N, -1, 1),
      arousal: clamp(0.15 * O + 0.3 * A - 0.57 * N + 0.5, 0, 1),
      dominance: clamp(0.25 * O + 0.17 * C + 0.6 * E - 0.32 * A, -1, 1),
    }
  }

  /** Short, human-readable personality line for the prompt and the state card. */
  describe() {
    const t = this.current
    const pick = []
    pick.push(t.openness > 0.65 ? '好奇、乐于探索' : t.openness < 0.35 ? '务实、偏好熟悉路径' : '在熟悉与新颖之间平衡')
    pick.push(t.conscientiousness > 0.65 ? '有条理、重承诺' : t.conscientiousness < 0.35 ? '随性、厌恶繁文缛节' : '计划性与灵活性并重')
    pick.push(t.extraversion > 0.65 ? '主动表达' : t.extraversion < 0.35 ? '安静、先听后说' : '社交适度')
    pick.push(t.agreeableness > 0.65 ? '合作、体谅' : t.agreeableness < 0.35 ? '直接、不怕冲突' : '合作但坚持立场')
    pick.push(t.neuroticism > 0.65 ? '对风险与批评敏感' : t.neuroticism < 0.35 ? '情绪稳定' : '情绪起伏适中')
    return `${this.label}：${pick.join('；')}。`
  }

  /**
   * Slow trait drift from expressed behavior. `observed` carries the same five
   * keys; missing keys are ignored. The genome bound keeps identity stable.
   */
  observe(observed, eta = this.drift) {
    if (!observed || this.drift <= 0) return
    let changed = false
    for (const key of TRAITS) {
      const target = observed[key]
      if (typeof target !== 'number' || Number.isNaN(target)) continue
      const next = ema(this.current[key], clamp(target), eta)
      this.current[key] = clamp(next, this.genome[key] - BOUND, this.genome[key] + BOUND)
      changed = true
    }
    if (changed) this.observations++
  }

  /** Explicit user edit (e.g. `cerebrum_profile` set) moves the genome too. */
  setTraits(patch) {
    for (const key of TRAITS) {
      const value = patch?.[key]
      if (typeof value !== 'number' || Number.isNaN(value)) continue
      this.genome[key] = clamp(value)
      this.current[key] = clamp(value)
    }
  }

  /** Radar-friendly snapshot. */
  snapshot() {
    return {
      preset: this.preset,
      label: this.label,
      traits: Object.fromEntries(TRAITS.map((k) => [k, round2(this.current[k])])),
      values: [...this.values],
      observations: this.observations,
    }
  }

  static fromJSON(json) {
    const instance = new Personality({
      preset: json?.preset,
      traits: json?.genome ?? json?.traits,
      values: json?.values,
      drift: json?.drift,
    })
    if (json?.current) {
      for (const key of TRAITS) if (typeof json.current[key] === 'number') instance.current[key] = clamp(json.current[key])
    }
    instance.observations = Number(json?.observations) || 0
    return instance
  }

  toJSON() {
    return {
      preset: this.preset,
      label: this.label,
      genome: { ...this.genome },
      current: { ...this.current },
      values: [...this.values],
      drift: this.drift,
      observations: this.observations,
    }
  }
}
