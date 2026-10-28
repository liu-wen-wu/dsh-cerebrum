/**
 * Configuration resolution.
 *
 * Precedence: built-in defaults < $DSH_HOME/cerebrum/config.json < row config
 * (from cordis.patch.yml). Unknown keys are preserved so a newer config file
 * does not break an older build, but numeric knobs are clamped to safe ranges.
 */

import path from 'node:path'
import { readJson, resolveHome, workspaceSlug } from './core/storage.js'

export const DEFAULT_CONFIG = {
  enabled: true,
  /** Absolute data directory; empty means $DSH_HOME/cerebrum/<workspace-slug>. */
  dataDir: '',
  personality: {
    preset: 'curious-engineer',
    traits: null,
    values: null,
    /** Slow state->trait drift per turn (0 disables it). */
    drift: 0.001,
  },
  memory: {
    dim: 2048,
    sparsity: 32,
    maxEpisodes: 4000,
    /** ACT-R base-level decay exponent d. */
    baseLevelDecay: 0.5,
    /** CA3 attractor: softmax inverse temperature and settling steps. */
    attractor: {
      beta: 12,
      iterations: 2,
    },
  },
  /** Event segmentation (Zacks et al.): when a turn closes an episode. */
  segmentation: {
    maxTurns: 4,
    gapMs: 10 * 60 * 1000,
    surpriseThreshold: 0.72,
  },
  workingMemory: {
    slots: 4,
  },
  /** Loopback JSON API for the optional client UI (127.0.0.1, read-only). */
  api: {
    enabled: true,
    port: 18734,
  },
  /** Client UI (the brain chip/dashboard). Users who dislike it can switch it off. */
  ui: {
    enabled: true,
  },
  autoCapture: {
    enabled: true,
    maxTextChars: 2000,
    toolResultChars: 300,
    /** Do not encode turns shorter than this many characters. */
    minChars: 6,
  },
  prompt: {
    enabled: true,
    /** Prompt section order: after the persona (0), before tool guidance (100-199). */
    order: 90,
    maxChars: 900,
    recallK: 3,
    /** Resident layer (preferences/schema) character budget. */
    residentMaxChars: 360,
    /** Inject episodic recall only when the best hit beats this confidence. */
    recallThreshold: 0.35,
  },
  affect: {
    moodBias: 0.18,
  },
  consolidation: {
    everyTurns: 12,
    minCluster: 3,
    intervalMs: 30 * 60 * 1000,
  },
  debug: false,
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const merge = (base, patch) => {
  if (!isObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(base[key])) out[key] = merge(base[key], value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

const clampNumber = (value, fallback, lo, hi) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(hi, Math.max(lo, number))
}

export const resolveConfig = (raw, { home = resolveHome(), cwd = process.cwd() } = {}) => {
  // `home`/`cwd` are filesystem locations, not plugin config; accept them both as
  // explicit options and (for convenience) as raw keys.
  const homeDir = typeof raw?.home === 'string' ? raw.home : home
  const cwdDir = typeof raw?.cwd === 'string' ? raw.cwd : cwd
  const fileConfig = readJson(path.join(homeDir, 'cerebrum', 'config.json'), {})
  const merged = merge(merge(DEFAULT_CONFIG, fileConfig), raw)

  merged.enabled = merged.enabled !== false
  merged.personality.drift = clampNumber(merged.personality.drift, DEFAULT_CONFIG.personality.drift, 0, 0.02)
  merged.memory.dim = Math.round(clampNumber(merged.memory.dim, 2048, 256, 8192))
  merged.memory.sparsity = Math.round(clampNumber(merged.memory.sparsity, 32, 8, Math.min(256, merged.memory.dim)))
  merged.memory.maxEpisodes = Math.round(clampNumber(merged.memory.maxEpisodes, 4000, 50, 100000))
  merged.memory.baseLevelDecay = clampNumber(merged.memory.baseLevelDecay, 0.5, 0.1, 1.5)
  merged.memory.attractor.beta = clampNumber(merged.memory.attractor.beta, 12, 2, 40)
  merged.memory.attractor.iterations = Math.round(clampNumber(merged.memory.attractor.iterations, 2, 1, 5))
  merged.segmentation.maxTurns = Math.round(clampNumber(merged.segmentation.maxTurns, 4, 1, 12))
  merged.segmentation.gapMs = clampNumber(merged.segmentation.gapMs, 10 * 60 * 1000, 30e3, 24 * 60 * 60 * 1000)
  merged.segmentation.surpriseThreshold = clampNumber(merged.segmentation.surpriseThreshold, 0.72, 0.2, 1)
  merged.workingMemory.slots = Math.round(clampNumber(merged.workingMemory.slots, 4, 1, 9))
  merged.api.enabled = merged.api.enabled !== false
  merged.api.port = Math.round(clampNumber(merged.api.port, 18734, 1024, 65535))
  merged.ui.enabled = merged.ui.enabled !== false
  merged.autoCapture.maxTextChars = Math.round(clampNumber(merged.autoCapture.maxTextChars, 2000, 200, 20000))
  merged.autoCapture.toolResultChars = Math.round(clampNumber(merged.autoCapture.toolResultChars, 300, 40, 4000))
  merged.autoCapture.minChars = Math.round(clampNumber(merged.autoCapture.minChars, 6, 0, 500))
  merged.prompt.order = clampNumber(merged.prompt.order, 90, -9000, 9000)
  merged.prompt.maxChars = Math.round(clampNumber(merged.prompt.maxChars, 900, 120, 6000))
  merged.prompt.recallK = Math.round(clampNumber(merged.prompt.recallK, 3, 0, 8))
  merged.prompt.residentMaxChars = Math.round(clampNumber(merged.prompt.residentMaxChars, 360, 60, 4000))
  merged.prompt.recallThreshold = clampNumber(merged.prompt.recallThreshold, 0.35, 0, 1)
  merged.affect.moodBias = clampNumber(merged.affect.moodBias, 0.18, 0, 1)
  merged.consolidation.everyTurns = Math.round(clampNumber(merged.consolidation.everyTurns, 12, 1, 500))
  merged.consolidation.minCluster = Math.round(clampNumber(merged.consolidation.minCluster, 3, 2, 12))
  merged.consolidation.intervalMs = clampNumber(merged.consolidation.intervalMs, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000)

  const dir = merged.dataDir && String(merged.dataDir).trim().length > 0
    ? String(merged.dataDir)
    : path.join(homeDir, 'cerebrum', workspaceSlug(cwdDir))
  const fixedDataDir = Boolean((raw && raw.dataDir) || (fileConfig && fileConfig.dataDir))

  return { ...merged, dataDir: dir, fixedDataDir, home: homeDir, cwd: cwdDir }
}

export const configSnapshot = (config) => ({
  enabled: config.enabled,
  dataDir: config.dataDir,
  personality: config.personality.preset,
  memory: { ...config.memory },
  prompt: { ...config.prompt },
  autoCapture: { ...config.autoCapture },
  consolidation: { ...config.consolidation },
})
