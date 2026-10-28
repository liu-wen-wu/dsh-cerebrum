import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MemoryStore } from '../lib/core/memory.js'
import {
  captureBoost,
  growStability,
  intervalFor,
  lapseStability,
  retrievability,
  updateDifficulty,
} from '../lib/core/retention.js'
import { SdrEncoder } from '../lib/core/sdr.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-ret-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })
const store = () => new MemoryStore({ dir: tmp(), encoder })

test('v3 retention: power-law curve has a long tail, not an exponential cliff', () => {
  assert.ok(Math.abs(retrievability(0, 10) - 1) < 1e-9)
  assert.ok(retrievability(10, 10) > 0.5)
  assert.ok(retrievability(100, 10) > 0.15)
  // Ten years later a well-consolidated trace is still reachable.
  assert.ok(retrievability(3650, 365) > 0.1)
  const exponential = Math.exp(-3650 / (365 / Math.LN2))
  assert.ok(retrievability(3650, 365) > exponential, 'power law must outlive exponential decay')
})

test('v3 retention: stability is the 90% interval', () => {
  assert.ok(Math.abs(intervalFor(10, 0.9) - 10) < 1e-6)
  assert.ok(intervalFor(10, 0.8) > intervalFor(10, 0.9))
})

test('v3 retention: effortful retrieval teaches more (spacing / desirable difficulty)', () => {
  const easy = growStability(10, 0.5, 0.95)
  const hard = growStability(10, 0.5, 0.5)
  assert.ok(hard > easy, 'retrieving when R is low must add more stability')
  assert.ok(easy > 10, 'any successful recall grows stability')
})

test('v3 retention: a lapse resets the trace and raises difficulty', () => {
  assert.ok(lapseStability(10) < 10)
  const harder = updateDifficulty(0.4, { success: false })
  const easier = updateDifficulty(0.4, { success: true, r: 0.6 })
  assert.ok(harder > easier)
})

test('v3 tagging: a strong event captures a weak trace in the same window', () => {
  const memory = store()
  const weak = memory.encodeEpisode({ text: '顺手整理了一下日志格式', at: Date.now() - 30 * 60e3, importance: 0.2, salience: 0.25 })
  const before = weak.stability
  memory.encodeEpisode({ text: '线上事故：数据库迁移失败并回滚，全组排查', at: Date.now(), importance: 0.9, salience: 0.9, affect: { v: -0.9, a: 0.9 } })
  assert.ok(weak.tagged, 'weak trace should be tagged by the strong event')
  assert.ok(weak.stability > before, 'tagged trace should gain stability')
  assert.ok(captureBoost(0.9, 10) > 1 && captureBoost(0.3, 10) === 1)
})

test('v3 interference: a similar new trace weakens the old one', () => {
  const memory = store()
  const old = memory.encodeEpisode({ text: '接口超时，重试后成功', at: Date.now() - 3600e3, importance: 0.6 })
  const before = old.stability
  memory.encodeEpisode({ text: '接口超时，重试后成功', at: Date.now(), importance: 0.6 })
  assert.ok(old.stability < before, 'retroactive interference should reduce old stability')
  assert.ok(old.interferences >= 1)
})

test('v3 schema: consolidated schemas become permastore candidates', () => {
  const memory = store()
  for (let i = 0; i < 4; i++) {
    memory.encodeEpisode({ text: `第 ${i} 次迁移前备份，演练通过后才执行`, at: Date.now() - i * 60e3, importance: 0.7, outcome: { success: true, errors: 0 } })
  }
  memory.consolidate({ stage: 'nrem', minCluster: 3 })
  const schema = memory.episodes.filter((ep) => ep.schema)
  assert.ok(schema.length >= 1)
  assert.ok(schema.every((ep) => ep.stability >= 180))
})

test('v3 probe: a partial cue reports a feeling of knowing', () => {
  const memory = store()
  memory.encodeEpisode({ text: '周三晚上做数据库迁移演练，先备份', at: Date.now() - 3600e3, importance: 0.6 })
  const probe = memory.probe('迁移 演练 备份')
  assert.ok(probe.similarity > 0.05)
  assert.match(probe.episode.text, /迁移/)
})

test('v3 reviews survive a restart (append-only review log)', () => {
  const dir = tmp()
  const first = new MemoryStore({ dir, encoder })
  const ep = first.encodeEpisode({ text: '迁移前先备份并做幂等校验', at: Date.now() - 7200e3, importance: 0.6 })
  const before = ep.stability
  first.recall('迁移 备份', { k: 1 })
  const after = ep.stability
  assert.ok(after > before)
  first.flush()

  const second = new MemoryStore({ dir, encoder }).load()
  const restored = second.byId.get(ep.id)
  assert.ok(Math.abs(restored.stability - after) < 0.02, 'stability must survive reload')
  assert.ok(restored.retrievals >= 1)
  assert.ok(restored.lastReviewAt > 0)
})
