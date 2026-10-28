/**
 * Synaptic plasticity rules and temporal-context helpers.
 *
 * Three biologically motivated mechanisms are implemented as pure functions so
 * that the memory store can apply them without owning a simulation loop:
 *
 *   STDP   — a spike is reduced to a "when" (turn/minute); the pairing kernel
 *            exp(-|Δt|/τ) decides whether an association is potentiated or
 *            depressed (Bi & Poo 1998; Pfister & Gerstner 2006).
 *   BCM    — a sliding modification threshold θ_M makes the same postsynaptic
 *            activity potentiate a weak synapse and depress a saturated one
 *            (Bienenstock, Cooper & Munro 1982), which is what keeps the graph
 *            from collapsing into a few hubs.
 *   TCM    — a slowly drifting temporal context is blended with each episode and
 *            reinstated after retrieval, producing contiguity and recency
 *            effects that pure content similarity cannot explain
 *            (Howard & Kahana 2002).
 */

import { clamp } from './math.js'
import { unionCodes } from './assembly.js'

/** STDP pairing kernel. `dtMinutes` > 0 means pre fired before post. */
export const stdpDelta = (dtMinutes, { aPlus = 0.12, aMinus = 0.08, tauMinutes = 45 } = {}) => {
  const dt = Math.abs(Number(dtMinutes) || 0)
  const decay = Math.exp(-dt / Math.max(tauMinutes, 1))
  return dtMinutes >= 0 ? aPlus * decay : -aMinus * decay
}

/** BCM weight change: post activity above θ_M potentiates, below depresses. */
export const bcmDelta = ({ pre = 1, post = 0.5, theta = 0.35, eta = 0.08 } = {}) =>
  eta * pre * post * (post - theta)

/** Sliding threshold update toward the long-run squared postsynaptic activity. */
export const bcmTheta = (theta, averagePost, { tau = 20 } = {}) =>
  theta + (averagePost * averagePost - theta) / Math.max(tau, 1)

/** Synaptic scaling: rescale outgoing weights to a target sum (homeostasis). */
export const synapticScaling = (weights, target = 1) => {
  const sum = weights.reduce((total, weight) => total + weight, 0)
  if (sum <= 0) return weights
  const factor = target / sum
  return weights.map((weight) => clamp(weight * factor, 0, 1))
}

/** Fan effect: a concept with many associates spreads less activation per edge. */
export const fanGain = (fan, { slope = 0.6 } = {}) => 1 / (1 + slope * Math.log1p(Math.max(fan, 0)))

/**
 * Temporal context update: c_t = ρ·c_{t-1} + β·f_t, renormalized by k-WTA.
 *
 * Defaults follow the fitted TCM values (Sederberg et al. 2008): β = 0.6,
 * ρ = 0.8, so ρ² + β² = 1 and the blended vector keeps unit norm before k-WTA.
 */
export const updateContext = (previous, item, { rho = 0.8, beta = 0.6, k = 40 } = {}) => {
  const weighted = []
  if (previous?.size > 0) weighted.push({ code: previous, weight: rho })
  if (item?.size > 0) weighted.push({ code: item, weight: beta })
  if (weighted.length === 0) return item
  return unionCodes(weighted, k)
}

/** Context reinstatement after a successful recall: pull the context toward the trace. */
export const reinstateContext = (current, retrieved, { gamma = 0.35, k = 40 } = {}) =>
  updateContext(current, retrieved, { rho: 1 - gamma, beta: gamma, k })

/**
 * Prioritized replay score (need × gain proxy, Mattar & Daw 2018):
 * value-relevant, affectively charged, rarely revisited, recently formed
 * memories replay first. Uncertainty rises as retrievals stay low.
 */
export const replayPriority = (episode, { now = Date.now(), ageTauDays = 30 } = {}) => {
  const ageDays = Math.max(0, now - episode.at) / 86400000
  const need = 0.4 + Math.abs(episode.affect?.v ?? 0)
  const gain = 1 / (1 + (episode.retrievals ?? 0))
  const recency = Math.exp(-ageDays / ageTauDays)
  return clamp(episode.importance * need * gain * (0.5 + 0.5 * recency))
}

/** Sleep-dependent emotional decoupling: keep the content, fade the charge.
 *  One REM pass ≈ one night; λ = 0.15 gives a ~2-night half-life for affect. */
export const decoupleAffect = (affect, { rate = 0.15 } = {}) => ({
  v: clamp((affect?.v ?? 0) * (1 - rate), -1, 1),
  a: clamp((affect?.a ?? 0) * (1 - rate * 0.5)),
  d: affect?.d ?? 0,
})
