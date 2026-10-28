/**
 * Memory v2: hippocampal episodes + cortical concepts + a plastic directed graph,
 * with three additions over v1 that are directly motivated by the neuroscience:
 *
 *   1. Temporal context (TCM, Howard & Kahana 2002). Every episode stores a
 *      drifting context code c_t = ρ·c_{t-1} + β·f_t; retrieval matches both
 *      content and context, and a successful recall reinstates the retrieved
 *      context. This produces contiguity (neighbouring events come back
 *      together) and a recency gradient that pure cosine similarity lacks.
 *
 *   2. CA3 pattern completion (modern Hopfield, Ramsauer et al. 2021). A partial
 *      cue is settled by ξ ← X·softmax(β·Xᵀξ) restricted to a candidate set and
 *      followed by k-WTA. Recall scores the *completed* code, so a cue sharing
 *      only part of an assembly still retrieves it.
 *
 *   3. Plastic directed associations (STDP + BCM + fan normalization + synaptic
 *      scaling). Co-activation writes a→b and a weaker b→a; events close in time
 *      potentiate a forward association through an exponential STDP kernel; a
 *      sliding BCM threshold and fan gain stop a few hubs from owning the graph.
 *
 * Consolidation now runs a NREM pass (prioritized replay → schema extraction)
 * and a REM pass (loose associative edges + emotional decoupling), and
 * `reconsolidate()` lets a contradicted memory be updated rather than duplicated.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { AttractorMemory, codeDot } from './assembly.js'
import { Bm25Index } from './bm25.js'
import { clamp, gaussian, makeRng } from './math.js'
import {
  bcmTheta,
  decoupleAffect,
  fanGain,
  reinstateContext,
  replayPriority,
  stdpDelta,
  synapticScaling,
  updateContext,
} from './plasticity.js'
import {
  captureBoost,
  growStability,
  initialDifficulty,
  initialStability,
  interferenceFactor,
  lapseStability,
  retrievability,
  updateDifficulty,
} from './retention.js'
import { ensureDir, JsonlLog, readJson, writeJson } from './storage.js'

const DAY = 24 * 60 * 60 * 1000

let counter = 0
const nextId = (now) => `ep_${now.toString(36)}_${(counter++).toString(36)}`

const round3 = (x) => Math.round(x * 1000) / 1000
const truncate = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)

/**
 * Concept handles should be phrases, not single characters: a bigram such as
 * “迁移” or “对比度” is a far better graph node than “用”. Fall back to unigrams
 * only when a text has almost no multi-character tokens.
 */
const selectConcepts = (encoder, text, limit = 8) => {
  const tokens = encoder.topTokens(text, limit * 3)
  const picked = tokens.filter((token) => token.length >= 2).slice(0, limit)
  if (picked.length < Math.min(3, limit)) {
    for (const token of tokens) {
      if (picked.length >= limit) break
      if (!picked.includes(token)) picked.push(token)
    }
  }
  return picked
}

export class MemoryStore {
  constructor({ dir, encoder, maxEpisodes = 4000, baseLevelDecay = 0.5, attractor, now = Date.now() } = {}) {
    if (!dir) throw new Error('MemoryStore requires a directory')
    if (!encoder) throw new Error('MemoryStore requires an SdrEncoder')
    this.dir = dir
    this.encoder = encoder
    this.maxEpisodes = maxEpisodes
    this.baseLevelDecay = baseLevelDecay
    this.now = now
    this.episodes = []
    this.byId = new Map()
    this.conceptIndex = new Map()
    this.concepts = new Map()
    this.edges = new Map() // "a\u0001b" -> { w, count, at } (directed)
    this.adjacency = new Map() // concept -> Map<neighbor, weight> (directed)
    this.episodeLog = new JsonlLog(path.join(dir, 'episodes.jsonl'))
    this.reviewLog = new JsonlLog(path.join(dir, 'reviews.jsonl'))
    this.receiptLog = new JsonlLog(path.join(dir, 'receipts.jsonl'))
    this.forgetLog = new JsonlLog(path.join(dir, 'forgot.jsonl'))
    this.skills = readJson(path.join(dir, 'skills.json'), [])
    this.dirty = false
    this.prevContext = null
    this.attractor = new AttractorMemory({ beta: attractor?.beta ?? 12, iterations: attractor?.iterations ?? 2, k: encoder.k })
    this.bm25 = new Bm25Index()
    this.transitions = new Map() // concept -> Map<nextConcept, count> (HTM temporal memory)
    this.lastConcepts = []
    this.stats = { encoded: 0, recalls: 0, consolidated: 0, pruned: 0, completions: 0, reconsolidations: 0, captures: 0, interferences: 0, forgotten: 0, receipts: this.receiptLog.items.length }
  }

  // ---- lifecycle -----------------------------------------------------------

  load() {
    const concepts = readJson(path.join(this.dir, 'concepts.json'), {})
    for (const [name, value] of Object.entries(concepts ?? {})) {
      this.concepts.set(name, {
        strength: clamp(Number(value?.strength ?? 0.5)),
        count: Number(value?.count ?? 1),
        lastAt: Number(value?.lastAt ?? Date.now()),
        gist: typeof value?.gist === 'string' ? value.gist : '',
        lessons: Array.isArray(value?.lessons) ? value.lessons.slice(0, 5) : [],
        theta: clamp(Number(value?.theta ?? 0.25)),
        hot: clamp(Number(value?.hot ?? 0)),
        history: Array.isArray(value?.history) ? value.history.slice(-20) : [],
        schema: value?.schema === true,
      })
    }
    const edges = readJson(path.join(this.dir, 'edges.json'), {})
    for (const [key, value] of Object.entries(edges ?? {})) {
      const [a, b] = key.split('\u0001')
      if (!a || !b) continue
      this.edges.set(key, { w: clamp(Number(value?.w ?? 0.2), 0, 1), count: Number(value?.count ?? 1), at: Number(value?.at ?? Date.now()) })
    }
    this._migrateUndirectedEdges()
    this._rebuildAdjacency()

    this.episodes = this.episodeLog.items.map((raw) => this._hydrate(raw)).filter(Boolean)
    this.byId = new Map(this.episodes.map((ep) => [ep.id, ep]))
    for (const ep of this.episodes) this.bm25.add(ep.id, ep.text)
    this._rebuildConceptIndex()
    this._replayReviews()
    // Rebuild the temporal-memory transitions from the chronological episode order.
    let prev = []
    for (const ep of this.episodes) {
      this.learnTransition(prev, ep.concepts)
      prev = ep.concepts
    }
    this.lastConcepts = this.episodes.at(-1)?.concepts ?? []
    const latest = this.episodes.at(-1)
    this.prevContext = latest?.context ?? latest?.code ?? null
    return this
  }

