import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { MemoryStore } from '../lib/core/memory.js'
import { SdrEncoder } from '../lib/core/sdr.js'
import { CerebrumService } from '../lib/service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-p1-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('procedural memory: schema chunking produces when→do rules (SOAR)', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  for (let i = 0; i < 4; i++) {
    memory.encodeEpisode({ text: `第 ${i} 次迁移前备份，演练通过后才执行`, at: Date.now() - i * 60e3, importance: 0.7, outcome: { success: true, errors: 0 } })
  }
  memory.consolidate({ stage: 'nrem', minCluster: 3 })
  assert.ok(memory.skills.length >= 1, 'a consistent schema must be chunked into a skill')
  const hits = memory.skillsOf('迁移 备份 迁移前', { threshold: 0.2 })
  assert.ok(hits.length >= 1)
  assert.match(hits[0].skill.do, /迁移/)
})

test('procedural memory: model-authored rules upsert instead of duplicating', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  const first = memory.upsertSkill({ when: ['部署'], do: '先备份再迁移', source: 'model', strength: 0.7 })
  const before = first.strength
  const again = memory.upsertSkill({ when: ['部署', '发版'], do: '先备份再迁移', source: 'model', strength: 0.7 })
  assert.equal(first.id, again.id)
  assert.ok(first.strength > before)
  assert.ok(first.when.includes('发版'))
  assert.equal(memory.skills.length, 1)
})

test('as-of: a concept keeps the history of its conclusions (bi-temporal)', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder })
  const t0 = Date.now() - 86400e3
  memory.concepts.set('部署', {
    strength: 0.5, count: 2, lastAt: t0, gist: '新结论：改为周四发版',
    lessons: [], theta: 0.25, hot: 0, history: [{ at: t0, gist: '旧结论：周三发版' }], schema: false,
  })
  const then = memory.asOf('部署', t0)
  assert.equal(then.gist, '旧结论：周三发版', 'as-of must return the conclusion current at that time')
  assert.equal(then.current, '新结论：改为周四发版')
})

test('goal utility: goal progress moves valence in the right direction (GAMYGDALA)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-goal-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'g', header: { cwd: path.join(home, 'ws') } }
  service.profile('set', { goals: ['完成数据库迁移'] }, { sessionId: session.id })

  const appraise1 = service._goalDesirability('数据库迁移失败了', { errors: 2 })
  const appraise2 = service._goalDesirability('数据库迁移成功完成', { successes: 1 })
  assert.ok(appraise1 < 0, 'failure on a goal must be aversive')
  assert.ok(appraise2 > 0, 'progress on a goal must be appetitive')
  service.dispose()
})

test('prospective memory: trigger fires a reminder, completion retires it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-int-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'i', header: { cwd: path.join(home, 'ws') } }
  const item = service.intend({ trigger: '发版', action: '先跑迁移演练' })
  assert.equal(service._matchIntentions('今天要发版了').length, 1)
  assert.equal(service._matchIntentions('写个文档').length, 0)

  service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '今天要发版了' }], source: { kind: 'user' } } } })
  const prompt = service.renderPromptState(session.id)
  assert.match(prompt, /前瞻提醒/)
  assert.match(prompt, /迁移演练/)

  assert.equal(service.completeIntentions([item.id]), 1)
  assert.equal(service._matchIntentions('今天要发版了').length, 0)
  service.dispose()
})

test('affinity: it is the integral of shared emotion, with named levels', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-aff-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const affinity = service._affinity()
  assert.equal(affinity.level, '初见')
  assert.ok(Number.isFinite(affinity.positiveShare))
  const state = service.state()
  assert.ok(state.affinity.level.length > 0)
  service.dispose()
})
