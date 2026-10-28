import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { AffectSystem } from '../lib/core/affect.js'
import { MemoryStore } from '../lib/core/memory.js'
import { Personality } from '../lib/core/personality.js'
import { SdrEncoder } from '../lib/core/sdr.js'
import { CerebrumService } from '../lib/service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-oss-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('hybrid retrieval: exact tokens are found even with no semantic overlap', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  memory.encodeEpisode({ text: '错误码 E_SESSION_EXPIRED 表示会话过期，需要重新登录', at: Date.now() - 600e3, importance: 0.5 })
  memory.encodeEpisode({ text: '首页插画改成温暖风格', at: Date.now() - 300e3, importance: 0.3 })
  const hits = memory.recall('E_SESSION_EXPIRED', { k: 2 })
  assert.equal(hits.length >= 1, true)
  assert.match(hits[0].episode.text, /E_SESSION_EXPIRED/)
  assert.ok((hits[0].parts.lex ?? 0) > 0, 'lexical evidence must fire')
})

test('idempotent writes: a duplicate is strengthened, not duplicated', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-dedup-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'dedup', header: { cwd: path.join(home, 'ws') } }
  const first = service.remember({ text: '偏好：提交信息用中文并带变更理由', sessionId: session.id })
  const second = service.remember({ text: '偏好：提交信息用中文并带变更理由', sessionId: session.id })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(service._storeForSession('dedup').episodes.length, 1)
  assert.ok(second.reconsolidations >= 1)
  service.dispose()
})

test('resident layer: preferences are always-injected and kept apart from episodic recall', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-resident-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'res', header: { cwd: path.join(home, 'ws') } }
  service.remember({ text: '用户偏好：部署前必须先跑迁移演练', resident: true, sessionId: session.id })
  service.remember({ text: '昨天吃过牛肉面，味道一般', sessionId: session.id })

  const resident = service._storeForSession('res').resident()
  assert.equal(resident.length, 1)
  assert.equal(resident[0].resident, true)

  const prompt = service.renderPromptState(session.id)
  assert.match(prompt, /常驻记忆/)
  assert.match(prompt, /迁移演练/)
  assert.doesNotMatch(prompt, /牛肉面/, 'episodic noise should not reach the resident layer')
  service.dispose()
})

test('turn provenance: reads and writes are recorded for the current turn', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-prov-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'prov', header: { cwd: path.join(home, 'ws') } }
  service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '迁移演练' }], source: { kind: 'user' } } } })
  service.remember({ text: '迁移演练要在周三晚上进行', sessionId: session.id })
  service.recall('迁移演练', { sessionId: session.id })
  const state = service.state(session.id)
  assert.ok(state.turnMemory.read.length >= 1)
  assert.ok(state.turnMemory.wrote.length >= 1)
  service.dispose()
})

test('attention economy: cue use primes a concept, sleep decays it (ECAN)', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  const ep = memory.encodeEpisode({ text: '数据库迁移前必须先备份', at: Date.now() - 600e3, importance: 0.5 })
  const concept = ep.concepts[0]
  memory.recall(concept, { k: 1 })
  const primed = memory.concepts.get(concept)?.hot ?? 0
  assert.ok(primed > 0, 'using a concept as a cue must prime it')
  memory.consolidate({ stage: 'both' })
  assert.ok((memory.concepts.get(concept)?.hot ?? 0) < primed, 'sleep must decay attention (rent)')
})

test('recall latency follows activation (ACT-R)', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  memory.encodeEpisode({ text: '接口超时，重试后成功', at: Date.now() - 120e3, importance: 0.6 })
  memory.encodeEpisode({ text: '首页插画用温暖风格', at: Date.now() - 60e3, importance: 0.3 })
  const hits = memory.recall('接口超时 重试', { k: 2 })
  const best = hits[0]
  assert.ok(Number.isFinite(best.parts.latency))
  assert.ok(best.parts.latency < 350, 'strong activation yields fast retrieval')
})

test('single-winner broadcast: prompt injects one memory, others as sub-conscious', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-broadcast-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws'), prompt: { recallThreshold: 0.1 } }))
  const session = { id: 'bc', header: { cwd: path.join(home, 'ws') } }
  service.remember({ text: '数据库迁移要先备份，否则会丢数据', sessionId: session.id })
  service.remember({ text: '数据库迁移还要做幂等校验', sessionId: session.id })
  service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '数据库迁移' }], source: { kind: 'user' } } } })
  const prompt = service.renderPromptState(session.id)
  assert.match(prompt, /相关记忆/)
  assert.match(prompt, /次意识候选/, 'the other match should be folded into a count, not injected')
  service.dispose()
})

test('temporal memory: sequence prediction separates continuity from surprise', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  memory.learnTransition(['迁移', '备份'], ['迁移', '回滚'])
  const predicted = memory.predictNext(['迁移'])
  assert.ok(predicted.includes('回滚'), 'the next concept should be predictable')

  const continuityHits = ['迁移', '回滚'].filter((c) => predicted.includes(c)).length
  const anomaly = 1 - continuityHits / 2
  assert.ok(anomaly < 0.5, 'a predicted continuation is not surprising')
  const surprising = ['插画', '首页'].filter((c) => predicted.includes(c)).length
  assert.equal(1 - surprising / 2, 1, 'an unpredicted topic is maximally surprising')
})

test('PAD: personality defines the affective setpoint, control drives dominance', () => {
  const personality = new Personality({ preset: 'stoic-guardian' })
  const pad = personality.pad()
  assert.ok(pad.dominance > 0, 'high conscientiousness/extraversion raise dominance')
  const affect = new AffectSystem({ personality })
  assert.ok(Math.abs(affect.baseline.dominance - pad.dominance) < 1e-9)
  const before = affect.dominance
  affect.appraise({ relevance: 0.7, congruence: 0.6, control: 0.9, magnitude: 0.5 })
  assert.ok(affect.dominance > before, 'controllable situations should raise dominance')
})