  /**
   * Reviews (retrieval practice, lapses, interference, capture) are append-only
   * events, not rewrites of the episode log: a recall at 2 a.m. must survive a
   * restart without rewriting 4000 episodes.
   */
  _replayReviews() {
    for (const record of this.reviewLog.items) {
      const ep = this.byId.get(record?.id)
      if (!ep) continue
      if (Number.isFinite(record.S)) ep.stability = Math.max(0.25, Number(record.S))
      if (Number.isFinite(record.D)) ep.difficulty = clamp(Number(record.D))
      if (Number.isFinite(record.last)) ep.lastReviewAt = Number(record.last)
      if (Number.isFinite(record.n)) ep.retrievals = Number(record.n)
      if (Number.isFinite(record.last) && !ep.accesses.includes(Number(record.last))) ep.accesses.push(Number(record.last))
      if (Number.isFinite(record.lapses)) ep.lapses = Number(record.lapses)
      if (record.schema === true) ep.schema = true
      if (record.tagged === true) ep.tagged = true
    }
  }

  _recordReview(ep, reason, now = Date.now()) {
    this.reviewLog.append({
      id: ep.id,
      at: now,
      S: round3(ep.stability),
      D: round3(ep.difficulty),
      last: ep.lastReviewAt,
      lapses: ep.lapses,
      n: ep.retrievals,
      ...(ep.schema ? { schema: true } : {}),
      ...(ep.tagged ? { tagged: true } : {}),
      reason,
    })
  }

  /** v1 stored one undirected key per pair; v2 reads it as a→b and adds b→a weaker. */
  _migrateUndirectedEdges() {
    let migrated = 0
    for (const [key, edge] of [...this.edges]) {
      const [a, b] = key.split('\u0001')
      const reverse = `${b}\u0001${a}`
      if (this.edges.has(reverse)) continue
      this.edges.set(reverse, { w: edge.w * 0.6, count: edge.count, at: edge.at })
      migrated++
    }
    if (migrated > 0) this.dirty = true
  }

  _hydrate(raw) {
    if (!raw || typeof raw.text !== 'string') return null
    const code = raw.code && Array.isArray(raw.code.idx) && raw.code.idx.length > 0
      ? { idx: raw.code.idx.map(Number), w: raw.code.w.map(Number), norm: 1, size: raw.code.idx.length }
      : this.encoder.encode(raw.text)
    const context = raw.context && Array.isArray(raw.context.idx) && raw.context.idx.length > 0
      ? { idx: raw.context.idx.map(Number), w: raw.context.w.map(Number), norm: 1, size: raw.context.idx.length }
      : code
    return {
      id: String(raw.id ?? nextId(Number(raw.at) || Date.now())),
      at: Number(raw.at) || Date.now(),
      sessionId: raw.sessionId ? String(raw.sessionId) : null,
      turn: Number.isFinite(raw.turn) ? raw.turn : null,
      segments: Array.isArray(raw.segments) ? raw.segments.map(Number) : [],
      kind: raw.kind === 'semantic' || raw.kind === 'explicit' ? raw.kind : 'episodic',
      text: raw.text,
      summary: typeof raw.summary === 'string' && raw.summary.length > 0 ? raw.summary : truncate(raw.text, 160),
      concepts: Array.isArray(raw.concepts) ? raw.concepts.filter((c) => typeof c === 'string').slice(0, 16) : [],
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string').slice(0, 12) : [],
      affect: {
        v: clamp(Number(raw.affect?.v ?? 0), -1, 1),
        a: clamp(Number(raw.affect?.a ?? 0.3)),
        d: clamp(Number(raw.affect?.d ?? 0)),
      },
      importance: clamp(Number(raw.importance ?? 0.3)),
      salience: clamp(Number(raw.salience ?? 0.3)),
      strength: clamp(Number(raw.strength ?? 0.5)),
      accesses: Array.isArray(raw.accesses) && raw.accesses.length > 0 ? raw.accesses.map(Number).slice(-20) : [Number(raw.at) || Date.now()],
      retrievals: Number(raw.retrievals ?? 0),
      lastAccess: Number(raw.lastAccess ?? raw.at) || Date.now(),
      consolidated: raw.consolidated === true,
      source: typeof raw.source === 'string' ? raw.source : 'turn',
      links: Array.isArray(raw.links) ? raw.links.filter((id) => typeof id === 'string').slice(0, 8) : [],
      outcome: raw.outcome && typeof raw.outcome === 'object' ? { success: raw.outcome.success === true, errors: Number(raw.outcome.errors ?? 0) } : null,
      schema: raw.schema === true,
      replayCount: Number(raw.replayCount ?? 0),
      reconsolidations: Number(raw.reconsolidations ?? 0),
      stability: Number.isFinite(raw.stability)
        ? Math.max(0.25, Number(raw.stability))
        : initialStability({ importance: Number(raw.importance ?? 0.3), salience: Number(raw.salience ?? 0.3) }),
      difficulty: clamp(Number(raw.difficulty ?? initialDifficulty({ importance: Number(raw.importance ?? 0.3) }))),
      vividness: clamp(Number(raw.vividness ?? raw.salience ?? 0.3)),
      lapses: Number(raw.lapses ?? 0),
      interferences: Number(raw.interferences ?? 0),
      lastReviewAt: Number(raw.lastReviewAt ?? raw.lastAccess ?? raw.at) || Date.now(),
      tagged: raw.tagged === true,
      resident: raw.resident === true,
      rawSeqs: Array.isArray(raw.rawSeqs) ? raw.rawSeqs.map(Number).filter(Number.isFinite).slice(0, 8) : [],
      context,
      code,
    }
  }

  _serialize(ep) {
    return {
      id: ep.id,
      at: ep.at,
      sessionId: ep.sessionId,
      turn: ep.turn,
      segments: ep.segments,
      kind: ep.kind,
      text: ep.text,
      summary: ep.summary,
      concepts: ep.concepts,
      tags: ep.tags,
      affect: ep.affect,
      importance: ep.importance,
      salience: ep.salience,
      strength: ep.strength,
      accesses: ep.accesses,
      retrievals: ep.retrievals,
      lastAccess: ep.lastAccess,
      consolidated: ep.consolidated,
      source: ep.source,
      links: ep.links,
      outcome: ep.outcome,
      schema: ep.schema,
      replayCount: ep.replayCount,
      reconsolidations: ep.reconsolidations,
      stability: round3(ep.stability),
      difficulty: round3(ep.difficulty),
      vividness: round3(ep.vividness),
      lapses: ep.lapses,
      interferences: ep.interferences,
      lastReviewAt: ep.lastReviewAt,
      tagged: ep.tagged,
      resident: ep.resident,
      rawSeqs: ep.rawSeqs,
      context: { idx: ep.context.idx, w: ep.context.w.map((x) => round3(x)) },
      code: { idx: ep.code.idx, w: ep.code.w.map((x) => round3(x)) },
    }
  }

