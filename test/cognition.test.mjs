import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AffectSystem } from '../lib/core/affect.js'
import { Judge } from '../lib/core/judge.js'
import { MemoryStore } from '../lib/core/memory.js'
import { Personality } from '../lib/core/personality.js'
import { SdrEncoder } from '../lib/core/sdr.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('SDR: deterministic, sparse, and semantically ordered', () => {
  const a = encoder.encode('修复登录接口的鉴权 bug')
  const b = encoder.encode('修复登录接口的鉴权 bug')
  assert.deepEqual(a.idx, b.idx)
  assert.ok(a.size <= 24)

  const paraphrase = encoder.encode('登录接口鉴权失败，需要修复')
  const unrelated = encoder.encode('写一首关于春天的诗')
  const close = encoder.similarity(a, paraphrase)
  const far = encoder.similarity(a, unrelated)
  assert.ok(close > far + 0.05, `expected paraphrase ${close} > unrelated ${far}`)
})

test('Memory: cue-driven recall ranks the relevant episode first', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  memory.encodeEpisode({ text: '部署生产环境时数据库迁移失败，回滚后恢复', summary: '部署失败并回滚', at: Date.now() - 3600e3, importance: 0.8, affect: { v: -0.6, a: 0.7 } })
  memory.encodeEpisode({ text: '中午吃了牛肉面，味道一般', summary: '午饭牛肉面', at: Date.now() - 1800e3, importance: 0.1, affect: { v: 0.1, a: 0.2 } })
  memory.encodeEpisode({ text: '修复了登录接口的鉴权 bug，测试通过', summary: '修复鉴权 bug', at: Date.now() - 600e3, importance: 0.6, affect: { v: 0.5, a: 0.5 } })

  const hits = memory.recall('数据库迁移 部署 失败', { k: 3 })
  assert.ok(hits.length >= 1 && hits.length <= 3)
  assert.match(hits[0].episode.text, /数据库迁移失败/)
  assert.ok(hits[0].probability > 0.5)
})

test('Memory: base-level activation rewards recency and frequency', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  const now = Date.now()
  const old = memory.encodeEpisode({ text: '旧的记忆：接口超时', at: now - 30 * 86400e3, importance: 0.4 })
  const recent = memory.encodeEpisode({ text: '新的记忆：接口超时', at: now - 60e3, importance: 0.4 })
  assert.ok(memory.baseLevel(recent, now) > memory.baseLevel(old, now))

  const before = memory.baseLevel(old, now)
  old.accesses.push(now - 5 * 86400e3, now - 2 * 86400e3)
  assert.ok(memory.baseLevel(old, now) > before)
})

test('Memory: consolidation extracts semantic nodes and marks episodes', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  for (let i = 0; i < 3; i++) {
    memory.encodeEpisode({ text: `第 ${i} 次与用户确认部署窗口，用户要求先备份`, at: Date.now() - i * 60e3, importance: 0.6 })
  }
  const report = memory.consolidate({ minCluster: 3 })
  assert.ok(report.created.length > 0)
  assert.ok(memory.episodes.every((ep) => ep.consolidated))
  const node = memory.topConcepts(3)[0]
  assert.ok(node.gist.length > 0)
})

test('Memory: persistence round-trips episodes and concepts', () => {
  const dir = tmp()
  const memory = new MemoryStore({ dir, encoder })
  memory.encodeEpisode({ text: '用户偏好：提交信息用中文，且必须带变更理由', summary: '用户偏好中文提交信息', at: 1_700_000_000_000, importance: 0.9 })
  memory.flush()

  const reloaded = new MemoryStore({ dir, encoder }).load()
  assert.equal(reloaded.episodes.length, 1)
  assert.match(reloaded.episodes[0].text, /提交信息用中文/)
  const hits = reloaded.recall('提交信息 语言偏好', { k: 1 })
  assert.equal(hits.length, 1)
})

