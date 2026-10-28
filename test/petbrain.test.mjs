import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startBrainApi } from '../lib/api.js'
import { resolveConfig } from '../lib/config.js'
import { EMOTION_EXPRESSIONS, INTERACTION_KINDS, renderHints } from '../lib/core/petbrain.js'
import { CerebrumService } from '../lib/service.js'

test('petbrain: every emotion prototype maps to a shell expression', () => {
  const keys = ['joy', 'contentment', 'curiosity', 'hope', 'pride', 'gratitude', 'relief', 'fear', 'anxiety', 'anger', 'guilt', 'shame', 'sadness', 'frustration', 'calm']
  for (const key of keys) {
    assert.ok(EMOTION_EXPRESSIONS[key], `missing mapping for ${key}`)
    assert.ok(EMOTION_EXPRESSIONS[key].lines.length >= 2)
  }
})

test('petbrain: hints are deterministic and persona-tuned', () => {
  const a = renderHints({ emotionKey: 'joy', intensity: 0.5, valence: 0.6, arousal: 0.5, personalityPreset: 'warm-companion' })
  const b = renderHints({ emotionKey: 'joy', intensity: 0.5, valence: 0.6, arousal: 0.5, personalityPreset: 'warm-companion' })
  assert.deepEqual(a, b)
  assert.equal(a.expression, 'smile')
  assert.match(a.line, /软软地/)
  assert.ok(a.voicePitch >= 0.8 && a.voicePitch <= 1.25)

  const stoic = renderHints({ emotionKey: 'joy', personalityPreset: 'stoic-guardian' })
  assert.match(stoic.line, /沉稳/)
})

test('petbrain: interactions drive the affect through appraisal, over the API too', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-pet-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws'), personality: { preset: 'warm-companion' } }))
  const session = { id: 'pet', header: { cwd: path.join(home, 'ws') } }
  service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } } })

  const before = service.state('pet').affect.valence
  const praised = service.interact('praise', 'pet')
  assert.ok(service.state('pet').affect.valence > before, 'praise should lift valence')
  assert.match(praised.line, /软软地/)

  const hurt = service.interact('scold', 'pet')
  assert.ok(service.state('pet').affect.valence < praised.face.valence, 'scolding should hurt')
  assert.ok(['downcast', 'worried', 'sad', 'annoyed'].includes(hurt.expression))

  // The API path mirrors the in-process path.
  const api = startBrainApi(service, { port: 18792, logger: { log() {}, warn() {}, error() {} } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const hints = await fetch('http://127.0.0.1:18792/render-hints?session=pet').then((r) => r.json())
  assert.ok(hints.expression.length > 0)
  const fed = await fetch('http://127.0.0.1:18792/interact?kind=feed&session=pet').then((r) => r.json())
  assert.ok(fed.expression.length > 0)
  const bad = await fetch('http://127.0.0.1:18792/interact?kind=explode').then((r) => r.json())
  assert.equal(typeof bad.error, 'string')
  assert.ok(INTERACTION_KINDS.includes('pet') && INTERACTION_KINDS.includes('feed'))

  api.close()
  service.dispose()
})
