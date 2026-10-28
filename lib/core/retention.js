/**
 * Retention and stability — the forgetting curve used by memory v3.
 *
 * v2 used a pure exponential decay with a half-life. Human retention is better
 * described by a power function (Wixted & Ebbesen 1991; Anderson & Schooler
 * 1991; Rubin & Wenzel 1996): it starts steep and then leaves a long, slowly
 * decaying tail. That tail is what "持久记忆" means computationally — a
 * well-rehearsed trace is never exactly gone, it just becomes hard to reach.
 *
 * The model is the FSRS/DSTM family of schedulers, itself fitted to large
 * spaced-repetition datasets:
 *
 *   R(t, S) = (1 + F·t/S)^(−0.5),  F = 19/81
 *
 *   S  stability, in days: the time at which R falls to ~0.9
 *   D  difficulty, 0..1: how much a successful review is worth
 *
 * Retrieval is not just measurement: it changes S. Retrieving when R is low
 * (effortful, "desirable difficulty") earns a larger stability gain than
 * retrieving when R is high (Bjork & Bjork 2011; Roediger & Karpicke 2006).
 * A lapse shrinks S sharply, which is the model's retroactive/proactive
 * interference term at the single-trace level.
 */

import { clamp } from './math.js'

/** FSRS constant: R(t) = (1 + 19/81 · t/S)^−0.5. */
export const RETENTION_FACTOR = 19 / 81
export const RETENTION_DECAY = 0.5

/** Stability floor/ceiling in days (≈ 10 years). */
export const MIN_STABILITY = 0.25
export const MAX_STABILITY = 3650

/** Probability of recall after `elapsedDays` with stability `stabilityDays`. */
export const retrievability = (elapsedDays, stabilityDays) => {
  const t = Math.max(0, Number(elapsedDays) || 0)
  const s = Math.max(MIN_STABILITY, Number(stabilityDays) || MIN_STABILITY)
  return Math.pow(1 + RETENTION_FACTOR * t / s, -RETENTION_DECAY)
}

/** Elapsed days at which retrievability reaches `target` (for scheduling/reporting). */
export const intervalFor = (stabilityDays, target = 0.9) => {
  const s = Math.max(MIN_STABILITY, Number(stabilityDays) || MIN_STABILITY)
  return (s / RETENTION_FACTOR) * (Math.pow(target, -1 / RETENTION_DECAY) - 1)
}

/**
 * Initial stability from encoding strength. Importance dominates; amygdala
 * salience and schema congruence add on top. Values are in days.
 */
export const initialStability = ({ importance = 0.3, salience = 0.3, schema = false, affect = 0 } = {}) => {
  const base = 0.5 + 20 * importance * importance + 8 * salience + 4 * Math.abs(affect)
  return clamp(base * (schema ? 3 : 1), MIN_STABILITY, MAX_STABILITY)
}

/** Initial difficulty: important, emotionally clear memories are easier to hold. */
export const initialDifficulty = ({ importance = 0.3, errors = 0 } = {}) =>
  clamp(0.7 - 0.35 * importance + 0.15 * Math.min(errors, 2))

/**
 * Stability after a successful retrieval.
 * @param {number} stability current S (days)
 * @param {number} difficulty 0..1
 * @param {number} r retrievability at the moment of retrieval
 */
export const growStability = (stability, difficulty, r) => {
  const spacing = 1 + 1.2 * (1 - r) // effortful retrieval teaches more
  const ease = 1 + 0.4 * (1 - difficulty)
  return clamp(stability * spacing * ease, MIN_STABILITY, MAX_STABILITY)
}

/** Stability after a lapse: a failed retrieval partially resets the trace. */
export const lapseStability = (stability) => clamp(Math.max(0.5, stability * 0.4), MIN_STABILITY, MAX_STABILITY)

/** Difficulty after a review; success on a hard item makes it feel easier. */
export const updateDifficulty = (difficulty, { success = true, r = 0.9 } = {}) =>
  clamp(success ? difficulty - 0.08 * (1 - r) : difficulty + 0.15)

/**
 * Synaptic tagging and capture (Frey & Morris 1997; Redondo & Morris 2011):
 * a weak trace within the tagging window of a strong, plastic event can be
 * promoted into long-term storage. Returns the multiplicative boost.
 */
export const captureBoost = (strongSalience, gapMinutes, { windowMinutes = 90 } = {}) => {
  if (strongSalience < 0.7) return 1
  const distance = Math.abs(gapMinutes)
  if (distance > windowMinutes) return 1
  const proximity = 1 - distance / windowMinutes
  return 1 + 0.9 * strongSalience * proximity
}

/**
 * Retroactive interference: a new, similar trace makes the old one harder to
 * retrieve (Wixted 2004). Schema-protected traces are immune.
 */
export const interferenceFactor = (similarity, { strength = 0.12 } = {}) =>
  clamp(1 - strength * clamp(similarity), 0.5, 1)

/** Vividness: flashbulb-like encoding confidence (Brown & Kulik 1977). */
export const vividnessOf = ({ salience = 0.3, arousal = 0.3, surprise = 0 } = {}) =>
  clamp(0.25 + 0.45 * salience + 0.3 * arousal + 0.2 * surprise)