test('Affect: success and failure move valence in opposite directions', () => {
  const personality = new Personality({ preset: 'curious-engineer' })
  const affect = new AffectSystem({ personality })

  affect.appraise({ relevance: 0.8, congruence: 0.8, novelty: 0.3, certainty: 0.8, control: 0.8, magnitude: 0.7 })
  const joy = { ...affect.emotion }
  const joyValence = affect.valence
  assert.equal(joy.key, 'joy')
  assert.ok(joyValence > 0.2)

  const serBefore = affect.neuromods.ser
  affect.outcome({ success: false, magnitude: 0.8 })
  assert.ok(affect.valence < joyValence)
  assert.ok(affect.neuromods.ser > serBefore)
})

test('Affect: mood and transmitters relax toward the trait baseline', () => {
  const personality = new Personality({ preset: 'restless-artist' })
  const affect = new AffectSystem({ personality })
  affect.appraise({ relevance: 0.9, congruence: -0.9, novelty: 0.8, certainty: 0.2, control: 0.1, urgency: 0.9, magnitude: 0.9 })
  const hot = affect.valence
  affect.updatedAt = Date.now() - 6 * 3600e3
  affect.decay(Date.now())
  assert.ok(affect.valence > hot, 'negative affect should relax upward')
  const baseline = affect.baseline
  assert.ok(Math.abs(affect.neuromods.da - 0.5) < 0.35)
  assert.ok(Math.abs(affect.neuromods.ne - 0.35) < 0.5)
  assert.ok(Math.abs(affect.moodValence - baseline.valence) < 0.5)
})

test('Personality: traits map monotonically onto decision knobs', () => {
  const bold = new Personality({ traits: { openness: 0.95, conscientiousness: 0.2, neuroticism: 0.1 } })
  const careful = new Personality({ traits: { openness: 0.2, conscientiousness: 0.95, neuroticism: 0.9 } })
  assert.ok(bold.params().exploration > careful.params().exploration)
  assert.ok(careful.params().impulseInhibition > bold.params().impulseInhibition)
  assert.ok(careful.params().lossAversion > bold.params().lossAversion)

  const p = new Personality({ preset: 'stoic-guardian' })
  const original = p.get('openness')
  for (let i = 0; i < 500; i++) p.observe({ openness: 1 })
  assert.ok(p.get('openness') > original)
  assert.ok(p.get('openness') <= p.genome.openness + 0.081, 'drift stays inside the genome bound')
})

test('Judge: high stakes and near-ties recruit the slow system', () => {
  const personality = new Personality({ preset: 'stoic-guardian' })
  const affect = new AffectSystem({ personality })
  const memory = new MemoryStore({ dir: tmp(), encoder })
  memory.encodeEpisode({ text: '上次直接改生产数据库导致回滚，教训是先备份', at: Date.now() - 86400e3, importance: 0.9, affect: { v: -0.8, a: 0.8 }, outcome: { success: false, errors: 1 } })

  const judge = new Judge({ memory, affect, personality })
  const result = judge.judge({
    question: '是否立刻删除生产数据库里的一张表？',
    options: ['立刻删除生产数据库里的一张表', '先备份并确认后再迁移'],
    stakes: 'high',
  })
  assert.ok(['S2', 'S1-vetoed'].includes(result.system), `unexpected system ${result.system}`)
  assert.ok(result.checklist.length > 0)
  assert.ok(result.confidence > 0 && result.confidence <= 1)
  assert.ok(result.options.length === 2)
  assert.notEqual(result.choice, '立刻删除生产数据库里的一张表')
})

test('Judge: without options it returns a stance plus checklist', () => {
  const personality = new Personality({ preset: 'warm-companion' })
  const affect = new AffectSystem({ personality })
  const memory = new MemoryStore({ dir: tmp(), encoder })
  const judge = new Judge({ memory, affect, personality })
  const result = judge.judge({ question: '要不要重构这个模块？' })
  assert.equal(result.system, 'S1')
  assert.ok(typeof result.choice === 'string' && result.choice.length > 0)
  assert.ok(result.checklist.length >= 5)
  assert.ok(result.confidence > 0)
})
