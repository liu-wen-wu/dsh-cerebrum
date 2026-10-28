import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startBrainApi } from '../lib/api.js'
import { resolveConfig } from '../lib/config.js'
import { addAsset, learnAssetOutcome, pickAsset, sanitizeAssetName } from '../lib/core/petassets.js'
import { CerebrumService } from '../lib/service.js'

test('pet assets: registry add/pick/learn stay bounded and emotion-aware', () => {
  const registry = {}
  const a = addAsset(registry, { file: '开心转圈.webm', emotion: 'joy' }, 1000)
  const b = addAsset(registry, { file: '难过趴下.gif', emotion: 'sadness' }, 2000)
  assert.equal(a.kind, 'anim')
  assert.equal(b.kind, 'anim') // gif counts as an animation (checked before image)
  assert.equal(pickAsset(registry, { emotion: 'joy', rng: () => 0 }).id, a.id)
  assert.equal(pickAsset(registry, { emotion: 'fear', rng: () => 0 })?.id, undefined) // no calm fallback exists
  const before = registry[a.id].weight
  learnAssetOutcome(registry, a.id, true)
  assert.ok(registry[a.id].weight > before)
  for (let i = 0; i < 30; i++) learnAssetOutcome(registry, a.id, false)
  assert.ok(registry[a.id].weight >= 0.05, 'weight never collapses to zero')
  assert.equal(sanitizeAssetName('../../etc/passwd'), 'passwd')
})

test('pet assets: files must exist before registration, and are served read-only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-assets-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  assert.throws(() => service.addPetAsset({ file: '不存在.webm', emotion: 'joy' }), /不存在/)

  fs.mkdirSync(service.assetDir, { recursive: true })
  const bytes = Buffer.from('fake-webm-bytes')
  fs.writeFileSync(path.join(service.assetDir, '开心转圈.webm'), bytes)
  const record = service.addPetAsset({ file: '开心转圈.webm', emotion: 'joy', tags: ['庆祝'] })
  assert.equal(record.emotion, 'joy')
  assert.match(record.publicUrl, /\/asset\//)

  const api = startBrainApi(service, { port: 18796, logger: { log() {}, warn() {}, error() {} } })
  await new Promise((resolve) => setTimeout(resolve, 40))

  const list = await fetch('http://127.0.0.1:18796/pet-assets?emotion=joy').then((r) => r.json())
  assert.equal(list.assets.length, 1)
  assert.equal(list.assets[0].id, record.id)

  const served = await fetch('http://127.0.0.1:18796/asset/' + encodeURIComponent('开心转圈.webm'))
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'video/webm')
  assert.equal((await served.text()).length, bytes.length)

  const traversal = await fetch('http://127.0.0.1:18796/asset/' + encodeURIComponent('../episodes.jsonl'))
  assert.equal(traversal.status, 404, 'path traversal is neutralised by sanitisation')

  const missing = await fetch('http://127.0.0.1:18796/asset/nope.webm')
  assert.equal(missing.status, 404)

  api.close()
  service.dispose()
})
