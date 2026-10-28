/**
 * Attractor memory — the CA3 recurrent network, in its modern Hopfield form.
 *
 * Stored sparse codes are the fixed points. A partial cue is iterated to a
 * nearby stored pattern with the update rule of Ramsauer et al. (2021):
 *
 *     ξ ← X · softmax(β · Xᵀ ξ)
 *
 * In sparse form the matrix product becomes a weighted union of a small
 * candidate set followed by k-WTA, so one retrieval costs O(M·k) rather than
 * O(N²). Biologically this is recurrent collateral excitation with feedback
 * inhibition settling into a cell assembly; computationally it is pattern
 * completion that, unlike plain cosine similarity, can recover a memory from a
 * cue that shares only part of its code.
 *
 * `SpikingAssembly` is a small LIF network used by the neuron demo and tests to
 * show the same completion at spike level. It is deliberately not on the hot
 * path: the rate-coded attractor above is the production mechanism.
 */

import { clamp } from './math.js'

/** Weighted union of sparse codes, normalized to unit L2. */
export const unionCodes = (weighted, k) => {
  const scores = new Map()
  for (const { code, weight } of weighted) {
    if (!code || weight <= 0) continue
    for (let i = 0; i < code.size; i++) {
      const dim = code.idx[i]
      scores.set(dim, (scores.get(dim) ?? 0) + code.w[i] * weight)
    }
  }
  const entries = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, k)
  const idx = entries.map(([dim]) => dim)
  const w = entries.map(([, value]) => value)
  const norm = Math.sqrt(w.reduce((sum, value) => sum + value * value, 0)) || 1
  return { idx, w: w.map((value) => value / norm), norm: 1, size: idx.length }
}

export const codeDot = (a, b) => {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  const small = a.size <= b.size ? a : b
  const large = small === a ? b : a
  const lookup = new Map()
  for (let i = 0; i < large.size; i++) lookup.set(large.idx[i], large.w[i])
  let dot = 0
  for (let i = 0; i < small.size; i++) {
    const value = lookup.get(small.idx[i])
    if (value !== undefined) dot += small.w[i] * value
  }
  return dot
}

export class AttractorMemory {
  /**
   * @param {{beta?: number, iterations?: number, k?: number, convergence?: number}} options
   */
  constructor({ beta = 12, iterations = 2, k = 40, convergence = 0.995 } = {}) {
    this.beta = beta
    this.iterations = iterations
    this.k = k
    this.convergence = convergence
    this.stats = { completions: 0, iterations: 0 }
  }

  /** Modern Hopfield energy of a cue against a pattern set (lower = deeper basin). */
  energy(cue, patterns) {
    if (patterns.length === 0) return 0
    const sims = patterns.map((pattern) => codeDot(cue, pattern.code))
    const max = Math.max(...sims)
    let sum = 0
    for (const sim of sims) sum += Math.exp(this.beta * (sim - max))
    return -(max + Math.log(sum) / this.beta)
  }

  /**
   * Settle a cue into the nearest stored assembly.
   * @param {object} cue sparse code
   * @param {Array<{id: string, code: object}>} patterns candidate patterns
   * @returns {{code: object, winners: Array<{id: string, weight: number}>, iterations: number, gain: number, converged: boolean}}
   */
  complete(cue, patterns) {
    if (!cue || cue.size === 0 || patterns.length === 0) return { code: cue, winners: [], iterations: 0, gain: 0, converged: false }
    let xi = cue
    let iterations = 0
    let converged = false
    let winners = []
    for (let step = 0; step < this.iterations; step++) {
      iterations++
      const sims = patterns.map((pattern) => codeDot(xi, pattern.code))
      const max = Math.max(...sims)
      let sum = 0
      const weights = sims.map((sim) => {
        const value = Math.exp(this.beta * (sim - max))
        sum += value
        return value
      })
      const weighted = []
      winners = []
      for (let i = 0; i < patterns.length; i++) {
        const weight = weights[i] / (sum || 1)
        if (weight < 1e-4) continue
        weighted.push({ code: patterns[i].code, weight })
        winners.push({ id: patterns[i].id, weight: Number(weight.toFixed(4)) })
      }
      const next = unionCodes(weighted, this.k)
      const change = codeDot(xi, next)
      xi = next
      if (change > this.convergence) {
        converged = true
        break
      }
    }
    winners.sort((a, b) => b.weight - a.weight)
    this.stats.completions++
    this.stats.iterations += iterations
    return {
      code: xi,
      winners: winners.slice(0, 5),
      iterations,
      gain: Number(clamp(codeDot(xi, cue) > 0 ? (1 - codeDot(xi, cue)) : 0).toFixed(3)),
      converged,
    }
  }
}

/**
 * Leaky integrate-and-fire assembly with spike-timing dependent plasticity.
 *
 * Diagnostic model: the same k-WTA codes are injected as current into a
 * recurrent population; the network is expected to settle into the learned
 * assembly from a partial cue. Used by `examples/neuron-demo.mjs` and one test,
 * not by the recall hot path.
 */
export class SpikingAssembly {
  constructor({ size = 256, threshold = 0.8, leak = 0.88, reset = 0.1, refractory = 2, dt = 1 } = {}) {
    this.size = size
    this.threshold = threshold
    this.leak = leak
    this.reset = reset
    this.refractorySteps = refractory
    this.dt = dt
    this.potential = new Float64Array(size)
    this.refractory = new Int32Array(size)
    this.weights = new Map() // "pre\u0001post" -> weight
    this.trace = new Float64Array(size)
    this.traceTau = 4
  }

  _key(pre, post) {
    return `${pre}\u0001${post}`
  }

  weight(pre, post) {
    return this.weights.get(this._key(pre, post)) ?? 0
  }

  /** Hebbian/STDP training: neurons firing together or in sequence strengthen. */
  train(indices, { ltp = 0.35, ltd = 0.02 } = {}) {
    for (let i = 0; i < indices.length; i++) {
      for (let j = 0; j < indices.length; j++) {
        if (i === j) continue
        const pre = indices[i]
        const post = indices[j]
        const key = this._key(pre, post)
        const current = this.weights.get(key) ?? 0
        const delta = i < j ? ltp : -ltd
        this.weights.set(key, clamp(current + delta * (1 - current), 0, 1))
      }
    }
  }

  /** Feed a partial cue; return the set of neurons that fired. */
  settle(cueIndices, { steps = 15, injection = 1.2 } = {}) {
    this.potential.fill(0)
    this.refractory.fill(0)
    this.trace.fill(0)
    const fired = new Set()
    const cue = [...new Set(cueIndices)].filter((index) => index >= 0 && index < this.size)
    let previous = []
    for (let step = 0; step < steps; step++) {
      for (const index of cue) this.potential[index] += injection * (step === 0 ? 1 : 0.35)
      const current = []
      for (let neuron = 0; neuron < this.size; neuron++) {
        if (this.refractory[neuron] > 0) {
          this.refractory[neuron]--
          continue
        }
        let input = 0
        for (const pre of previous) input += this.weight(pre, neuron)
        this.potential[neuron] = this.potential[neuron] * this.leak + input * 0.5
        if (this.potential[neuron] >= this.threshold) {
          this.potential[neuron] = this.reset
          this.refractory[neuron] = this.refractorySteps
          this.trace[neuron] = 1
          current.push(neuron)
          fired.add(neuron)
        }
      }
      previous = current
      if (step > 4 && current.length === 0) break
    }
    return { fired: [...fired].sort((a, b) => a - b), steps }
  }
}