  _rebuildConceptIndex() {
    this.conceptIndex = new Map()
    for (const ep of this.episodes) {
      for (const concept of ep.concepts) {
        let bucket = this.conceptIndex.get(concept)
        if (!bucket) this.conceptIndex.set(concept, (bucket = new Set()))
        bucket.add(ep.id)
      }
    }
  }

  _rebuildAdjacency() {
    this.adjacency = new Map()
    for (const [key, edge] of this.edges) {
      const [a, b] = key.split('\u0001')
      if (!a || !b) continue
      if (!this.adjacency.has(a)) this.adjacency.set(a, new Map())
      this.adjacency.get(a).set(b, edge.w)
    }
  }

  flush() {
    ensureDir(this.dir)
    if (this.dirty) {
      this.episodeLog.rewrite(this.episodes.map((ep) => this._serialize(ep)))
      this.dirty = false
    }
    const concepts = {}
    for (const [name, node] of this.concepts) concepts[name] = node
    writeJson(path.join(this.dir, 'concepts.json'), concepts)
    const edges = {}
    for (const [key, edge] of this.edges) edges[key] = edge
    writeJson(path.join(this.dir, 'edges.json'), edges)
    writeJson(path.join(this.dir, 'skills.json'), this.skills)
    // Compact the review event log once it dwarfs the episode count.
    if (this.reviewLog.items.length > Math.max(2000, this.episodes.length * 4)) {
      const latest = new Map()
      for (const record of this.reviewLog.items) if (record?.id) latest.set(record.id, record)
      this.reviewLog.rewrite([...latest.values()])
    }
  }

  // ---- encoding ------------------------------------------------------------

  /**
   * @param {object} input
   * @param {import('./sdr.js').Code} [input.contextCode] session-level TCM context
   */
  encodeEpisode(input) {
    const at = Number(input.at) || Date.now()
    const text = truncate(String(input.text ?? '').trim(), 4000)
    if (text.length === 0) throw new Error('cannot encode an empty episode')
    const concepts = (input.concepts?.length ? input.concepts : selectConcepts(this.encoder, text, 8))
      .map((c) => String(c).toLowerCase())
      .filter((c) => c.length > 1 || /[\p{Script=Han}]/u.test(c))
      .slice(0, 10)

    const code = this.encoder.encode(text)
    const context = input.contextCode?.size > 0 ? input.contextCode : updateContext(this.prevContext, code, { k: this.encoder.k })
    const summary = truncate(String(input.summary ?? '').trim() || text, 240)
    const importance = clamp(Number(input.importance ?? 0.3))
    const salience = clamp(Number(input.salience ?? 0.3))
    const strength = clamp(0.35 + 0.35 * salience + 0.3 * importance, 0.1, 1)
    const episodeAffect = { v: clamp(Number(input.affect?.v ?? 0), -1, 1), a: clamp(Number(input.affect?.a ?? 0.3)), d: clamp(Number(input.affect?.d ?? 0)) }

    const episode = {
      id: nextId(at),
      at,
      sessionId: input.sessionId ? String(input.sessionId) : null,
      turn: Number.isFinite(input.turn) ? input.turn : null,
      segments: Array.isArray(input.segments) ? input.segments.map(Number) : [],
      kind: input.kind === 'semantic' || input.kind === 'explicit' ? input.kind : 'episodic',
      text,
      summary,
      concepts,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [],
      affect: episodeAffect,
      importance,
      salience,
      strength,
      accesses: [at],
      retrievals: 0,
      lastAccess: at,
      consolidated: false,
      source: typeof input.source === 'string' ? input.source : 'turn',
      links: [],
      outcome: input.outcome && typeof input.outcome === 'object' ? { success: input.outcome.success === true, errors: Number(input.outcome.errors ?? 0) } : null,
      schema: false,
      replayCount: 0,
      reconsolidations: 0,
      stability: initialStability({ importance, salience, affect: Math.abs(episodeAffect.v) }),
      difficulty: initialDifficulty({ importance, errors: Number(input.outcome?.errors ?? 0) }),
      vividness: clamp(0.25 + 0.45 * salience + 0.3 * episodeAffect.a + 0.2 * Number(input.surprise ?? 0)),
      lapses: 0,
      interferences: 0,
      lastReviewAt: at,
      tagged: false,
      resident: input.resident === true,
      rawSeqs: Array.isArray(input.rawSeqs) ? input.rawSeqs.map(Number).filter(Number.isFinite).slice(0, 8) : [],
      context,
      code,
    }

    // Episodic associations: link the most similar existing episodes (pattern completion path).
    const recent = this.episodes.slice(-80)
    const similar = recent
      .map((ep) => ({ ep, sim: this.encoder.similarity(code, ep.code) }))
      .filter(({ sim }) => sim > 0.35)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3)
    episode.links = similar.map(({ ep }) => ep.id)

    this.episodes.push(episode)
    this.byId.set(episode.id, episode)
    this.episodeLog.append(this._serialize(episode))
    this.bm25.add(episode.id, text)

    // Interference and behavioral tagging both act on *other* traces, so they run
    // after this one is durable.
    this._applyInterference(episode, similar, at)
    this._captureTagged(episode, at)

    // Ordered co-activation: early→late is potentiated more than late→early.
    const post = clamp(0.35 + 0.5 * importance + 0.2 * salience)
    const eta = 0.06 + 0.1 * importance

