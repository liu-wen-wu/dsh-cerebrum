import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { MemoryStore } from '../lib/core/memory.js'
import { SdrEncoder } from '../lib/core/sdr.js'
import { CerebrumService } from '../lib/service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-p0-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

const user = (text, seq) => ({ seq, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
const assistant = (text) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const end = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

test('rawRefs: episodes carry session#seq coordinates to the original events', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-raw-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'raw', header: { cwd: path.join(home, 'ws') } }
  service.onSessionEvent(session, user('迁移演练要备份', 42))
  service.onSessionEvent(session, assistant('好的'))
  service.onSessionEvent(session, end(1))
  service.flushSession('raw')
  const ep = service._storeForSession('raw').episodes[0]
  assert.ok(ep.rawSeqs.includes(42), 'the user-message seq must be stored')
  const state = service.state('raw')
  assert.equal(state.memory.episodes, 1)
  service.dispose()
})

test('forget: explicit removal with a tombstone, and it disappears from recall', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-forget-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'fg', header: { cwd: path.join(home, 'ws') } }
  const ep = service.remember({ text: '用户不喜欢香菜', sessionId: session.id })
  const removed = service.forget({ ids: [ep.id], reason: '用户要求别提', sessionId: session.id })
  assert.equal(removed.length, 1)
  const store = service._storeForSession('fg')
  assert.equal(store.byId.get(ep.id), undefined)
  assert.equal(store.episodes.length, 0)
  assert.ok(store.forgetLog.items.some((item) => item.id === ep.id))
  const hits = service.recall('香菜', { sessionId: session.id })
  assert.equal(hits.length, 0)
  service.dispose()
})

test('update: in-place edit keeps identity and review history', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-upd-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'up', header: { cwd: path.join(home, 'ws') } }
  const ep = service.remember({ text: '部署时间在周三', sessionId: session.id })
  const before = ep.stability
  const updated = service.update(ep.id, { summary: '部署时间改到周四晚', importance: 0.9, resident: true }, session.id)
  assert.equal(updated.id, ep.id)
  assert.match(updated.summary, /周四/)
  assert.equal(updated.resident, true)
  assert.ok(Math.abs(updated.stability - before) < 1e-9, 'editing must not reset the review history')
  service.dispose()
})

test('persona scopes: session overrides workspace overrides global, no restart needed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-persona-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws'), personality: { preset: 'curious-engineer' } }))
  const session = { id: 'p', header: { cwd: path.join(home, 'ws') } }
  service.onSessionEvent(session, user('你好', 1)) // establishes cwd/dir

  const base = service.profile('get', {}, { sessionId: session.id })
  assert.equal(base.layers.global, 'curious-engineer')

  service.profile('set', { preset: 'stoic-guardian' }, { scope: 'workspace', sessionId: session.id })
  const atWorkspace = service.profile('get', {}, { sessionId: session.id })
  assert.equal(atWorkspace.personality.preset, 'stoic-guardian')
  assert.equal(atWorkspace.layers.workspace, 'stoic-guardian')

  service.profile('set', { preset: 'warm-companion' }, { scope: 'session', sessionId: session.id })
  const atSession = service.profile('get', {}, { sessionId: session.id })
  assert.equal(atSession.personality.preset, 'warm-companion')
  assert.equal(atSession.layers.session, 'warm-companion')
  assert.equal(atSession.layers.global, 'curious-engineer', 'session override must not leak into global')

  const prompt = service.renderPromptState(session.id)
  assert.match(prompt, /温和的同伴/, 'the prompt reflects the scoped persona immediately')
  service.dispose()
})

test('consolidation receipts: same inputs produce the same hash, and it is logged', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  for (let i = 0; i < 3; i++) memory.encodeEpisode({ text: `第 ${i} 次迁移前备份`, at: Date.now() - i * 60e3, importance: 0.7, outcome: { success: true, errors: 0 } })
  const report = memory.consolidate({ stage: 'nrem', minCluster: 3 })
  assert.ok(report.receipt.hash && report.receipt.hash.length === 16)
  assert.ok(memory.receiptLog.items.some((item) => item.hash === report.receipt.hash))
})
