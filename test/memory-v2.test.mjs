import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SpikingAssembly, codeDot } from '../lib/core/assembly.js'
import { MemoryStore } from '../lib/core/memory.js'
import { replayPriority, stdpDelta, updateContext } from '../lib/core/plasticity.js'
import { SdrEncoder } from '../lib/core/sdr.js'
import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-v2-'))
const encoder = new SdrEncoder({ dim: 2048, k: 32 })

const store = () => new MemoryStore({ dir: tmp(), encoder })

test('v2 encoder: word order changes the code', () => {
  const forward = encoder.encode('迁移前必须先备份')
  const reversed = encoder.encode('备份前必须先迁移')
  assert.ok(encoder.similarity(forward, reversed) < 0.95, 'trigrams must make order matter')
  assert.deepEqual(forward.idx, encoder.encode('迁移前必须先备份').idx)
})

test('v2 attractor: a partial cue is completed into the full episode', () => {
  const memory = store()
  memory.encodeEpisode({ text: '生产环境数据库迁移失败，先回滚队列配置再排查', summary: '迁移失败回滚', at: Date.now() - 3000e3, importance: 0.8 })
  memory.encodeEpisode({ text: '首页插画改成温暖风格，配色用米白与橙色', summary: '插画风格', at: Date.now() - 2000e3, importance: 0.3 })
  memory.encodeEpisode({ text: '把 logging 级别从 debug 调回 info，减少日志噪音', summary: '日志级别', at: Date.now() - 1000e3, importance: 0.4 })

  const hits = memory.recall('数据库迁移 回滚 队列', { k: 2 })
  assert.equal(hits.length >= 1, true)
  assert.match(hits[0].episode.text, /数据库迁移失败/)
  assert.ok(hits[0].parts.attractor >= 1, 'attractor settling should have run')
})

test('v2 TCM: temporal context disambiguates identical content', () => {
  const memory = store()
  const text = '部署窗口确认在周三晚上'
  const first = memory.encodeEpisode({ text, at: Date.now() - 3600e3, importance: 0.4, contextCode: encoder.encode('alpha 项目 启动') })
  const second = memory.encodeEpisode({ text, at: Date.now() - 60e3, importance: 0.4, contextCode: encoder.encode('beta 项目 上线') })

  const towardFirst = memory.recall('部署窗口', { k: 2, contextCode: first.context })
  const towardSecond = memory.recall('部署窗口', { k: 2, contextCode: second.context })
  assert.equal(towardFirst[0].episode.id, first.id)
  assert.equal(towardSecond[0].episode.id, second.id)
  assert.ok(towardSecond[0].parts.context > 0.5)
})

test('v2 plasticity: directed co-activation and STDP create forward associations', () => {
  const memory = store()
  const first = memory.encodeEpisode({ text: '备份 迁移 演练', at: Date.now() - 20 * 60e3, importance: 0.6 })
  const [a, b] = first.concepts
  const forward = memory.edges.get(`${a}\u0001${b}`)?.w ?? 0
  const backward = memory.edges.get(`${b}\u0001${a}`)?.w ?? 0
  assert.ok(forward > 0, 'forward edge should exist')
  assert.ok(forward > backward, 'early→late should be stronger than late→early')

  const second = memory.encodeEpisode({ text: '迁移完成 回滚脚本 归档', at: Date.now() - 10 * 60e3, importance: 0.6 })
  const crossed = first.concepts.slice(0, 2).flatMap((from) =>
    second.concepts.slice(0, 2).map((to) => memory.edges.get(`${from}\u0001${to}`)?.w ?? 0),
  )
  assert.ok(Math.max(...crossed) > 0, 'temporally adjacent episodes should form a forward link')
})

test('v2 interference: the loser of a close competition is suppressed', () => {
  const memory = store()
  const first = memory.encodeEpisode({ text: '接口超时，重试后成功', at: Date.now() - 120e3, importance: 0.5 })
  const second = memory.encodeEpisode({ text: '接口超时，重试后成功', at: Date.now() - 60e3, importance: 0.5 })
  const before = [first.stability, second.stability]
  memory.recall('接口超时 重试', { k: 2 })
  const after = [first.stability, second.stability]
  assert.ok(after[0] < before[0] || after[1] < before[1], 'one competitor must be suppressed')
  assert.ok(Math.max(...after) > Math.min(...before), 'the winner must be rehearsed')
})

test('v2 replay priority favours important, charged, under-rehearsed traces', () => {
  const now = Date.now()
  const hot = { at: now - 3600e3, importance: 0.9, affect: { v: -0.8 }, retrievals: 0 }
  const cold = { at: now - 3600e3, importance: 0.3, affect: { v: 0.05 }, retrievals: 3 }
  assert.ok(replayPriority(hot, { now }) > replayPriority(cold, { now }))
})

test('v2 REM: old memories keep content but lose affect', () => {
  const memory = store()
  const old = memory.encodeEpisode({ text: '上线事故导致整夜排查，压力很大', at: Date.now() - 3 * 86400e3, importance: 0.8, affect: { v: -0.9, a: 0.9 } })
  memory.consolidate({ stage: 'rem' })
  assert.ok(Math.abs(old.affect.v) < 0.9, 'negative charge should decay during REM')
  assert.match(old.text, /上线事故/)
})

