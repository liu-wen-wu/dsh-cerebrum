import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const user = (text) => ({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
const assistant = (text) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const end = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

const turn = (service, session, userText, assistantText) => {
  service.onSessionEvent(session, user(userText))
  service.onSessionEvent(session, assistant(assistantText))
  service.onSessionEvent(session, end(1))
  service.flushSession(session.id)
}

test('workspaces: one self, separate project memories', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-home-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'default') }))

  const alpha = { id: 's-alpha', header: { cwd: path.join(home, 'projects', 'alpha') } }
  const beta = { id: 's-beta', header: { cwd: path.join(home, 'projects', 'beta') } }

  turn(service, alpha, '修复 alpha 项目的支付回调超时，回滚了队列配置', '已修复回调超时并回滚队列配置')
  turn(service, beta, '给 beta 项目画一张首页插画，风格要温暖', '已生成温暖风格的首页插画')

  assert.equal(service.stores.size, 3, 'default store plus one per session cwd')
  assert.notEqual(service._storeForSession('s-alpha').dir, service._storeForSession('s-beta').dir)

  const alphaHits = service.recall('支付回调 超时', { k: 5, sessionId: 's-alpha' })
  const betaHits = service.recall('支付回调 超时', { k: 5, sessionId: 's-beta' })
  assert.equal(alphaHits.length, 1)
  assert.match(alphaHits[0].episode.text, /支付回调/)
  assert.equal(betaHits.length, 0, 'beta must not recall alpha work')

  // Affect and personality stay global: there is one self across projects.
  assert.ok(service.state('s-alpha').affect.emotion.key.length > 0)
  assert.deepEqual(service.state('s-alpha').personality.traits, service.state('s-beta').personality.traits)

  const totals = service.state('s-alpha').memory.total
  assert.equal(totals.episodes, 2, 'aggregate counts span stores')
  service.dispose()
})
