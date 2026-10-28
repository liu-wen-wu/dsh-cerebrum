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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-audit5-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('appraise: non-numeric appraisal dimensions never poison affect with NaN', () => {
  const affect = new AffectSystem({ personality: new Personality({ preset: 'curious-engineer' }) })
  affect.appraise({ relevance: 'high', congruence: 'x', novelty: {}, urgency: null, magnitude: 'abc' })
  for (const value of [affect.valence, affect.arousal, affect.dominance, affect.moodValence, affect.emotion.intensity]) {
    assert.ok(Number.isFinite(value), `affect value must stay finite, got ${value}`)
  }
  for (const [key, value] of Object.entries(affect.neuromods)) {
    assert.ok(Number.isFinite(value), `neuromodulator ${key} must stay finite, got ${value}`)
  }
  const snapshot = affect.snapshot()
  assert.ok(Number.isFinite(snapshot.mood.arousal))
})

test('judge: bogus stakes fall back to medium and stay finite', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  memory.encodeEpisode({ text: '上次直接全量上线出了故障', at: Date.now() - 3600e3, importance: 0.6, affect: { v: -0.6, a: 0.6, d: 0.4 }, outcome: { success: false, errors: 1 } })
  const personality = new Personality({ preset: 'curious-engineer' })
  const judge = new Judge({ memory, affect: new AffectSystem({ personality }), personality })
  const result = judge.judge({ question: '这个改动要不要推进', options: ['直接全量上线', '先灰度观察'], stakes: 'whatever' })
  assert.equal(result.stakes, 'medium')
  assert.ok(Number.isFinite(result.confidence))
  for (const option of result.options) {
    assert.ok(Number.isFinite(option.score) && Number.isFinite(option.expectedValue) && Number.isFinite(option.risk))
  }
})

test('recall: absurdly long queries are capped instead of exploding the encoder', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  memory.encodeEpisode({ text: '迁移前备份数据库', at: Date.now(), importance: 0.6, outcome: { success: true, errors: 0 } })
  const hits = memory.recall('迁移 '.repeat(5000), { k: 3 })
  assert.ok(Array.isArray(hits))
  const probe = memory.probe('迁移 '.repeat(5000))
  assert.ok(probe === null || Number.isFinite(probe.similarity))
})