    for (const concept of concepts) {
      let bucket = this.conceptIndex.get(concept)
      if (!bucket) this.conceptIndex.set(concept, (bucket = new Set()))
      bucket.add(episode.id)
      const node = this.concepts.get(concept) ?? { strength: 0.35, count: 0, lastAt: at, gist: '', lessons: [], theta: 0.25, hot: 0, history: [], schema: false }
      node.count += 1
      node.strength = clamp(node.strength + 0.12 * (0.5 + importance))
      node.lastAt = at
      // BCM sliding threshold: tracks the squared postsynaptic activity (τ_θ ≈ 20 events).
      node.theta = bcmTheta(node.theta, post, { tau: 20 })
      this.concepts.set(concept, node)
    }

    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const distance = j - i
        const gain = Math.exp(-(distance - 1) / 4)
        this._strengthenEdge(concepts[i], concepts[j], eta * gain, at, post)
        this._strengthenEdge(concepts[j], concepts[i], eta * gain * 0.35, at, post)
      }
    }

    // STDP across consecutive episodes. The signed interval matters: a later
    // episode after an earlier one potentiates, an out-of-order pair depresses.
    const previous = this.episodes.at(-2)
    if (previous) {
      const dtMinutes = (at - previous.at) / 60e3
      const delta = stdpDelta(dtMinutes, { aPlus: 0.1, aMinus: 0.04, tauMinutes: 45 })
      if (Math.abs(delta) > 0.005) {
        for (const a of previous.concepts.slice(0, 2)) {
          for (const b of concepts.slice(0, 2)) {
            if (a === b) continue
            if (delta > 0) this._strengthenEdge(a, b, delta, at, post)
            else this._weakenEdge(a, b, -delta)
          }
        }
      }
    }

    this.prevContext = context
    this.stats.encoded++
    if (this.episodes.length > this.maxEpisodes * 1.2) this.prune(at)
    return episode
  }

  _strengthenEdge(a, b, eta, at, postActivity = 0.5) {
    if (!a || !b || a === b) return
    const key = `${a}\u0001${b}`
    const edge = this.edges.get(key) ?? { w: 0.03, count: 0, at }
    const node = this.concepts.get(a)
    const theta = node?.theta ?? 0.25
    // One combined BCM+Hebb rule: the BCM term decides the sign, (1 − w) bounds growth.
    const drive = postActivity * (postActivity - theta) + 0.12
    const delta = eta * drive * (1 - edge.w)
    edge.w = clamp(edge.w + delta, 0, 1)
    edge.count += 1
    edge.at = at
    this.edges.set(key, edge)
    if (!this.adjacency.has(a)) this.adjacency.set(a, new Map())
    this.adjacency.get(a).set(b, edge.w)
  }

  _weakenEdge(a, b, amount) {
    const key = `${a}\u0001${b}`
    const edge = this.edges.get(key)
    if (!edge) return
    edge.w = clamp(edge.w - amount, 0, 1)
    if (edge.w < 0.015) {
      this.edges.delete(key)
      this.adjacency.get(a)?.delete(b)
    } else {
      this.adjacency.get(a)?.set(b, edge.w)
    }
  }

  /**
   * ECAN-style attention economy: a concept used as a cue gains short-term
   * importance (STI); sleep decays it ("rent"). This is priming: recently
   * relevant concepts re-activate faster than their long-run strength would suggest.
   */
  /** HTM temporal memory: learn that `prev` concepts tend to precede `cur` concepts. */
  learnTransition(prev, cur, { maxPre = 5, maxPost = 5 } = {}) {
    const pre = (prev ?? []).slice(0, maxPre)
    const post = (cur ?? []).slice(0, maxPost)
    if (pre.length === 0 || post.length === 0) return
    for (const a of pre) {
      let row = this.transitions.get(a)
      if (!row) {
        row = new Map()
        this.transitions.set(a, row)
      }
      for (const b of post) {
        if (a === b) continue
        row.set(b, (row.get(b) ?? 0) + 1)
      }
    }
  }

  /** Predict the next concept set from a context, ranked by transition weight.
   *  A concept predicts its own persistence too: a running topic keeps its concepts active. */
  predictNext(context, { limit = 16, topPer = 4 } = {}) {
    const out = new Map()
    for (const a of context ?? []) {
      out.set(a, (out.get(a) ?? 0) + 1) // self-persistence
      const row = this.transitions.get(a)
      if (!row) continue
      const sorted = [...row.entries()].sort((x, y) => y[1] - x[1]).slice(0, topPer)
      for (const [b, w] of sorted) out.set(b, (out.get(b) ?? 0) + w)
    }
    return [...out.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([b]) => b)
  }

  /** Human-readable concept handles for a text (same tokens the episodes use). */
  conceptsOf(text, limit = 6) {
    return selectConcepts(this.encoder, text, limit)
  }

  _hot(concept) {
    const node = this.concepts.get(concept)
    if (!node) return
    node.hot = clamp((node.hot ?? 0) + 0.3)
  }

  // ---- recall --------------------------------------------------------------

  /** ACT-R base-level activation: ln(sum (now - t_j)^-d). */
  baseLevel(ep, now) {
    let sum = 0
    for (const t of ep.accesses) {
      const age = Math.max((now - t) / 1000, 1)
      sum += Math.pow(age, -this.baseLevelDecay)
    }
    if (sum <= 0) return -6
    return Math.log(sum)
  }

  /**
   * Directed spreading activation with the ACT-R fan correction. Forward edges
   * carry the full weight; backward edges are learned weaker and decay faster.
   */
  spread(seeds, { steps = 3, decayFactor = 0.55, threshold = 0.02 } = {}) {
    let activation = new Map(seeds)
    for (let step = 0; step < steps; step++) {
      const next = new Map(activation)
      for (const [concept, value] of activation) {
        if (value < threshold) continue
        const neighbors = this.adjacency.get(concept)
        if (!neighbors || neighbors.size === 0) continue
        const gain = fanGain(neighbors.size)
        for (const [neighbor, weight] of neighbors) {
          const delta = value * weight * decayFactor * gain
          if (delta < threshold) continue
          next.set(neighbor, Math.max(next.get(neighbor) ?? 0, delta))
        }
      }
      activation = next
    }
    let max = 0
    for (const value of activation.values()) max = Math.max(max, value)
    if (max <= 0) return new Map()
    return new Map([...activation].map(([k, v]) => [k, clamp(v / max)]))
  }

  /**
   * Cue-driven recall with attractor completion and temporal-context matching.
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.k]
   * @param {number} [options.now]
   * @param {number} [options.moodValence]
   * @param {number} [options.moodBias]
   * @param {string[]} [options.kinds]
   * @param {boolean} [options.reinforce]
   * @param {import('./sdr.js').Code} [options.contextCode]
   */
  recall(query, options = {}) {
    const now = Number(options.now) || Date.now()
    const k = Math.max(1, Number(options.k) || 5)
    const moodValence = Number(options.moodValence ?? 0)
    const moodBias = clamp(Number(options.moodBias ?? 0.18))
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? new Set(options.kinds) : null
    if (this.episodes.length === 0) return []

    const cue = this.encoder.encode(query)
    const cueConcepts = selectConcepts(this.encoder, query, 8)
    const seeds = new Map()
    for (const concept of cueConcepts) {
      const node = this.concepts.get(concept)
      this._hot(concept)
      seeds.set(concept, clamp((node?.strength ?? 0.35) + 0.4 * (node?.hot ?? 0) + 0.35))
    }
    const spread = this.spread(seeds)

    const candidates = new Set()
    for (const concept of cueConcepts) {
      for (const id of this.conceptIndex.get(concept) ?? []) candidates.add(id)
    }
    for (const [concept, value] of spread) {
      if (value < 0.12) continue
      for (const id of this.conceptIndex.get(concept) ?? []) candidates.add(id)
    }
    for (const ep of this.episodes.slice(-120)) candidates.add(ep.id)
    for (const ep of [...this.episodes].sort((a, b) => b.importance - a.importance).slice(0, 60)) candidates.add(ep.id)
    // Lexical layer: exact terms (error codes, names, versions) surface even when
    // the semantic code misses them.
    const lexScores = this.bm25.search(query, { limit: 80 })
    let lexMax = 0
    for (const score of lexScores.values()) lexMax = Math.max(lexMax, score)
    for (const id of lexScores.keys()) candidates.add(id)

    const pool = [...candidates].map((id) => this.byId.get(id)).filter(Boolean)
    if (kinds) pool.splice(0, pool.length, ...pool.filter((ep) => kinds.has(ep.kind)))
    if (pool.length === 0) return []

    // CA3 completion only makes sense with a partially matching cue and more than
    // one stored pattern; otherwise "settling" would rubber-stamp the only option.
    const cueSims = new Map()
    for (const ep of pool) cueSims.set(ep.id, this.encoder.similarity(cue, ep.code))
    const maxCueSim = Math.max(0, ...cueSims.values())
    const useAttractor = pool.length >= 2 && maxCueSim >= 0.12
    const completion = useAttractor
      ? this.attractor.complete(cue, pool.map((ep) => ({ id: ep.id, code: ep.code })))
      : { code: cue, winners: [], iterations: 0, gain: 0, converged: false }
    if (completion.winners.length > 0) this.stats.completions++
    const currentContext = options.contextCode?.size > 0 ? options.contextCode : this.prevContext

    const rng = makeRng((now ^ (query.length * 2654435761)) >>> 0)
    const noise = () => gaussian(rng) * 0.04
    const scored = []
    for (const ep of pool) {
      const base = this.baseLevel(ep, now)
      const baseNorm = clamp(1 + base / 6)
      let spreadScore = 0
      for (const concept of ep.concepts) spreadScore = Math.max(spreadScore, spread.get(concept) ?? 0)
      const cueSim = cueSims.get(ep.id) ?? 0
      const completedSim = useAttractor ? this.encoder.similarity(completion.code, ep.code) : cueSim
      const similarity = useAttractor ? 0.7 * cueSim + 0.3 * completedSim : cueSim
      const contextMatch = currentContext && ep.context ? clamp(codeDot(currentContext, ep.context)) : 0
      const retention = this.retention(ep, now)
      const lexNorm = lexMax > 0 ? (lexScores.get(ep.id) ?? 0) / lexMax : 0
      // Evidence must come from the cue or the graph; context only biases the rank.
      if (cueSim < 0.10 && spreadScore < 0.12 && lexNorm < 0.05) continue
      // A trace with almost no availability needs a strong cue: old memories are
      // recoverable, but not from a vague hint (encoding specificity).
      if (retention < 0.08 && similarity < 0.22 && spreadScore < 0.3) continue
      const moodTerm = moodValence === 0 ? 0 : ep.affect.v * moodValence
      const activation =
        1.1 * baseNorm +
        0.95 * spreadScore +
        1.4 * similarity +
        0.5 * lexNorm +
        0.8 * contextMatch +
        0.35 * ep.importance +
        0.3 * moodBias * 2 * moodTerm +
        noise()
      const probability = 1 / (1 + Math.exp(-((activation / 3.2) - 0.58) / 0.14))
      scored.push({
        episode: ep,
        activation,
        probability,
        parts: {
          base: round3(baseNorm),
          spread: round3(spreadScore),
          similarity: round3(similarity),
          context: round3(contextMatch),
          lex: round3(lexNorm),
          importance: round3(ep.importance),
          mood: round3(moodTerm),
          attractor: completion.iterations,
          r: round3(retention),
          latency: round3(350 * Math.exp(-activation)),
        },
      })
    }

    scored.sort((a, b) => b.activation - a.activation)
    const picked = scored.slice(0, k)
    if (options.reinforce !== false && picked.length > 0) {
      // Retrieval strengthens the winner; a close competitor is suppressed instead
      // (retrieval-induced forgetting), not rehearsed as if it had been recalled.
      this._rehearse(picked[0].episode, now)
      for (let i = 1; i < picked.length; i++) {
        const hit = picked[i]
        if (hit.activation >= picked[0].activation * 0.9) {
          // Suppression acts on the trace's stability, not a cosmetic score.
          hit.episode.stability = Math.max(0.25, hit.episode.stability * 0.96)
          hit.episode.strength = clamp(0.3 + 0.7 * Math.min(1, Math.log1p(hit.episode.stability) / Math.log1p(365)))
        } else {
          hit.episode.stability = Math.min(3650, hit.episode.stability * 1.01)
        }
      }
      // Context reinstatement closes the loop: the next retrieval starts here.
      const top = picked[0].episode
      if (top?.context) this.prevContext = reinstateContext(this.prevContext, top.context, { k: this.encoder.k })
    }
    this.stats.recalls++

    const results = [...picked]
    if (results.length > 0 && results.length < k) {
      const seen = new Set(results.map((r) => r.episode.id))
      for (const hit of picked) {
        for (const linkedId of hit.episode.links) {
          if (results.length >= k) break
          const ep = this.byId.get(linkedId)
          if (!ep || seen.has(ep.id)) continue
          if (kinds && !kinds.has(ep.kind)) continue
          seen.add(ep.id)
          results.push({ episode: ep, activation: hit.activation * 0.8, probability: hit.probability * 0.8, parts: { ...hit.parts, linked: 1 } })
        }
      }
    }
    return results
  }

  _rehearse(ep, now) {
    const elapsedDays = Math.max(0, now - ep.lastReviewAt) / DAY
    const r = retrievability(elapsedDays, ep.stability)
    ep.stability = growStability(ep.stability, ep.difficulty, r)
    ep.difficulty = updateDifficulty(ep.difficulty, { success: true, r })
    ep.retrievals++
    ep.lastAccess = now
    ep.lastReviewAt = now
    ep.accesses.push(now)
    if (ep.accesses.length > 20) ep.accesses.splice(0, ep.accesses.length - 20)
    ep.strength = clamp(0.3 + 0.7 * Math.min(1, Math.log1p(ep.stability) / Math.log1p(365)))
    this._recordReview(ep, 'recall', now)
  }

  /** A failed retrieval is a lapse: the trace resets toward a weaker state. */
  lapse(id, now = Date.now()) {
    const ep = this.byId.get(id)
    if (!ep) return null
    ep.stability = lapseStability(ep.stability)
    ep.difficulty = updateDifficulty(ep.difficulty, { success: false })
    ep.lapses += 1
    ep.lastReviewAt = now
    ep.strength = clamp(0.3 + 0.7 * Math.min(1, Math.log1p(ep.stability) / Math.log1p(365)))
    this._recordReview(ep, 'lapse', now)
    return ep
  }

  /**
   * Behavioral tagging: a strong, plastic event promotes weak traces encoded in
   * the same window into long-term storage (Frey & Morris 1997).
   */
  _captureTagged(episode, at) {
    if (episode.salience < 0.7) return
    const windowMinutes = 90
    for (const ep of this.episodes.slice(-40)) {
      if (ep.id === episode.id || ep.tagged || ep.schema) continue
      if (ep.salience >= 0.6) continue
      const gapMinutes = Math.abs(ep.at - at) / 60e3
      if (gapMinutes > windowMinutes || gapMinutes === 0) continue
      ep.stability = Math.min(3650, ep.stability * captureBoost(episode.salience, gapMinutes))
      ep.tagged = true
      this._recordReview(ep, 'capture', at)
      this.stats.captures++
      this.dirty = true
    }
  }

  /** Retroactive interference from a new, similar trace (Wixted 2004). */
  _applyInterference(episode, similar, at) {
    for (const { ep, sim } of similar) {
      if (ep.id === episode.id || ep.schema || sim < 0.55) continue
      ep.stability = Math.max(0.25, ep.stability * interferenceFactor(sim, { strength: 0.15 }))
      ep.interferences += 1
      this._recordReview(ep, 'interference', at)
      this.stats.interferences++
      this.dirty = true
    }
  }

  /**
   * Retention probability (power-law forgetting), scaled by stability.
   * @param {object} ep
   * @param {number} now
   */
  retention(ep, now) {
    const elapsedDays = Math.max(0, now - (ep.lastReviewAt ?? ep.at)) / DAY
    return retrievability(elapsedDays, ep.stability)
  }

  /**
   * Feeling of knowing (Brown & McNeill 1966; Koriat 1993): when recall returns
   * nothing but some trace is partially similar, report a graded "I may know
   * this" signal instead of a flat miss.
   */
  probe(query, { now = Date.now(), limit = 600 } = {}) {
    if (this.episodes.length === 0) return { similarity: 0, episode: null }
    const cue = this.encoder.encode(query)
    let best = { similarity: 0, episode: null }
    for (const ep of this.episodes.slice(-limit)) {
      const similarity = this.encoder.similarity(cue, ep.code)
      if (similarity > best.similarity) best = { similarity, episode: ep }
    }
    return { ...best, now }
  }

  // ---- reconsolidation -----------------------------------------------------

  /** Explicitly forget a trace. The log keeps a tombstone for audit. */
  forget(id, { reason = '', now = Date.now() } = {}) {
    const ep = this.byId.get(id)
    if (!ep) return null
    this.episodes = this.episodes.filter((entry) => entry.id !== id)
    this.byId.delete(id)
    this.bm25.remove(id)
    this._rebuildConceptIndex()
    this.forgetLog.append({ id, summary: ep.summary, reason: String(reason ?? ''), at: now })
    this.dirty = true
    this.stats.forgotten++
    return { id, summary: ep.summary }
  }

  /** In-place update of editable fields (summary/importance/tags/resident). */
  update(id, patch = {}) {
    const ep = this.byId.get(id)
    if (!ep) return null
    const textChanged = typeof patch.text === 'string' && patch.text.trim().length > 0
    if (typeof patch.summary === 'string' && patch.summary.trim().length > 0) ep.summary = truncate(patch.summary.trim(), 240)
    if (textChanged) ep.text = truncate(patch.text.trim(), 4000)
    if (Number.isFinite(patch.importance)) ep.importance = clamp(patch.importance)
    if (Array.isArray(patch.tags)) ep.tags = patch.tags.slice(0, 12).map(String)
    if (typeof patch.resident === 'boolean') ep.resident = patch.resident
    ep.consolidated = false
    this.dirty = true
    // Lexical index must follow the text, otherwise BM25 keeps serving stale terms.
    if (textChanged) {
      this.bm25.remove(id)
      this.bm25.add(id, ep.text)
    }
    return ep
  }

  /** A contradicted memory is updated in place, not duplicated (reconsolidation). */
  markLabile(id) {
    const ep = this.byId.get(id)
    if (!ep) return false
    ep.labile = true
    return true
  }

  /**
   * Update an existing trace instead of writing a duplicate. Triggered when a
   * new experience contradicts the stored outcome or valence.
   */
  reconsolidate(id, { summary, affect, outcome, note } = {}) {
    const ep = this.byId.get(id)
    if (!ep) return null
    if (typeof summary === 'string' && summary.length > 0) ep.summary = truncate(summary, 240)
    if (affect) {
      ep.affect = {
        v: clamp(ep.affect.v * 0.6 + clamp(Number(affect.v ?? 0), -1, 1) * 0.4, -1, 1),
        a: clamp(ep.affect.a * 0.7 + clamp(Number(affect.a ?? 0.3)) * 0.3),
        d: clamp(Number(affect.d ?? ep.affect.d)),
      }
    }
    if (outcome && typeof outcome === 'object') ep.outcome = { success: outcome.success === true, errors: Number(outcome.errors ?? 0) }
    if (typeof note === 'string' && note.trim().length > 0) {
      ep.text = truncate(`${ep.text}\n[重构] ${note.trim()}`, 4000)
      this.bm25.remove(ep.id)
      this.bm25.add(ep.id, ep.text)
    }
    ep.reconsolidations += 1
    ep.consolidated = false
    ep.labile = false
    ep.strength = clamp(ep.strength + 0.05)
    this.dirty = true
    this._recordReview(ep, 'reconsolidate')
    this.stats.reconsolidations++
    return ep
  }

  // ---- consolidation -------------------------------------------------------

  /**
   * Two-stage consolidation.
   *  - NREM: prioritized replay, concept clustering, gist/schema extraction.
   *  - REM:  loose associative edges, emotional decoupling of old traces.
   * @param {{now?: number, minCluster?: number, modelSummaries?: Array, stage?: 'nrem'|'rem'|'both'}} options
   */
  consolidate(options = {}) {
    const now = Number(options.now) || Date.now()
    const minCluster = Math.max(2, Number(options.minCluster) || 3)
    const stage = options.stage === 'nrem' || options.stage === 'rem' ? options.stage : 'both'
    const modelSummaries = Array.isArray(options.modelSummaries) ? options.modelSummaries : []
    const applied = []
    const created = []

    if (stage !== 'rem') {
      for (const item of modelSummaries) {
        const ids = Array.isArray(item?.episodeIds) ? item.episodeIds : []
        const episodes = ids.map((id) => this.byId.get(id)).filter(Boolean)
        if (episodes.length === 0 || typeof item.gist !== 'string' || item.gist.trim().length === 0) continue
        const concepts = [...new Set(episodes.flatMap((ep) => ep.concepts))].slice(0, 10)
        for (const concept of concepts) {
          const node = this.concepts.get(concept) ?? { strength: 0.5, count: 0, lastAt: now, gist: '', lessons: [], theta: 0.25, hot: 0, history: [], schema: false }
          node.strength = clamp(node.strength + 0.25)
          const newGist = truncate(item.gist.trim(), 400)
          if (node.gist && node.gist !== newGist) {
            node.history.push({ at: now, gist: node.gist })
            node.history = node.history.slice(-20)
          }
          node.gist = newGist
          if (typeof item.lesson === 'string' && item.lesson.trim().length > 0 && !node.lessons.includes(item.lesson.trim())) {
            node.lessons.unshift(truncate(item.lesson.trim(), 240))
            node.lessons = node.lessons.slice(0, 5)
          }
          this.concepts.set(concept, node)
        }
        for (const ep of episodes) {
          ep.consolidated = true
          // A model-authored lesson is a generalization: its source episodes become
          // schema-backed and earn the permastore stability floor.
          if (typeof item.lesson === 'string' && item.lesson.trim().length > 0) {
            ep.schema = true
            ep.stability = Math.min(3650, Math.max(180, ep.stability * 2))
            this._recordReview(ep, 'schema', now)
          }
        }
        applied.push({ episodeIds: episodes.map((ep) => ep.id), concepts, gist: item.gist })
        // Model-authored procedural rule: `when → do` (LangMem/ReMe procedure layer).
        if (item.skill && typeof item.skill === 'object' && typeof item.skill.do === 'string' && item.skill.do.trim().length > 0) {
          this.upsertSkill({ when: item.skill.when ?? concepts.slice(0, 5), do: item.skill.do, source: 'model', strength: 0.7, now })
        }
      }

      // Prioritized replay: need × gain decides what gets replayed first.
      const pending = this.episodes
        .filter((ep) => !ep.consolidated)
        .sort((a, b) => replayPriority(b, { now }) - replayPriority(a, { now }))
        .slice(0, 400)
      const counts = new Map()
      for (const ep of pending) for (const concept of ep.concepts) counts.set(concept, (counts.get(concept) ?? 0) + 1)
      for (const [concept, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        if (count < minCluster) break
        const episodes = pending.filter((ep) => !ep.consolidated && ep.concepts.includes(concept))
        if (episodes.length < minCluster) continue
        episodes.sort((a, b) => b.at - a.at)
        const node = this.concepts.get(concept) ?? { strength: 0.4, count: episodes.length, lastAt: now, gist: '', lessons: [], theta: 0.25, hot: 0, history: [], schema: false }
        node.strength = clamp(node.strength + 0.08 * episodes.length)
        const newGist = truncate(`“${concept}”相关经历 ${episodes.length} 次；最近：${episodes[0].summary}`, 300)
        if (node.gist && node.gist !== newGist) {
          node.history.push({ at: now, gist: node.gist })
          node.history = node.history.slice(-20)
        }
        node.gist = newGist
        // Schema detection: a well-established concept *with consistent outcomes*
        // absorbs new episodes quickly. Strength alone would bless a frequent but
        // contradictory concept, which is the opposite of a schema.
        const outcomes = new Set(episodes.map((ep) => ep.outcome?.success))
        const consistent = outcomes.size === 1 && !outcomes.has(undefined)
        if (node.strength > 0.7 && consistent && episodes.length >= minCluster) {
          node.schema = true
          for (const ep of episodes) {
            ep.schema = true
            ep.strength = clamp(ep.strength + 0.1)
            // A schema is a permastore candidate: long stability floor, ×2 boost.
            ep.stability = Math.min(3650, Math.max(180, ep.stability * 2))
            this._recordReview(ep, 'schema', now)
          }
          // SOAR chunking: a consistent schema becomes a reusable procedure.
          // `when` = tokens from the cluster's summaries, so the trigger reads
          // like the situation instead of a random high-frequency trigram.
          const summaryTokens = this.encoder.topTokens(episodes.map((ep) => ep.summary).join(' '), 12)
          const common = summaryTokens
            .filter((token) => token.length >= 2 && token.length <= 4 && !/^[才过次第再又把被着的地得]/.test(token))
            .filter((token) => episodes.filter((ep) => ep.concepts.includes(token) || ep.summary.includes(token)).length >= Math.ceil(episodes.length / 2))
            .slice(0, 3)
          this.upsertSkill({ when: common.length > 0 ? common : [concept], do: node.gist, source: 'auto', strength: 0.3 + 0.1 * Math.min(episodes.length, 5), now })
        }
        this.concepts.set(concept, node)
        for (const ep of episodes) ep.consolidated = true
        created.push({ concept, episodeIds: episodes.map((ep) => ep.id), gist: node.gist, schema: node.schema })
      }
    }

    if (stage !== 'nrem') {
      const rng = makeRng((now ^ 0x5f3759df) >>> 0)
      const strong = [...this.concepts.entries()].sort((a, b) => b[1].strength - a[1].strength).slice(0, 24)
      // REM associativity: loose links between concepts that never co-occurred.
      for (let i = 0; i < 6 && strong.length > 2; i++) {
        const a = strong[Math.floor(rng() * strong.length)][0]
        const b = strong[Math.floor(rng() * strong.length)][0]
        if (a !== b) this._strengthenEdge(a, b, 0.02, now, 0.4)
      }
      // Emotional decoupling: content stays, charge fades (sleep to forget, sleep to remember).
      for (const ep of this.episodes) {
        if (now - ep.at < DAY) continue
        if (Math.abs(ep.affect.v) < 0.05) continue
        const decoupled = decoupleAffect(ep.affect, { rate: 0.15 })
        ep.affect.v = decoupled.v
        ep.affect.a = decoupled.a
      }
      // Synaptic scaling keeps outgoing weights bounded per concept.
      for (const [concept, neighbors] of this.adjacency) {
        if (neighbors.size < 4) continue
        const keys = [...neighbors.keys()]
        const scaled = synapticScaling(keys.map((neighbor) => neighbors.get(neighbor)), 1)
        keys.forEach((neighbor, index) => {
          this.edges.get(`${concept}\u0001${neighbor}`).w = scaled[index]
          neighbors.set(neighbor, scaled[index])
        })
      }
    }

    // Sleep-like downscaling of weak edges, plus attention rent on concepts.
    for (const [key, edge] of this.edges) {
      edge.w *= 0.94
      if (edge.w < 0.02) this.edges.delete(key)
    }
    for (const node of this.concepts.values()) node.hot = (node.hot ?? 0) * 0.5
    // Attention economy on transitions too: unused sequence links fade.
    for (const [key, row] of this.transitions) {
      for (const [b, w] of row) {
        const next = Math.floor(w * 0.5)
        if (next <= 0) row.delete(b)
        else row.set(b, next)
      }
      if (row.size === 0) this.transitions.delete(key)
    }
    this._rebuildAdjacency()

    for (const [concept, node] of this.concepts) {
      if (node.count >= 5 && node.lessons.length === 0) {
        node.lessons.push(`与“${concept}”有关的模式已重复 ${node.count} 次，值得作为默认假设。`)
      }
    }
    for (const ep of this.episodes) if (!ep.consolidated) ep.replayCount++

    this.stats.consolidated++
    this.prune(now)
    this.flush()
    // Decision receipt: the same inputs reproduce the same hash (auditable consolidation).
    const receipt = {
      at: now,
      stage,
      applied: applied.length,
      created: created.length,
      episodes: this.episodes.length,
      concepts: this.concepts.size,
    }
    receipt.hash = crypto.createHash('sha256').update(JSON.stringify({ at: receipt.at, stage, applied: applied.length, created: created.length, episodes: receipt.episodes })).digest('hex').slice(0, 16)
    this.receiptLog.append(receipt)
    this.stats.receipts = this.receiptLog.items.length
    return {
      stage,
      applied,
      created,
      semanticNodes: applied.length + created.length,
      episodes: this.episodes.length,
      concepts: this.concepts.size,
      schemaEpisodes: this.episodes.filter((ep) => ep.schema).length,
      receipt,
    }
  }

  // ---- forgetting ----------------------------------------------------------

  /** Forgetting curve + capacity eviction. */
  prune(now = Date.now()) {
    if (this.episodes.length <= this.maxEpisodes * 0.9) return []
    // Resident preferences and schema-backed traces are never evicted.
    const pinned = this.episodes.filter((ep) => ep.resident || ep.schema)
    const candidates = this.episodes.filter((ep) => !ep.resident && !ep.schema)
    const scored = candidates.map((ep) => {
      const keep = this.retention(ep, now) * (0.35 + 0.65 * ep.importance) + 0.02 * Math.log1p(ep.retrievals)
      return { ep, keep }
    })
    scored.sort((a, b) => b.keep - a.keep)
    const keepCount = Math.max(0, Math.floor(this.maxEpisodes * 0.9) - pinned.length)
    const kept = scored.slice(0, keepCount).map(({ ep }) => ep)
    const dropped = scored.slice(keepCount)
    for (const { ep } of dropped) {
      for (const concept of ep.concepts.slice(0, 2)) {
        const node = this.concepts.get(concept)
        if (!node) continue
        node.gist = node.gist || truncate(`${ep.summary}（已压缩）`, 200)
      }
    }
    this.episodes = [...kept, ...pinned]
    this.byId = new Map(this.episodes.map((ep) => [ep.id, ep]))
    for (const id of dropped.map(({ ep }) => ep.id)) this.bm25.remove(id)
    this._rebuildConceptIndex()
    this.dirty = true
    this.stats.pruned += dropped.length
    return dropped.map(({ ep }) => ep.id)
  }

  topConcepts(limit = 10) {
    return [...this.concepts.entries()]
      .sort((a, b) => b[1].strength - a[1].strength || b[1].count - a[1].count)
      .slice(0, limit)
      .map(([name, node]) => ({ name, strength: round3(node.strength), count: node.count, gist: node.gist, schema: node.schema }))
  }

  /** Resident layer: preferences, working agreements and schema memories. */
  resident(limit = 6) {
    return this.episodes
      .filter((ep) => ep.resident || ep.schema)
      .sort((a, b) => b.stability - a.stability || b.importance - a.importance)
      .slice(0, limit)
  }

  /** Near-duplicate lookup for idempotent writes (upsert instead of append). */
  findDuplicate(text, { threshold = 0.82, limit = 400 } = {}) {
    if (!text) return null
    const code = this.encoder.encode(String(text))
    let best = null
    for (const ep of this.episodes.slice(-limit)) {
      const sim = this.encoder.similarity(code, ep.code)
      if (!best || sim > best.sim) best = { ep, sim }
    }
    return best && best.sim >= threshold ? best : null
  }

  /** Procedural memory: upsert a `when → do` rule (SOAR chunking / basal ganglia habit). */
  upsertSkill({ when = [], do: doText = '', source = 'auto', strength = 0.4, now = Date.now() } = {}) {
    const doTrim = String(doText).trim()
    const whenSet = (Array.isArray(when) ? when : []).map(String).filter((c) => c.length > 0).slice(0, 8)
    if (doTrim.length === 0 || whenSet.length === 0) return null
    const existing = this.skills.find((skill) => skill.do === doTrim)
    if (existing) {
      existing.strength = clamp(existing.strength + 0.2)
      existing.uses = (existing.uses ?? 0) + 1
      existing.at = now
      existing.when = [...new Set([...existing.when, ...whenSet])].slice(0, 8)
      return existing
    }
    const skill = { id: `sk_${now.toString(36)}_${(counter++).toString(36)}`, when: whenSet, do: doTrim, strength: clamp(strength), uses: 1, successRate: null, at: now, source }
    this.skills.push(skill)
    if (this.skills.length > 200) this.skills.splice(0, this.skills.length - 200)
    return skill
  }

  /** Match a cue against procedural rules. Substring matching keeps Chinese
   *  bigrams working against stored trigrams (迁移 ↔ 迁移前). */
  skillsOf(query, { limit = 3, threshold = 0.3 } = {}) {
    const cue = this.conceptsOf(String(query ?? ''), 8)
    if (cue.length === 0) return []
    return this.skills
      .map((skill) => {
        const matched = new Set(skill.when.filter((w) => cue.some((c) => c.includes(w) || w.includes(c))))
        const doBonus = cue.some((c) => skill.do.includes(c)) ? 0.2 : 0
        const score = matched.size > 0 ? matched.size / Math.max(skill.when.length, 1) + doBonus : 0
        return { skill, score: clamp(score * skill.strength, 0, 1) }
      })
      .filter(({ score }) => score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Bi-temporal view: the concept's conclusion as of a point in time. */
  asOf(concept, at = Date.now()) {
    const node = this.concepts.get(concept)
    if (!node) return null
    const history = node.history ?? []
    const before = history.filter((entry) => entry.at <= at).sort((a, b) => b.at - a.at)[0]
    return { gist: before?.gist ?? null, at: before?.at ?? null, current: node.gist }
  }

  snapshot() {
    return {
      episodes: this.episodes.length,
      concepts: this.concepts.size,
      edges: this.edges.size,
      consolidated: this.episodes.filter((ep) => ep.consolidated).length,
      schema: this.episodes.filter((ep) => ep.schema).length,
      resident: this.episodes.filter((ep) => ep.resident).length,
      tagged: this.episodes.filter((ep) => ep.tagged).length,
      permastore: this.episodes.filter((ep) => ep.stability >= 180).length,
      avgStabilityDays: round3(this.episodes.reduce((sum, ep) => sum + ep.stability, 0) / Math.max(this.episodes.length, 1)),
      ...this.stats,
    }
  }

  exportEpisodes(limit = 100) {
    return this.episodes.slice(-limit).map((ep) => this._serialize(ep))
  }

  static exists(dir) {
    return fs.existsSync(path.join(dir, 'episodes.jsonl'))
  }
}