test('v2 consolidation: NREM extracts schema and marks schema episodes', () => {
  const memory = store()
  for (let i = 0; i < 4; i++) {
    memory.encodeEpisode({ text: `第 ${i} 次迁移前备份，演练通过后才执行`, at: Date.now() - i * 60e3, importance: 0.7, outcome: { success: true, errors: 0 } })
  }
  const report = memory.consolidate({ stage: 'nrem', minCluster: 3 })
  assert.equal(report.stage, 'nrem')
  assert.ok(report.created.length > 0)
  assert.ok(report.schemaEpisodes >= 1)
  assert.ok(memory.topConcepts(3).some((concept) => concept.schema))
})

test('v2 reconsolidation: a contradicted trace is updated in place', () => {
  const memory = store()
  const ep = memory.encodeEpisode({ text: '迁移脚本已成功执行，无报错', at: Date.now() - 60e3, importance: 0.7, affect: { v: 0.6, a: 0.4 }, outcome: { success: true, errors: 0 } })
  memory.reconsolidate(ep.id, { summary: '迁移曾被判定成功，后续发现唯一约束冲突', affect: { v: -0.5, a: 0.7 }, outcome: { success: false, errors: 1 }, note: '唯一约束冲突' })
  assert.equal(memory.byId.get(ep.id).reconsolidations, 1)
  assert.equal(memory.byId.get(ep.id).outcome.success, false)
  assert.match(memory.byId.get(ep.id).text, /重构/)
  assert.ok(memory.byId.get(ep.id).affect.v < 0.6)
})

test('v2 TCM: the blended context keeps unit norm (ρ²+β²=1)', () => {
  const previous = encoder.encode('alpha 项目 启动')
  const item = encoder.encode('beta 项目 上线')
  const context = updateContext(previous, item, { k: encoder.k })
  assert.ok(Math.abs(codeDot(context, context) - 1) < 1e-6, 'context must be L2-normalized')
})

test('v2 STDP: the sign follows the temporal order', () => {
  assert.ok(stdpDelta(10) > 0, 'pre-before-post potentiates')
  assert.ok(stdpDelta(-10) < 0, 'post-before-pre depresses')
  assert.ok(stdpDelta(600) < stdpDelta(5), 'the kernel decays with the interval')
})

test('v2 interference: three close candidates leave exactly one winner rehearsed', () => {
  const memory = store()
  const episodes = [0, 1, 2].map((i) =>
    memory.encodeEpisode({ text: '接口超时，重试后成功', at: Date.now() - (200 - i * 40) * 1e3, importance: 0.5 }),
  )
  const before = episodes.map((ep) => ep.stability)
  const hits = memory.recall('接口超时 重试', { k: 3 })
  assert.equal(hits.length, 3)
  const after = episodes.map((ep) => ep.stability)
  const increased = after.filter((value, i) => value > before[i]).length
  assert.equal(increased, 1, 'only the winner is rehearsed')
})

test('v2 spiking assembly: a partial cue re-activates the trained assembly', () => {
  const assembly = new SpikingAssembly({ size: 96, threshold: 0.8 })
  const trained = Array.from({ length: 18 }, (_, i) => i + 10)
  assembly.train(trained)
  const cue = trained.filter((_, i) => i % 2 === 0)
  const { fired } = assembly.settle(cue, { steps: 18 })
  const recalled = fired.filter((neuron) => trained.includes(neuron))
  assert.ok(recalled.length >= 12, `expected pattern completion, fired ${recalled.length}/${trained.length}`)
})

test('v2 service: segmentation merges a continuous event and splits on a topic shift', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-seg-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws'), segmentation: { maxTurns: 6 } }))
  const session = { id: 'seg', header: { cwd: path.join(home, 'ws') } }
  const emit = (event) => service.onSessionEvent(session, event)
  let turnIndex = 0
  const turn = (text) => {
    turnIndex++
    emit({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
    emit({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '继续检查样式变量' }] } } })
    emit({ type: 'turn/end', data: { turn: turnIndex, reason: { kind: 'completed' } } })
  }

  turn('继续检查样式变量，先从主色开始')
  turn('继续检查样式变量，再看间距')
  turn('继续检查样式变量，最后看圆角')
  const store = service._storeForSession('seg')
  assert.equal(store.episodes.length, 0, 'an open event is not written until it closes')
  assert.equal(service.state('seg').segmentation.turns.length, 3)

  turn('数据库迁移失败，回滚并检查唯一约束')
  assert.equal(store.episodes.length, 1, 'the topic shift closes the previous event')
  assert.equal(store.episodes[0].segments.length, 3)
  assert.deepEqual(service.state('seg').segmentation.turns, [4], 'the shift turn opens the next event')
  assert.ok(service.state('seg').workingMemory.length <= service.config.workingMemory.slots)
  service.dispose()
})
