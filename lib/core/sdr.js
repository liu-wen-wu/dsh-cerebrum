/**
 * Sparse distributed representations (SDR) — the "neuronal" layer.
 *
 * Text is turned into a high-dimensional, sparse binary-ish code:
 *   tokens -> hashed dendritic addresses -> k-winner-take-all assembly.
 * Two properties matter for the cognitive architecture:
 *   - pattern separation: unrelated inputs barely overlap (dentate gyrus),
 *   - pattern completion: a partial cue still overlaps the stored assembly (CA3),
 *     which is what makes cue-based recall work without an embedding service.
 *
 * The encoder is deterministic and dependency-free; the same text always yields
 * the same code, so a memory can be rebuilt from its stored text after a restart.
 */

const HAN = /\p{Script=Han}/u
const LATIN = /[\p{Script=Latin}\p{N}_-]+/gu

const STOPWORDS = new Set([
  // Chinese function words (single characters are cheap to filter)
  '的', '了', '和', '与', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也', '而', '及', '或',
  '被', '把', '让', '给', '对', '从', '到', '为', '以', '于', '之', '其', '着', '过', '很', '更', '最', '不', '没', '有',
  '个', '些', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '请', '帮', '会', '要', '能', '可', '再', '又', '还', '就',
  '用', '做', '看', '说', '想', '去', '来', '好', '多', '少', '大', '小', '上', '下', '里', '外', '前', '后', '中', '把', '给',
  // English stopwords
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been',
  'it', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'they', 'we', 'me', 'my', 'your', 'our', 'their',
  'as', 'at', 'by', 'from', 'not', 'no', 'yes', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'just',
  'have', 'has', 'had', 'but', 'if', 'then', 'than', 'so', 'such', 'there', 'here', 'about', 'into', 'over', 'under',
])

/** FNV-1a 32-bit. Stable across processes and platforms. */
export const hash32 = (input) => {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Split a string into weighted lexical tokens (words + CJK unigrams/bigrams). */
export const tokenize = (text) => {
  const tokens = []
  if (typeof text !== 'string' || text.length === 0) return tokens
  const normalized = text.normalize('NFKC').replace(/[\u200b-\u200f\uFEFF]/g, ' ')

  // Latin / numeric runs, plus adjacent word bigrams for local order.
  const words = []
  for (const match of normalized.matchAll(LATIN)) {
    const word = match[0].toLowerCase()
    if (word.length < 2 || STOPWORDS.has(word)) continue
    words.push(word)
    if (word.length > 6) tokens.push(word.slice(0, 6)) // light stemming for inflections
  }
  for (let i = 0; i < words.length; i++) {
    tokens.push(words[i])
    if (i > 0) tokens.push(`${words[i - 1]}_${words[i]}`)
  }

  // CJK runs: unigrams (content only), bigrams, and trigrams (word order).
  const runs = normalized.match(/\p{Script=Han}+/gu) ?? []
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      const ch = run[i]
      if (!STOPWORDS.has(ch) && HAN.test(ch)) tokens.push(ch)
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
      if (i + 2 < run.length) tokens.push(run.slice(i, i + 3))
    }
  }
  return tokens
}

const tokenWeight = (token) => {
  const lengthBonus = 1 + 0.18 * Math.min(token.length, 6)
  return lengthBonus
}

/**
 * One sparse code: parallel arrays of active dimensions and their weights.
 * @typedef {{idx: number[], w: number[], norm: number, size: number}} Code
 */

export class SdrEncoder {
  constructor({ dim = 2048, k = 32 } = {}) {
    if (!Number.isInteger(dim) || dim < 64) throw new Error('SdrEncoder: dim must be an integer >= 64')
    if (!Number.isInteger(k) || k < 4 || k > dim) throw new Error('SdrEncoder: k must be an integer in [4, dim]')
    this.dim = dim
    this.k = k
    this._scores = new Float64Array(dim)
    this._touched = []
  }

  /** Indices contributed by one token (deterministic, sparse fan-out). */
  _addresses(token) {
    const h1 = hash32(token)
    const h2 = (hash32(`${token}\u0001seq`) | 1) >>> 0
    const out = new Array(6)
    for (let i = 0; i < 6; i++) out[i] = (h1 + Math.imul(i, h2)) % this.dim
    return out
  }

  /**
   * Encode text into a sparse code.
   * @param {string} text
   * @param {{extraTokens?: string[], boost?: Map<string, number>}} [options]
   * @returns {Code}
   */
  encode(text, options = {}) {
    const tokens = tokenize(text)
    if (Array.isArray(options.extraTokens)) {
      for (const t of options.extraTokens) if (typeof t === 'string' && t.length > 0) tokens.push(t.toLowerCase())
    }
    if (tokens.length === 0) return { idx: [], w: [], norm: 0, size: 0 }

    const scores = this._scores
    const touched = this._touched
    for (const token of tokens) {
      const weight = tokenWeight(token) * (options.boost?.get(token) ?? 1)
      for (const idx of this._addresses(token)) {
        if (scores[idx] === 0) touched.push(idx)
        scores[idx] += weight
      }
    }

    const touchedCount = touched.length
    touched.sort((a, b) => scores[b] - scores[a] || a - b)
    const take = Math.min(this.k, touchedCount)
    const idx = new Array(take)
    const w = new Array(take)
    let norm = 0
    for (let i = 0; i < take; i++) {
      const dim = touched[i]
      idx[i] = dim
      w[i] = scores[dim]
      norm += w[i] * w[i]
    }
    // Reset *every* touched accumulator, including the losers of k-WTA; leaving
    // residue would leak one text's activation into the next encode.
    for (let i = 0; i < touchedCount; i++) scores[touched[i]] = 0
    touched.length = 0
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < take; i++) w[i] /= norm
    return { idx, w, norm: 1, size: take }
  }

  /** Cosine similarity between two sparse codes, in [0, 1] for non-negative weights. */
  similarity(a, b) {
    if (!a || !b || a.size === 0 || b.size === 0) return 0
    const small = a.size <= b.size ? a : b
    const large = small === a ? b : a
    const lookup = new Map()
    for (let i = 0; i < large.size; i++) lookup.set(large.idx[i], large.w[i])
    let dot = 0
    for (let i = 0; i < small.size; i++) {
      const other = lookup.get(small.idx[i])
      if (other !== undefined) dot += small.w[i] * other
    }
    return Math.max(0, Math.min(1, dot))
  }

  /** Most informative tokens, used as human-readable concept handles. */
  topTokens(text, limit = 8) {
    const counts = new Map()
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1)
    return [...counts.entries()]
      .map(([token, count]) => [token, count * tokenWeight(token)])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([token]) => token)
  }
}

export const STOPWORD_SET = STOPWORDS
