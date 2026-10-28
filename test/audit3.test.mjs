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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-audit3-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('judge: Chinese options are grounded in Chinese memory (CJK-aware similarity)', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  memory.encodeEpisode({
    text: '昨天回滚并观察了十分钟，灰度稳定下来，没有继续故障',
    at: Date.now() - 3600e3,
    importance: 0.7,
    affect: { v: 0.6, a: 0.5, d: 0.5 },
    outcome: { success: true, errors: 0 },
  })
  const personality = new Personality({ preset: 'curious-engineer' })
  const affect = new AffectSystem({ personality })
  const judge = new Judge({ memory, affect, personality })

  const result = judge.judge({ question: '发版出问题，要不要回滚', options: ['回滚并观察', '直接全量上线'], stakes: 'high' })
  assert.ok(result.evidence.length >= 1, 'Chinese memory must be retrieved as evidence')
  const rollback = result.options.find((option) => option.option.includes('回滚'))
  assert.ok(rollback.probability > 0.5, `positive rollback evidence should raise its probability, got ${rollback.probability}`)
  assert.ok(result.reasons.some((reason) => /记忆/.test(reason)), 'the rationale should cite the memory evidence')
})

test('judge: English evidence still works after the tokenizer change', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  memory.encodeEpisode({
    text: 'we rolled back and observed the rollout for ten minutes',
    at: Date.now() - 3600e3,
    importance: 0.6,
    affect: { v: 0.5, a: 0.5, d: 0.5 },
    outcome: { success: true, errors: 0 },
  })
  const personality = new Personality({ preset: 'curious-engineer' })
  const judge = new Judge({ memory, affect: new AffectSystem({ personality }), personality })
  const result = judge.judge({ question: 'the deploy failed, should we roll back?', options: ['roll back and observe', 'force a full release'], stakes: 'high' })
  assert.ok(result.evidence.length >= 1)
  const rollback = result.options.find((option) => option.option.includes('roll back'))
  assert.ok(rollback.probability > 0.5)
})
