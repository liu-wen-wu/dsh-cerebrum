import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
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

  const ui = await fetch('http://127.0.0.1:18791/ui').then((r) => r.json())
  assert.equal(ui.enabled, true, 'the ui endpoint exposes the opt-out switch')

  const state = await fetch('http://127.0.0.1:18791/state?session=api').then((r) => r.json())
  assert.equal(state.memory.episodes, 1)
  assert.equal(state.memory.forgotten, 0)

  const recall = await fetch('http://127.0.0.1:18791/recall?q=%E8%BF%81%E7%A7%BB%E6%BC%94%E7%BB%83&session=api').then((r) => r.json())
  assert.ok(recall.memories.length >= 1)
  assert.match(recall.memories[0].summary, /迁移/)

  // Reading over HTTP must not rehearse memory (no stability side effects).
  const ep = service._storeForSession('api').episodes[0]
  const stabilityBefore = ep.stability
  await fetch('http://127.0.0.1:18791/recall?q=%E8%BF%81%E7%A7%BB%E6%BC%94%E7%BB%83&session=api')
  await fetch('http://127.0.0.1:18791/recall?q=%E8%BF%81%E7%A7%BB%E6%BC%94%E7%BB%83&session=api')
  assert.equal(service._storeForSession('api').episodes[0].stability, stabilityBefore, 'GET /recall is read-only')

  const bad = await fetch('http://127.0.0.1:18791/nope')
  assert.equal(bad.status, 404)

  // Parts puppet v1: the self-rendered character page is served read-only.
  const puppet = await fetch('http://127.0.0.1:18791/puppet')
  assert.equal(puppet.status, 200)
  assert.match(await puppet.text(), /大肥鱼/)
  const puppetIndex = await fetch('http://127.0.0.1:18791/puppet/index.html')
  assert.equal(puppetIndex.status, 200)
  const puppetTraversal = await fetch('http://127.0.0.1:18791/puppet/../package.json')
  assert.equal(puppetTraversal.status, 404, 'puppet static serving cannot escape its directory')

  const post = await fetch('http://127.0.0.1:18791/state', { method: 'POST' })
  assert.equal(post.status, 405, 'the api must stay read-only')

  // Access control (review feedback on dshplugin-index#121):
  // a random website must not be able to read the brain.
  const evil = await fetch('http://127.0.0.1:18791/state', { headers: { Origin: 'https://evil.example' } })
  assert.equal(evil.status, 403, 'cross-site origins are rejected')

  const localOrigin = await fetch('http://127.0.0.1:18791/state', { headers: { Origin: 'http://127.0.0.1:51940' } })
  assert.equal(localOrigin.status, 200, 'the loopback web UI is allowed')
  assert.equal(localOrigin.headers.get('access-control-allow-origin'), 'http://127.0.0.1:51940')
  assert.equal(localOrigin.headers.get('access-control-allow-origin') === '*', false, 'never wildcard CORS')

  // DNS-rebinding style request: a non-loopback Host header is rejected.
  const rebinding = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 18791, path: '/state', headers: { Host: 'attacker.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rebinding, 403, 'non-loopback Host is rejected')

  api.close()
  service.dispose()
})

test('brain api: optional shared token gates every request', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-api-token-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const api = startBrainApi(service, { port: 18793, token: 's3cret', logger: { log() {}, warn() {}, error() {} } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const denied = await fetch('http://127.0.0.1:18793/ping')
  assert.equal(denied.status, 401)

  const allowed = await fetch('http://127.0.0.1:18793/ping', { headers: { 'x-cerebrum-token': 's3cret' } })
  assert.equal(allowed.status, 200)

  api.close()
  service.dispose()
})
