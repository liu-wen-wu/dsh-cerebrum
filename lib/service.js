/**
 * CerebrumService — the integration layer.
 *
 * It owns the four stateful subsystems (memory, affect, personality, self-model),
 * observes the DSH session log, and exposes the operations that tools and the
 * system prompt use. All state is per-workspace and survives restarts.
 *
 * Event pipeline:
 *   session/event(user/message)    -> turn buffer: what was asked
 *   session/event(tool/call)       -> turn buffer: what was done
 *   session/event(tool/result)     -> immediate affective outcome signal
 *   session/event(assistant/message) -> turn buffer: what was said
 *   session/event(turn/end)        -> appraise -> encode episode -> self-model -> maybe consolidate
 */

import fs from 'node:fs'
import path from 'node:path'
import { AffectSystem } from './core/affect.js'
import { Judge } from './core/judge.js'
import { MemoryStore } from './core/memory.js'
import { Personality } from './core/personality.js'
import { SdrEncoder } from './core/sdr.js'
import { clamp } from './core/math.js'
import { cardToPersona } from './core/charcard.js'
import { INTERACTION_APPRAISALS, renderHints } from './core/petbrain.js'
import { PRESETS } from './core/personality.js'
import { updateContext } from './core/plasticity.js'
import { tokenize } from './core/sdr.js'
import { DebouncedWriter, ensureDir, readJson, workspaceSlug, writeJson } from './core/storage.js'

const MAX_PENDING_EVENTS = 600

const POSITIVE = /(谢谢|感谢|很好|不错|完美|漂亮|棒|对的|正确|可以|同意|太好了|辛苦|thanks|thank you|great|perfect|nice|correct|works|good job)/i
const NEGATIVE = /(不对|错了|失败|糟糕|不行|太慢|崩溃|报错|为什么还|又错|垃圾|差劲|wrong|failed|broken|bad|slow|crash|error)/i
const IMPORTANT = /(重要|必须|务必|永远|记住|关键|决定|承诺|不要忘记|deadline|critical|must|remember|never|always|promise)/i
const URGENT = /(马上|立刻|紧急|今天|截止|尽快|asap|urgent|today|deadline)/i
const GOAL = /(目标|计划|打算|需要完成|要交付|goal|plan|deliver|objective)/i
const RISK = /(风险|危险|事故|回滚|删|覆盖|生产|线上|失败|报错|risk|danger|rollback|delete|production|failure)/i

const timeAgo = (at, now) => {
  const delta = Math.max(0, now - at)
  if (delta < 60e3) return '刚刚'
  if (delta < 60 * 60e3) return `${Math.round(delta / 60e3)} 分钟前`
  if (delta < 24 * 60 * 60e3) return `${Math.round(delta / (60 * 60e3))} 小时前`
  return `${Math.round(delta / (24 * 60 * 60e3))} 天前`
}

const textOf = (message) => {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

const toolCallsOf = (message) => {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'tool-call' && typeof block.name === 'string')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
}

const firstClause = (text, limit = 80) => {
  const clean = text.replace(/\s+/g, ' ').trim()
  const clause = clean.split(/[。！？!?\n]/)[0] ?? clean
  return clause.length > limit ? `${clause.slice(0, limit - 1)}…` : clause
}

const sentiment = (text) => {
  if (POSITIVE.test(text)) return 1
  if (NEGATIVE.test(text)) return -1
  return 0
}

export class CerebrumService {
  constructor(config, { logger = console } = {}) {
    this.config = config
    this.logger = logger
    this.dir = config.dataDir
    ensureDir(this.dir)

    const savedPersonality = readJson(path.join(this.dir, 'personality.json'), null)
    this.personality = savedPersonality ? Personality.fromJSON(savedPersonality) : new Personality(config.personality)
    this.affect = new AffectSystem({
      personality: this.personality,
      state: readJson(path.join(this.dir, 'affect.json'), null),
    })
    this.encoder = new SdrEncoder({ dim: config.memory.dim, k: config.memory.sparsity })
    /**
     * One self, several project memories. Affect/personality/self live in the
     * default directory; each session's `header.cwd` gets its own episode store,
     * so two workspaces do not contaminate each other's recall.
     */
    this.stores = new Map()
    this.memory = this._storeForDir(this.dir)
    this.judgeLayer = null
    this.self = this._loadSelf()
    this.personaOverrides = readJson(path.join(this.dir, 'personas.json'), { global: null, workspaces: {} }) ?? { global: null, workspaces: {} }
    this.personaCache = new Map()
    this.intentions = readJson(path.join(this.dir, 'intentions.json'), [])
    this.writer = new DebouncedWriter({ delayMs: 500, label: 'cerebrum' })
    this.sessions = new Map()
    this.turnCount = 0
    this.lastConsolidateAt = Date.now()
    this.startedAt = Date.now()
  }

  _storeForDir(dir) {
    ensureDir(dir)
    let store = this.stores.get(dir)
    if (!store) {
      store = new MemoryStore({
        dir,
        encoder: this.encoder,
        maxEpisodes: this.config.memory.maxEpisodes,
        baseLevelDecay: this.config.memory.baseLevelDecay,
        attractor: this.config.memory.attractor,
      }).load()
      this.stores.set(dir, store)
    }
    return store
  }

  _storeForCwd(cwd) {
    if (this.config.fixedDataDir) return this.memory
    const dir = path.join(this.config.home, 'cerebrum', workspaceSlug(cwd || this.config.cwd))
    return this._storeForDir(dir)
  }

  _storeForState(state) {
    if (!state?.dir) return this.memory
    return this._storeForDir(state.dir)
  }

  _storeForSession(sessionId) {
    const state = sessionId ? this.sessions.get(sessionId) : null
    return state?.dir ? this._storeForDir(state.dir) : this.memory
  }

