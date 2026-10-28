/**
 * BM25 lexical retrieval.
 *
 * The semantic layer (SDR + CA3) is strong on paraphrase, but weak on exact
 * tokens: a product name, an error code, a version string. Hybrid retrieval —
 * lexical BM25 fused with the semantic score — is the pattern behind ReMe,
 * Zep/Graphiti and project-brain, and it is dependency-free.
 *
 * The index is rebuilt from the episode texts on load and updated incrementally
 * on encode/prune, so recall never re-tokenizes the whole store.
 */

import { tokenize } from './sdr.js'

const idf = (docCount, df) => Math.log(1 + (docCount - df + 0.5) / (df + 0.5))

export class Bm25Index {
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1
    this.b = b
    this.docs = new Map() // id -> { tokens: Map<token, tf>, length }
    this.df = new Map() // token -> number of docs
    this.docCount = 0
    this.avgLength = 0
  }

  _removeFromDf(tokens) {
    for (const token of tokens.keys()) {
      const count = this.df.get(token) ?? 0
      if (count <= 1) this.df.delete(token)
      else this.df.set(token, count - 1)
    }
  }

  add(id, text) {
    this.remove(id)
    const tokens = tokenize(String(text ?? ''))
    const counts = new Map()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    if (counts.size === 0) return
    for (const token of counts.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1)
    this.docs.set(id, { tokens: counts, length: tokens.length })
    this.docCount = this.docs.size
    this.avgLength = [...this.docs.values()].reduce((sum, doc) => sum + doc.length, 0) / Math.max(this.docCount, 1)
  }

  remove(id) {
    const doc = this.docs.get(id)
    if (!doc) return
    this._removeFromDf(doc.tokens)
    this.docs.delete(id)
    this.docCount = this.docs.size
  }

  /** Score every document; returns a Map id -> score (best first). */
  search(query, { limit = 60 } = {}) {
    const terms = tokenize(String(query ?? ''))
    if (terms.length === 0 || this.docCount === 0) return new Map()
    const scores = new Map()
    const k1 = this.k1
    const b = this.b
    const avg = this.avgLength || 1
    for (const [id, doc] of this.docs) {
      let score = 0
      for (const term of terms) {
        const tf = doc.tokens.get(term)
        if (!tf) continue
        const df = this.df.get(term) ?? 0
        const denominator = tf + k1 * (1 - b + b * (doc.length / avg))
        score += idf(this.docCount, df) * ((tf * (k1 + 1)) / denominator)
      }
      if (score > 0) scores.set(id, score)
    }
    return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit))
  }
}
