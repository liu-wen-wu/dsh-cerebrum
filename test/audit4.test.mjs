import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MemoryStore } from '../lib/core/memory.js'
import { SdrEncoder } from '../lib/core/sdr.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-audit4-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('recall: only the winner is rehearsed; merely-considered traces are untouched', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  memory.encodeEpisode({ text: '生产环境数据库迁移失败，先回滚队列配置', at: Date.now() - 3600e3, importance: 0.8, outcome: { success: false, errors: 1 } })
  memory.encodeEpisode({ text: '首页插画改成温暖风格，配色用米白与橙色', at: Date.now() - 1800e3, importance: 0.3, outcome: { success: true, errors: 0 } })
  memory.encodeEpisode({ text: '把日志级别从 debug 调回 info', at: Date.now() - 600e3, importance: 0.4, outcome: { success: true, errors: 0 } })

  const before = new Map(memory.episodes.map((ep) => [ep.id, ep.stability]))
  const hits = memory.recall('数据库迁移 回滚 队列', { k: 3 })
  const winner = hits[0].episode.id
  const picked = new Set(hits.map((hit) => hit.episode.id))

  assert.ok(hits.length >= 1)
  for (const ep of memory.episodes) {
    if (ep.id === winner) continue
    const prev = before.get(ep.id)
    if (picked.has(ep.id)) {
      assert.ok(ep.stability <= prev + 1e-9, `picked competitor ${ep.id} must not gain stability`)
    } else {
      assert.equal(ep.stability, prev, `unretrieved ${ep.id} must stay unchanged`)
    }
  }
})

test('consolidation: orphaned weak concepts are garbage-collected, referenced ones stay', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  const episode = memory.encodeEpisode({ text: '迁移前先备份数据库', at: Date.now() - 3600e3, importance: 0.6, outcome: { success: true, errors: 0 } })
  const referenced = episode.concepts[0]
  assert.ok(referenced, 'the episode must produce concepts')

  const old = Date.now() - 120 * 24 * 60 * 60 * 1000
  memory.concepts.set('孤立的旧概念', { strength: 0.3, count: 1, lastAt: old, gist: '', lessons: [], theta: 0.25, hot: 0, history: [], schema: false })
  memory.concepts.set('最近的概念', { strength: 0.3, count: 1, lastAt: Date.now(), gist: '', lessons: [], theta: 0.25, hot: 0, history: [], schema: false })

  const removed = memory._pruneConcepts(Date.now())
  assert.ok(removed >= 1)
  assert.equal(memory.concepts.has('孤立的旧概念'), false, 'stale orphan concept is dropped')
  assert.equal(memory.concepts.has('最近的概念'), true, 'recent concept is kept')
  assert.equal(memory.concepts.has(referenced), true, 'concept referenced by an episode is kept')
})
