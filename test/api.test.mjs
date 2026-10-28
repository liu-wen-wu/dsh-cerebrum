import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startBrainApi } from '../lib/api.js'
import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-api-'))

test('brain api: read-only loopback endpoints serve the live state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-api-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'api', header: { cwd: path.join(home, 'ws') } }
  service.onSessionEvent(session, { seq: 7, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '迁移演练要备份' }], source: { kind: 'user' } } } })
  service.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } })
  service.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  service.flushSession('api')

  const api = startBrainApi(service, { port: 18791, logger: { log() {}, warn() {}, error() {} } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const ping = await fetch('http://127.0.0.1:18791/ping').then((r) => r.json())
  assert.equal(ping.ok, true)
  assert.ok(ping.uptimeMs >= 0)

  const state = await fetch('http://127.0.0.1:18791/state?session=api').then((r) => r.json())
  assert.equal(state.memory.episodes, 1)
  assert.equal(state.memory.forgotten, 0)

  const recall = await fetch('http://127.0.0.1:18791/recall?q=%E8%BF%81%E7%A7%BB%E6%BC%94%E7%BB%83&session=api').then((r) => r.json())
  assert.ok(recall.memories.length >= 1)
  assert.match(recall.memories[0].summary, /迁移/)

  const bad = await fetch('http://127.0.0.1:18791/nope')
  assert.equal(bad.status, 404)

  const post = await fetch('http://127.0.0.1:18791/state', { method: 'POST' })
  assert.equal(post.status, 405, 'the api must stay read-only')

  api.close()
  service.dispose()
})