  /**
   * Persona resolution (dsh-persona-dafeiyu style): session > workspace > global.
   * The scoped persona drives wording and decision parameters; affect and the
   * self stay global — one self, several masks.
   */
  _personaFor(sessionId) {
    const state = sessionId ? this.sessions.get(sessionId) : null
    const override =
      state?.persona ??
      (state?.cwd ? this.personaOverrides.workspaces?.[state.cwd] : null) ??
      this.personaOverrides.global ??
      null
    if (!override) return this.personality
    const preset = typeof override.preset === 'string' ? override.preset : this.personality.preset
    const traits = override.traits && typeof override.traits === 'object' ? override.traits : {}
    const key = `${preset}|${JSON.stringify(traits)}`
    let persona = this.personaCache.get(key)
    if (!persona) {
      persona = new Personality({ preset, traits: { ...this.personality.genome, ...traits }, values: this.personality.values, drift: 0 })
      this.personaCache.set(key, persona)
    }
    return persona
  }

  // ---- persistence ---------------------------------------------------------

  _loadSelf() {
    const fresh = {
      identity: '一个借助 DeepSeek Harness 工作的认知体；记忆、情绪与性格共同构成“我”的连续性。',
      values: [...this.personality.values],
      goals: [],
      themes: [],
      milestones: [],
      counters: { turns: 0, tools: 0, successes: 0, failures: 0, emotions: {} },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const saved = readJson(path.join(this.dir, 'self.json'), null)
    if (!saved || typeof saved !== 'object') return fresh
    return {
      ...fresh,
      ...saved,
      values: Array.isArray(saved.values) && saved.values.length > 0 ? saved.values : fresh.values,
      goals: Array.isArray(saved.goals) ? saved.goals.slice(0, 12) : [],
      themes: Array.isArray(saved.themes) ? saved.themes.slice(0, 12) : [],
      milestones: Array.isArray(saved.milestones) ? saved.milestones.slice(-20) : [],
      counters: { ...fresh.counters, ...(saved.counters ?? {}), emotions: { ...(saved.counters?.emotions ?? {}) } },
    }
  }

  _schedulePersist() {
    this.writer.schedule('affect', () => writeJson(path.join(this.dir, 'affect.json'), this.affect.toJSON()))
    this.writer.schedule('personality', () => writeJson(path.join(this.dir, 'personality.json'), this.personality.toJSON()))
    this.writer.schedule('personas', () => writeJson(path.join(this.dir, 'personas.json'), this.personaOverrides))
    this.writer.schedule('intentions', () => writeJson(path.join(this.dir, 'intentions.json'), this.intentions))
    this.writer.schedule('self', () => writeJson(path.join(this.dir, 'self.json'), this.self))
    for (const [dir, store] of this.stores) this.writer.schedule(`memory:${dir}`, () => store.flush())
  }

  flush() {
    this._schedulePersist()
    this.writer.flush()
  }

  /** Close the open event for one session and write it as an episode. */
  flushSession(sessionId) {
    const state = this.sessions.get(sessionId)
    if (!state?.segment) return null
    const store = this._storeForState(state)
    return this._flushSegment(state, store, { now: Date.now(), emotion: this.affect.emotion }) ?? null
  }

  dispose() {
    try {
      for (const sessionId of this.sessions.keys()) this.flushSession(sessionId)
      this.affect.decay(Date.now())
      this.flush()
    } catch (error) {
      this.logger?.error?.('[cerebrum] dispose failed:', error?.message ?? error)
    }
  }

  // ---- session observation -------------------------------------------------

  _session(id) {
    let state = this.sessions.get(id)
    if (!state) {
      state = { id, turn: 0, user: [], assistant: [], tools: [], errors: 0, success: 0, startedAt: Date.now(), lastUserText: '', events: 0, cwd: null, dir: null, context: null, wm: [], segment: null, pendingChecked: false, lastTurnAt: 0, lastBoundaryAt: 0, turnMemory: { read: [], wrote: [] }, prevConcepts: [], lastUserSeq: null, persona: null }
      this.sessions.set(id, state)
    }
    return state
  }

  // ---- crash-safe pending segment ------------------------------------------

  _pendingFile(state) {
    const store = this._storeForState(state)
    return path.join(store.dir, 'pending', `${String(state.id).replace(/[^\w.-]/g, '_')}.json`)
  }

  _savePending(state, segment) {
    if (!state || !segment) return
    try {
      const file = this._pendingFile(state)
      ensureDir(path.dirname(file))
      writeJson(file, { savedAt: Date.now(), segment })
    } catch (error) {
      this.logger?.warn?.('[cerebrum] pending segment write failed:', error?.message ?? error)
    }
  }

  _loadPending(state) {
    try {
      const file = this._pendingFile(state)
      if (!fs.existsSync(file)) return null
      const data = readJson(file, null)
      const segment = data?.segment
      if (!segment || !Array.isArray(segment.turns) || segment.turns.length === 0) return null
      // Guard against an ancient pending file resurfacing after a long break.
      const age = Date.now() - Number(segment.lastAt ?? 0)
      if (age > 24 * 60 * 60 * 1000) return null
      return segment
    } catch {
      return null
    }
  }

  _clearPending(state) {
    try {
      fs.rmSync(this._pendingFile(state), { force: true })
    } catch {
      /* best effort */
    }
  }

  /**
   * Observe one session event. Never throws into the loop: a broken memory
   * write must not fail a turn.
   */
  onSessionEvent(session, event) {
    try {
      if (!event || typeof event.type !== 'string') return
      const id = String(session?.id ?? 'unknown')
      const state = this._session(id)
      if (!state.dir) {
        const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : this.config.cwd
        state.cwd = cwd
        state.dir = this._storeForCwd(cwd).dir
      }
      // Crash recovery: once the workspace is known, restore an open event that a
      // previous process persisted (writes happen per turn, see _savePending).
      if (!state.pendingChecked) {
        state.pendingChecked = true
        if (!state.segment) state.segment = this._loadPending(state)
      }
      if (state.events++ > MAX_PENDING_EVENTS) return

      switch (event.type) {
        case 'user/message': {
          const text = textOf(event.data?.message)
          if (text.length === 0) return
          state.user.push(text.slice(0, 1500))
          state.lastUserText = text.slice(0, 800)
          if (Number.isFinite(event.seq)) state.lastUserSeq = event.seq
          state.turnMemory = { read: [], wrote: [] }
          break
        }
        case 'assistant/message': {
          const text = textOf(event.data?.message)
          if (text.length > 0) state.assistant.push(text.slice(0, 1500))
          for (const call of toolCallsOf(event.data?.message)) this._noteTool(state, call)
          break
        }
        case 'tool/call': {
          this._noteTool(state, {
            id: event.data?.callId,
            name: event.data?.name,
            arguments: event.data?.arguments,
          })
          break
        }
        case 'tool/result': {
          const message = event.data?.message
          const isError = message?.isError === true
          const callId = message?.callId
          const call = state.tools.find((tool) => tool.callId === callId) ?? state.tools[state.tools.length - 1]
          if (call) {
            call.ok = !isError
            call.result = textOf(message).slice(0, this.config.autoCapture.toolResultChars)
          }
          if (isError) {
            state.errors++
            this.affect.outcome({ success: false, magnitude: 0.55, cause: `工具 ${call?.name ?? '未知'} 失败` })
          } else {
            state.success++
          }
          break
        }
        case 'turn/end': {
          const reason = event.data?.reason
          const turn = Number(event.data?.turn)
          if (Number.isFinite(turn)) state.turn = turn
          this._finishTurn(state, reason)
          break
        }
        default:
          break
      }
    } catch (error) {
      this.logger?.error?.('[cerebrum] session event handling failed:', error?.message ?? error)
    }
  }

  _noteTool(state, call) {
    if (!call?.name || call.name.startsWith('cerebrum_')) return
    state.tools.push({ callId: call.id, name: call.name, args: call.arguments, ok: null, result: '' })
  }

  // ---- turn -> episode -----------------------------------------------------

  _finishTurn(state, reason) {
    const store = this._storeForState(state)
    const userText = state.user.join('\n').trim()
    const assistantText = state.assistant.join('\n').trim()
    const tools = state.tools.filter((tool) => tool.ok !== null)
    state.user = []
    state.assistant = []
    state.tools = []
    const errors = state.errors
    const successes = state.success
    state.errors = 0
    state.success = 0
    if (userText.length + assistantText.length < this.config.autoCapture.minChars) return undefined
    if (!this.config.autoCapture.enabled) return undefined
    if (reason?.kind === 'aborted') {
      state.segment = null
      this._clearPending(state)
      return undefined
    }

    const now = Date.now()
    const gapMs = state.lastTurnAt > 0 ? now - state.lastTurnAt : 0
    state.lastTurnAt = now

    const toolLine = tools
      .slice(0, 6)
      .map((tool) => `${tool.name}${tool.ok ? '✓' : '✗'}${tool.result ? `(${firstClause(tool.result, 60)})` : ''}`)
      .join('、')

    const turnText = [
      `用户：${firstClause(userText, 220)}`,
      assistantText ? `助手：${firstClause(assistantText, 260)}` : '',
      toolLine ? `工具：${toolLine}` : '',
    ].filter(Boolean).join('\n')

    const turnCode = this.encoder.encode(turnText)
    // Segmentation looks at what the user brought in, not at the assistant's
    // boilerplate: an identical "sure, continuing" reply must not hide a topic shift.
    // Surprise blends two brain signals: how unlike past events (reactive, cosine)
    // and how unexpected relative to the temporal prediction (predictive, HTM).
    const eventCode = this.encoder.encode(userText)
    const reactive = this._surprise(store, eventCode, state.segment)
    const active = store.conceptsOf(userText, 6)
    const predicted = store.predictNext(state.prevConcepts)
    const predictedHits = active.filter((concept) => predicted.includes(concept)).length
    const anomaly = active.length > 0 ? 1 - predictedHits / active.length : 0
    const surprise = clamp(0.6 * reactive + 0.4 * anomaly)
    store.learnTransition(state.prevConcepts, active)
    state.prevConcepts = active
    const userSentiment = sentiment(userText) || sentiment(assistantText)
    const goalish = GOAL.test(userText)
    const importance = clamp(
      0.22 +
        0.12 * Math.min(userText.length / 120, 1) +
        0.2 * (IMPORTANT.test(userText) ? 1 : 0) +
        0.12 * (goalish ? 1 : 0) +
        0.1 * Math.min(tools.length / 3, 1) +
        0.12 * Math.min(errors / 2, 1) +
        0.1 * (Math.abs(userSentiment) > 0 ? 1 : 0),
    )

    const risky = RISK.test(userText)
    const positiveSignal =
      userSentiment > 0 ||
      /(已经|已(完成|修复|更新|部署|回滚|提交|通过|解决|删除)|通过了|成功了|修好了|搞定了|问题解决了|done|fixed|passed|resolved|rolled back)/i.test(assistantText)
    const actedOk = errors === 0 && successes > 0
    const congruent = errors > 0
      ? -0.5 + 0.2 * Math.max(0, userSentiment)
      : 0.12 + (actedOk ? 0.3 : 0) + (positiveSignal ? 0.28 : 0) + 0.4 * Math.max(0, userSentiment)
    const dims = {
      relevance: clamp(0.45 + 0.25 * Math.min(userText.length / 200, 1) + 0.2 * (goalish ? 1 : 0) + 0.1 * Math.min(tools.length / 2, 1)),
      congruence: clamp(congruent, -1, 1),
      novelty: clamp(0.15 + 0.35 * surprise),
      certainty: clamp(0.72 - 0.35 * Math.min(errors, 2) - (risky ? 0.12 : 0)),
      agency: userSentiment > 0 ? 0.2 : tools.length > 0 ? 0.9 : 0.5,
      control: clamp(userSentiment > 0 ? 0.45 : errors > 0 ? 0.35 : 0.8),
      norm: 0,
      urgency: clamp(0.2 + 0.45 * (URGENT.test(userText) ? 1 : 0) + (risky ? 0.2 : 0)),
      magnitude: clamp(0.3 + 0.3 * (errors > 0 ? 1 : 0) + 0.2 * Math.min(tools.length / 3, 1) + 0.15 * (IMPORTANT.test(userText) ? 1 : 0) + (risky ? 0.1 : 0)),
    }
    // Goal utility (GAMYGDALA): progress toward stated goals modulates congruence.
    dims.congruence = clamp(dims.congruence + 0.4 * this._goalDesirability(userText, { errors, successes }), -1, 1)
    const summary = `${firstClause(userText, 56)} → ${errors > 0 ? '遇到问题' : assistantText ? '给出了回应' : '执行了操作'}`
    const emotion = this.affect.appraise(dims, { cause: summary, now })
    if (errors === 0) this.affect.outcome({ success: true, magnitude: 0.25 + 0.35 * Math.min(successes, 2) / 2, now })

    // Temporal context drifts with every turn; the episode keeps the snapshot taken at close.
    state.context = updateContext(state.context, turnCode, { k: this.encoder.k })
    this._pushWorkingMemory(state, { summary, importance, at: now })
    this._maybeReconsolidate(state, store, { userText, errors, summary, now })

    // A boundary closes the *previous* event before this turn joins a new one:
    // the shift is what starts the new event, it does not belong to the old one.
    const startsNewEvent =
      Boolean(state.segment) &&
      (surprise >= this.config.segmentation.surpriseThreshold ||
        gapMs >= this.config.segmentation.gapMs ||
        state.segment.turns.length >= this.config.segmentation.maxTurns)
    if (startsNewEvent) this._flushSegment(state, store, { now, emotion })

    if (!state.segment) {
      state.segment = {
        turns: [],
        lines: [],
        summaries: [],
        importance: 0,
        weight: 0,
        affect: { v: 0, a: 0, d: 0 },
        errors: 0,
        toolCount: 0,
        startedAt: now,
        lastAt: now,
        seqs: [],
      }
    }
    const segment = state.segment
    segment.turns.push(state.turn || segment.turns.length + 1)
    if (Number.isFinite(state.lastUserSeq)) segment.seqs.push(state.lastUserSeq)
    segment.lines.push(turnText)
    segment.summaries.push(summary)
    segment.importance = Math.max(segment.importance, importance)
    segment.weight += 1
    segment.affect.v += this.affect.valence
    segment.affect.a += this.affect.arousal
    segment.affect.d += 0.5 + 0.5 * this.affect.emotion.intensity
    segment.errors += errors
    segment.toolCount += tools.length
    segment.lastAt = now
    segment.code = eventCode
    // Crash-safe: the open event is persisted after every turn, so a host crash
    // costs at most the current turn instead of the whole open event.
    this._savePending(state, segment)

    // A high-stakes or failed turn is its own episode; do not dissolve it into a
    // longer event where its lesson would be averaged away.
    if (importance >= 0.72 || errors > 0) return this._flushSegment(state, store, { now, emotion })
    return undefined
  }

  _surprise(store, code, segment) {
    let max = 0
    for (const ep of store.episodes.slice(-40)) max = Math.max(max, this.encoder.similarity(code, ep.code))
    // The open event is not in the store yet; without it every continuation would
    // look maximally surprising and split into a memory per turn.
    if (segment?.code) max = Math.max(max, this.encoder.similarity(code, segment.code))
    return clamp(1 - max)
  }

  /** PFC working memory: 4±1 slots, evicted by low recency × importance. */
  _pushWorkingMemory(state, item) {
    const slots = this.config.workingMemory.slots
    state.wm.push(item)
    while (state.wm.length > slots) {
      let worst = 0
      let worstScore = Infinity
      state.wm.forEach((slot, index) => {
        const score = 0.6 * Math.exp(-(Date.now() - slot.at) / 1800e3) + 0.4 * slot.importance
        if (score < worstScore) {
          worstScore = score
          worst = index
        }
      })
      state.wm.splice(worst, 1)
    }
  }

  /** Turn provenance: what this turn read from / wrote to memory (mnemon's turn bar). */
  _noteTurnMemory(state, kind, { id, summary }) {
    if (!state?.turnMemory) return
    const list = state.turnMemory[kind] ?? []
    if (list.length >= 6) return
    list.push({ id, summary: String(summary ?? '').slice(0, 80) })
  }

  /**
   * Close the current event and write one episode. Segmentation is what turns
   * "one memory per turn" into "one memory per event": continuous work merges,
   * topic shifts, failures and long pauses split (event segmentation theory).
   */
  _flushSegment(state, store, { now, emotion }) {
    const segment = state.segment
    state.segment = null
    if (!segment || segment.lines.length === 0) return undefined
    const text = segment.lines.join('\n').slice(0, this.config.autoCapture.maxTextChars)
    const summary = segment.summaries.length > 1
      ? `${segment.summaries[0]} … ${segment.summaries.at(-1)}`
      : segment.summaries[0]
    const affect = { v: segment.affect.v / segment.weight, a: segment.affect.a / segment.weight, d: segment.affect.d / segment.weight }
    const episode = store.encodeEpisode({
      text,
      summary,
      at: segment.lastAt,
      sessionId: state.id,
      turn: segment.turns.at(-1),
      segments: segment.turns,
      kind: 'episodic',
      tags: [emotion?.key ?? 'calm', segment.errors > 0 ? 'error' : 'ok', ...(segment.importance > 0.7 ? ['important'] : [])],
      affect,
      importance: segment.importance,
      salience: clamp(0.3 + 0.5 * this.affect.salienceGain * Math.abs(affect.v) + 0.2 * (segment.errors > 0 ? 1 : 0)),
      outcome: { success: segment.errors === 0, errors: segment.errors },
      source: 'turn',
      contextCode: state.context,
      rawSeqs: segment.seqs,
    })
    this._noteTurnMemory(state, 'wrote', { id: episode.id, summary: episode.summary })
    this._clearPending(state)
    this._updateSelf({ episode, emotion: emotion ?? this.affect.emotion, errors: segment.errors, toolCount: segment.toolCount, store })
    this.turnCount++
    this._schedulePersist()
    if (this.turnCount % this.config.consolidation.everyTurns === 0) {
      store.consolidate({ now, minCluster: this.config.consolidation.minCluster, stage: 'both' })
      this.lastConsolidateAt = now
    }
    return episode
  }

  /** A contradicted memory is updated in place, not duplicated (reconsolidation). */
  _maybeReconsolidate(state, store, { userText, errors, summary, now }) {
    if (userText.length === 0) return
    const hit = store.recall(userText, { k: 1, now, reinforce: false, contextCode: state.context })[0]
    if (!hit || hit.probability < 0.5) return
    const ep = hit.episode
    const conflict = ep.outcome && ((ep.outcome.success && errors > 0) || (!ep.outcome.success && errors === 0))
    const flip = ep.affect.v * this.affect.valence < -0.2 && Math.abs(ep.affect.v - this.affect.valence) > 0.6
    if (!conflict && !flip) return
    store.reconsolidate(ep.id, {
      summary: `${ep.summary}；后续：${summary}`,
      affect: { v: this.affect.valence, a: this.affect.arousal, d: ep.affect.d },
      outcome: { success: errors === 0, errors },
      note: summary,
    })
  }

  _updateSelf({ episode, emotion, errors, toolCount, store }) {
    const counters = this.self.counters
    counters.turns++
    counters.tools += toolCount
    counters.successes += errors === 0 ? 1 : 0
    counters.failures += errors > 0 ? 1 : 0
    counters.emotions[emotion.key] = (counters.emotions[emotion.key] ?? 0) + 1
    this.self.updatedAt = Date.now()
    this.self.themes = store.topConcepts(6).map((concept) => concept.name)
    if (episode.importance > 0.7) {
      this.self.milestones.push({ at: episode.at, summary: episode.summary, emotion: emotion.label })
      this.self.milestones = this.self.milestones.slice(-20)
    }
    // Expressed behavior nudges traits very slowly; a failure nudges neuroticism up.
    this.personality.observe({
      conscientiousness: clamp(this.personality.get('conscientiousness') + (toolCount > 0 ? 0.03 : -0.01)),
      neuroticism: clamp(this.personality.get('neuroticism') + (errors > 0 ? 0.04 : -0.01)),
      openness: clamp(this.personality.get('openness') + (episode.salience > 0.6 ? 0.02 : 0)),
    })
  }

  // ---- operations exposed to tools -----------------------------------------

  recall(query, { k = 5, kinds, sessionId, reinforce = true } = {}) {
    const store = this._storeForSession(sessionId)
    const state = sessionId ? this.sessions.get(sessionId) : null
    const hits = store.recall(String(query ?? ''), {
      k,
      kinds,
      reinforce,
      moodValence: this.affect.valence,
      moodBias: this.config.affect.moodBias,
      contextCode: state?.context,
    })
    for (const hit of hits.slice(0, 6)) this._noteTurnMemory(state, 'read', { id: hit.episode.id, summary: hit.episode.summary })
    return hits
  }

  /** Feeling-of-knowing probe: partial match when recall comes back empty. */
  probe(query, sessionId) {
    return this._storeForSession(sessionId).probe(String(query ?? ''))
  }

  /** Procedural memory lookup against a cue. */
  skills(query, sessionId) {
    return this._storeForSession(sessionId).skillsOf(String(query ?? ''))
  }

  /** Explicit forgetting: by ids and/or a query that resolves to one trace. */
  forget({ ids, query, reason = '', sessionId } = {}) {
    const store = this._storeForSession(sessionId)
    const state = sessionId ? this.sessions.get(sessionId) : null
    const targets = Array.isArray(ids) ? ids.slice() : []
    if (typeof query === 'string' && query.trim().length > 0) {
      const hit = store.recall(query, { k: 1, reinforce: false, contextCode: state?.context })[0]
      if (hit && !targets.includes(hit.episode.id)) targets.push(hit.episode.id)
    }
    const removed = []
    for (const id of targets) {
      const result = store.forget(id, { reason })
      if (result) removed.push(result)
    }
    this._schedulePersist()
    return removed
  }

  /** In-place edit of a trace's editable fields. */
  update(id, patch = {}, sessionId) {
    const ep = this._storeForSession(sessionId).update(id, patch)
    if (ep) this._schedulePersist()
    return ep
  }

  // ---- prospective memory (PFC intentions) --------------------------------

  intend({ trigger, action, dueAt } = {}) {
    const triggerTrim = String(trigger ?? '').trim()
    const actionTrim = String(action ?? '').trim()
    if (!triggerTrim || !actionTrim) throw new Error('intend requires both trigger and action')
    const item = {
      id: `in_${Date.now().toString(36)}`,
      trigger: triggerTrim,
      action: actionTrim,
      dueAt: Number.isFinite(Number(dueAt)) ? Number(dueAt) : null,
      done: false,
      createdAt: Date.now(),
    }
    this.intentions.push(item)
    this._schedulePersist()
    return item
  }

  completeIntentions(ids = []) {
    const set = new Set(Array.isArray(ids) ? ids : [])
    let completed = 0
    for (const item of this.intentions) {
      if (set.has(item.id) && !item.done) {
        item.done = true
        completed++
      }
    }
    this._schedulePersist()
    return completed
  }

  _matchIntentions(text, now = Date.now()) {
    const t = String(text ?? '')
    return this.intentions
      .filter((item) => !item.done && (t.includes(item.trigger) || (item.dueAt !== null && item.dueAt <= now)))
      .slice(0, 4)
  }

  // ---- goal utility (GAMYGDALA) -------------------------------------------

  _goalEntries() {
    return this.self.goals.map((goal) => (typeof goal === 'string' ? { text: goal, utility: 1, likelihood: 0.5 } : goal))
  }

  /** desirability = Σ utility_i × Δlikelihood_i, driven by goal-token overlap. */
  _goalDesirability(text, { errors = 0, successes = 0 } = {}) {
    const entries = this._goalEntries()
    if (entries.length === 0) return 0
    const userTokens = new Set(tokenize(String(text ?? '')))
    let total = 0
    for (const goal of entries) {
      const goalTokens = tokenize(String(goal.text ?? ''))
      if (goalTokens.length === 0) continue
      const overlap = goalTokens.filter((token) => userTokens.has(token)).length
      if (overlap === 0) continue
      const delta = errors > 0 ? -0.15 : successes > 0 ? 0.12 : 0.03
      total += (Number(goal.utility) || 1) * delta
    }
    return clamp(total, -1, 1)
  }

  /** Relationship history: affinity is the integral of shared emotion, not a counter. */
  _affinity() {
    const counters = this.self.counters
    const emotions = counters.emotions ?? {}
    const positive = (emotions.joy ?? 0) + (emotions.gratitude ?? 0) + (emotions.pride ?? 0) + (emotions.relief ?? 0)
    const negative = (emotions.frustration ?? 0) + (emotions.anger ?? 0) + (emotions.sadness ?? 0) + (emotions.anxiety ?? 0) + (emotions.fear ?? 0)
    const interactions = counters.turns ?? 0
    const levels = [[5, '相识'], [20, '熟悉'], [50, '亲近'], [120, '信赖'], [300, '挚友']]
    let level = '初见'
    for (const [threshold, name] of levels) if (interactions >= threshold) level = name
    return {
      interactions,
      positive,
      negative,
      positiveShare: Number((positive + negative > 0 ? positive / (positive + negative) : 0.5).toFixed(2)),
      level,
    }
  }

  remember({ text, summary, importance, tags, kind = 'explicit', resident = false, force = false, sessionId } = {}) {
    const store = this._storeForSession(sessionId)
    const state = sessionId ? this.sessions.get(sessionId) : null
    const now = Date.now()
    // Idempotent write: a near-duplicate strengthens the existing trace instead
    // of piling up a second copy (mnemon's dedup, memento's conditional write).
    // `force` bypasses this when the user explicitly wants a separate memory.
    const duplicate = force ? null : store.findDuplicate(text)
    if (duplicate) {
      const updated = store.reconsolidate(duplicate.ep.id, {
        summary: summary ? String(summary) : duplicate.ep.summary,
        affect: { v: this.affect.valence, a: this.affect.arousal, d: duplicate.ep.affect.d },
        note: String(text ?? '').slice(0, 300),
      })
      if (resident) {
        updated.resident = true
        store.dirty = true
      }
      this._noteTurnMemory(state, 'wrote', { id: updated.id, summary: updated.summary })
      this._schedulePersist()
      return { ...updated, duplicate: true }
    }

    const code = this.encoder.encode(String(text ?? ''))
    const recent = store.episodes.slice(-30)
    let maxSim = 0
    for (const ep of recent) maxSim = Math.max(maxSim, this.encoder.similarity(code, ep.code))
    const episode = store.encodeEpisode({
      text: String(text ?? ''),
      summary: summary ? String(summary) : undefined,
      at: now,
      kind,
      resident,
      tags: Array.isArray(tags) ? tags : ['explicit'],
      importance: clamp(Number(importance ?? 0.6)),
      salience: clamp(0.4 + 0.5 * (1 - maxSim)),
      affect: { v: this.affect.valence, a: this.affect.arousal, d: 0.6 },
      contextCode: state?.context,
      source: 'model',
    })
    this._noteTurnMemory(state, 'wrote', { id: episode.id, summary: episode.summary })
    this._schedulePersist()
    return { ...episode, duplicate: false }
  }

  judge(question, options = [], stakes = 'medium', sessionId) {
    const state = sessionId ? this.sessions.get(sessionId) : null
    const judgeLayer = new Judge({ memory: this._storeForSession(sessionId), affect: this.affect, personality: this._personaFor(sessionId) })
    return judgeLayer.judge({ question, options, stakes, now: Date.now(), contextCode: state?.context })
  }

  appraise({ event, dimensions, outcome } = {}) {
    if (outcome === 'success' || outcome === 'failure') {
      this.affect.outcome({ success: outcome === 'success', magnitude: 0.6, cause: String(event ?? '') })
    }
    return this.affect.appraise(dimensions ?? {}, { cause: String(event ?? ''), now: Date.now() })
  }

  consolidate({ modelSummaries, sessionId, stage } = {}) {
    const stores = sessionId ? [this._storeForSession(sessionId)] : [...new Set(this.stores.values())]
    const merged = { applied: [], created: [], semanticNodes: 0, episodes: 0, concepts: 0, schemaEpisodes: 0, stores: [] }
    for (const store of stores) {
      const report = store.consolidate({
        now: Date.now(),
        minCluster: this.config.consolidation.minCluster,
        modelSummaries,
        stage,
      })
      merged.applied.push(...report.applied)
      merged.created.push(...report.created)
      merged.semanticNodes += report.semanticNodes
      merged.episodes += report.episodes
      merged.concepts += report.concepts
      merged.schemaEpisodes += report.schemaEpisodes
      merged.stores.push({ dir: store.dir, ...store.snapshot() })
    }
    this.lastConsolidateAt = Date.now()
    this._schedulePersist()
    return merged
  }

  consolidateIdle() {
    const now = Date.now()
    if (now - this.lastConsolidateAt < this.config.consolidation.intervalMs) return null
    const due = [...new Set(this.stores.values())].filter(
      (store) => store.episodes.filter((ep) => !ep.consolidated).length >= this.config.consolidation.minCluster,
    )
    if (due.length === 0) return null
    return this.consolidate()
  }

  profile(action = 'get', patch = {}, { sessionId, scope = 'global' } = {}) {
    const state = sessionId ? this.sessions.get(sessionId) : null
    if (action === 'set' || action === 'nudge') {
      const preset = patch?.preset && typeof patch.preset === 'string' ? patch.preset : null
      const traits = patch?.traits && typeof patch.traits === 'object' ? patch.traits : null

      if (scope === 'session') {
        if (!state) throw new Error('session 作用域需要当前会话（cerebrum_profile 工具内部已带 sessionId）')
        state.persona = { ...(state.persona ?? {}), ...(preset ? { preset } : {}), ...(traits ? { traits: { ...(state.persona?.traits ?? {}), ...traits } } : {}) }
        this.personaCache.clear()
        // No persistence: a session persona lives exactly as long as the session.
      } else if (scope === 'workspace') {
        const cwd = state?.cwd ?? this.config.cwd
        const current = this.personaOverrides.workspaces?.[cwd] ?? {}
        this.personaOverrides.workspaces[cwd] = { ...current, ...(preset ? { preset } : {}), ...(traits ? { traits: { ...(current.traits ?? {}), ...traits } } : {}) }
        this.personaCache.clear()
        this._schedulePersist()
      } else {
        // Global scope: the base personality itself.
        if (preset) {
          const next = new Personality({ ...this.config.personality, preset })
          this.personality = next
          this.affect.personality = next
        }
        if (traits) this.personality.setTraits(traits)
        if (Array.isArray(patch?.values) && patch.values.length > 0) {
          this.personality.values = patch.values.slice(0, 12).map(String)
          this.self.values = [...this.personality.values]
        }
        if (Array.isArray(patch?.goals)) this.self.goals = patch.goals.slice(0, 12).map(String)
        this.personaCache.clear()
        this._schedulePersist()
      }
    }
    const resolved = this._personaFor(sessionId)
    return {
      personality: resolved.snapshot(),
      params: resolved.params(),
      layers: {
        global: this.personality.preset,
        workspace: state?.cwd ? this.personaOverrides.workspaces?.[state.cwd]?.preset ?? this.personality.preset : this.personality.preset,
        session: state?.persona?.preset ?? null,
      },
      values: this.self.values,
      goals: this.self.goals,
      identity: this.self.identity,
    }
  }

  state(sessionId) {
    const now = Date.now()
    this.affect.decay(now)
    const store = this._storeForSession(sessionId)
    const sessionState = sessionId ? this.sessions.get(sessionId) : null
    const totals = [...new Set(this.stores.values())].reduce(
      (sum, entry) => {
        const snapshot = entry.snapshot()
        return {
          episodes: sum.episodes + snapshot.episodes,
          concepts: sum.concepts + snapshot.concepts,
          edges: sum.edges + snapshot.edges,
          consolidated: sum.consolidated + snapshot.consolidated,
        }
      },
      { episodes: 0, concepts: 0, edges: 0, consolidated: 0 },
    )
    return {
      personality: this.personality.snapshot(),
      affect: this.affect.snapshot(now),
      neuromods: Object.fromEntries(Object.entries(this.affect.neuromods).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      memory: { ...store.snapshot(), total: totals, stores: this.stores.size },
      concepts: store.topConcepts(6),
      skills: store.skills.slice(-8).map((skill) => ({ id: skill.id, when: skill.when, do: skill.do, strength: skill.strength, uses: skill.uses })),
      skillCount: store.skills.length,
      intentions: {
        active: this.intentions.filter((item) => !item.done).length,
        matched: this._matchIntentions(sessionState?.lastUserText ?? ''),
      },
      affinity: this._affinity(),
      workingMemory: (sessionState?.wm ?? []).map((slot) => ({ summary: slot.summary, at: slot.at, importance: slot.importance })),
      turnMemory: sessionState?.turnMemory ?? { read: [], wrote: [] },
      segmentation: { open: Boolean(sessionState?.segment), turns: sessionState?.segment?.turns ?? [] },
      self: {
        identity: this.self.identity,
        values: this.self.values,
        goals: this.self.goals,
        themes: this.self.themes,
        counters: this.self.counters,
        milestones: this.self.milestones.slice(-3),
      },
      recent: store.exportEpisodes(5).map((ep) => ({ summary: ep.summary, at: ep.at, importance: ep.importance, affect: ep.affect })),
      uptimeMs: now - this.startedAt,
      dataDir: store.dir,
    }
  }

  // ---- pet brain (P3) -------------------------------------------------------

  /** Translate the live brain state into pet-shell vocabulary. */
  renderHintsFor(sessionId) {
    const state = this.state(sessionId)
    const persona = this._personaFor(sessionId)
    const sessionState = sessionId ? this.sessions.get(sessionId) : null
    const working = Boolean(state.segmentation?.open) || Date.now() - (sessionState?.lastTurnAt ?? 0) < 60e3
    return renderHints({
      emotionKey: state.affect.emotion?.key,
      intensity: state.affect.emotion?.intensity,
      valence: state.affect.valence,
      arousal: state.affect.arousal,
      dominance: state.affect.dominance,
      personalityPreset: persona.preset,
      affinityLevel: state.affinity.level,
      working,
    })
  }

  /** A pet interaction is an appraisal event; feeding also carries reward. */
  interact(kind, sessionId) {
    const appraisal = INTERACTION_APPRAISALS[kind]
    if (!appraisal) return null
    if (kind === 'feed') this.affect.outcome({ success: true, magnitude: 0.4, cause: appraisal.cause })
    this.affect.appraise(appraisal, { cause: appraisal.cause, now: Date.now() })
    this._schedulePersist()
    return this.renderHintsFor(sessionId)
  }

  // ---- character cards (tavern import) --------------------------------------

  /** Import a SillyTavern-style card (JSON object/string or PNG buffer) as a persona. */
  importCard(cardInput, { apply = false, sessionId } = {}) {
    const presetGenomes = Object.fromEntries(Object.entries(PRESETS).map(([key, value]) => [key, value.traits]))
    const persona = cardToPersona(cardInput, { presetGenomes })
    const existing = this.self.cards?.find((entry) => entry.name === persona.name)
    if (existing) existing.persona = persona
    else {
      this.self.cards = [...(this.self.cards ?? []), { name: persona.name, at: Date.now(), persona }].slice(0, 20)
    }
    if (apply) {
      this.profile('set', { preset: persona.preset, traits: persona.traits }, { sessionId, scope: 'global' })
      if (persona.identity) this.self.identity = persona.identity
    }
    this._schedulePersist()
    return persona
  }

  applyCard(name, { sessionId } = {}) {
    const entry = this.self.cards?.find((item) => item.name === name)
    if (!entry) return null
    this.profile('set', { preset: entry.persona.preset, traits: entry.persona.traits }, { sessionId, scope: 'global' })
    if (entry.persona.identity) this.self.identity = entry.persona.identity
    this._schedulePersist()
    return entry.persona
  }

  /** Read a file for tool inputs (character-card PNGs). Capped to avoid OOM. */
  readFile(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return null
    try {
      const resolved = path.resolve(filePath)
      const stat = fs.statSync(resolved)
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return null
      return fs.readFileSync(resolved)
    } catch {
      return null
    }
  }

  // ---- prompt rendering -----------------------------------------------------

  /**
   * Render the dynamic cognitive state for the prompt variable.
   * Budgeted: the model gets a compact situational card, not a data dump.
   */
  renderPromptState(sessionId) {
    if (!this.config.prompt.enabled) return ''
    const now = Date.now()
    this.affect.decay(now)
    const state = sessionId ? this.sessions.get(sessionId) : null
    const query = state?.lastUserText ?? ''
    const k = this.config.prompt.recallK
    const store = this._storeForSession(sessionId)
    const hits = query.length > 0 ? store.recall(query, { k, moodValence: this.affect.valence, moodBias: this.config.affect.moodBias, reinforce: false, contextCode: state?.context }) : []

    const persona = this._personaFor(sessionId)
    const P = persona.params()
    const affect = this.affect
    const lines = []
    lines.push(`- 人格：${persona.describe()}`)
    lines.push(
      `- 情绪：${affect.emotion.label}（强度 ${affect.emotion.intensity.toFixed(2)}）· 效价 ${affect.valence.toFixed(2)} · 唤醒 ${affect.arousal.toFixed(2)} · 支配 ${affect.dominance.toFixed(2)} · 心境${affect.moodValence >= 0 ? '偏正' : '偏负'}`,
    )
    lines.push(
      `- 神经调质：DA ${fmt(affect.neuromods.da)}｜5-HT ${fmt(affect.neuromods.ser)}｜NE ${fmt(affect.neuromods.ne)}｜ACh ${fmt(affect.neuromods.ach)}（影响探索、耐心、警觉与学习率）`,
    )
    if (this.self.values.length > 0) lines.push(`- 价值排序：${this.self.values.slice(0, 4).join('、')}`)
    if (this.self.goals.length > 0) lines.push(`- 长期目标：${this.self.goals.slice(0, 3).join('；')}`)
    if (state?.wm?.length > 0) {
      const slots = state.wm.map((slot, index) => `${'①②③④⑤⑥⑦⑧⑨'[index] ?? index + 1}${slot.summary.slice(0, 36)}`)
      lines.push(`- 工作记忆（${state.wm.length}/${this.config.workingMemory.slots}）：${slots.join(' ｜ ')}`)
    }

    // Resident layer: preferences / working agreements / schemas, always visible,
    // budgeted separately so a long project does not crowd out the live state.
    const resident = store.resident(4)
    if (resident.length > 0) {
      const residentLine = `- 常驻记忆：${resident.map((ep) => ep.summary.slice(0, 48)).join(' ｜ ')}`
      lines.push(residentLine.slice(0, this.config.prompt.residentMaxChars + 7))
    }

    // Procedural memory: a matched `when → do` rule is the "known way" to act.
    const skills = store.skillsOf(query, { limit: 1, threshold: 0.35 })
    if (skills.length > 0) lines.push(`- 既有做法：${skills[0].skill.do.slice(0, 90)}`)

    // Prospective memory: triggers that fired now become visible reminders.
    const reminders = this._matchIntentions(query, now)
    if (reminders.length > 0) lines.push(`- 前瞻提醒：${reminders.map((item) => item.action).join(' ｜ ')}`)

    // Episodic layer: recall is injected only when it is confidently relevant,
    // and only the single winner is broadcast (LIDA/GWT) — the rest stay as
    // sub-conscious candidates retrievable through cerebrum_recall.
    const best = hits[0]
    if (best && best.probability >= this.config.prompt.recallThreshold) {
      const ep = best.episode
      const tone = ep.affect.v > 0.15 ? '正' : ep.affect.v < -0.15 ? '负' : '中'
      const retention = Math.round(store.retention(ep, now) * 100)
      lines.push(`- 相关记忆（置信 ${best.probability.toFixed(2)}，保有 ${retention}%）：${ep.summary}（${tone}向）`)
      if (hits.length > 1) lines.push(`  · 另有 ${hits.length - 1} 条次意识候选，需要时用 cerebrum_recall 展开`)
    } else if (query.length > 0 && resident.length === 0) {
      lines.push('- 相关记忆：无（这是一段新经验，注意从头建立上下文）')
    }

    if (state?.turnMemory && (state.turnMemory.read.length > 0 || state.turnMemory.wrote.length > 0)) {
      lines.push(`- 本轮记忆活动：读 ${state.turnMemory.read.length} · 写 ${state.turnMemory.wrote.length}`)
    }

    const bias = []
    bias.push(`谨慎 ${fmt(1 - P.exploration)}`)
    bias.push(`探索 ${fmt(P.exploration)}`)
    bias.push(`冲动抑制 ${fmt(affect.inhibition(P.impulseInhibition))}`)
    bias.push(`损失厌恶 ${fmt(affect.lossAversion(P.lossAversion) / 3)}`)
    lines.push(`- 当前决策倾向：${bias.join(' · ')}`)

    let text = lines.join('\n')
    const max = this.config.prompt.maxChars
    if (text.length > max) {
      // Never split a surrogate pair (emoji) at the cut point.
      let cut = text.slice(0, max - 1)
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
      text = `${cut}…`
    }
    return text
  }

  /** Section header registered once; the variable carries the dynamic body. */
  static get SECTION_NAME() {
    return 'cerebrum:cognitive-state'
  }

  static get SECTION_TEXT() {
    return [
      '## 认知状态（dsh-cerebrum）',
      '下面是你此刻的内部状态，由仿脑记忆、情绪与性格系统实时生成。把它当作背景与倾向，不要逐条复述，也不要假装拥有未列出的记忆。',
      '{{cerebrum_state}}',
    ].join('\n')
  }
}

const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2)

export { timeAgo, textOf }
