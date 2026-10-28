/**
 * Pet hook: the polling loop a real pet shell would run against the brain.
 *
 * Every second it fetches /render-hints and prints the vocabulary a pet
 * renderer consumes (expression/animation/line/pitch), demonstrating the exact
 * data shape the bridge forwards. Works standalone against a temporary brain.
 *
 * Run: node examples/pet-hook.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startBrainApi } from '../lib/api.js'
import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-hook-'))
const service = new CerebrumService(resolveConfig({ home, cwd: path.join(here, '..') }))
const session = { id: 'hook', header: { cwd: path.join(here, '..') } }

service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '把这次发版做完' }], source: { kind: 'user' } } } })
service.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '发版完成' }] } } })
service.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
service.flushSession('hook')

const api = startBrainApi(service, { port: 18734, logger: { log() {}, warn() {}, error() {} } })
const base = 'http://127.0.0.1:18734'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('=== pet-hook：宠物外壳轮询示例（每秒 /render-hints） ===\n')
for (let tick = 0; tick < 6; tick++) {
  const hints = await fetch(`${base}/render-hints?session=hook`).then((r) => r.json())
  console.log(`t=${tick}s  表情=${hints.expression.padEnd(8)} 动作=${hints.animation.padEnd(6)} 台词="${hints.line}" 音高=${hints.voicePitch}`)
  if (tick === 1) {
    console.log('           （宿主收到"主人摸了摸头" → GET /interact?kind=pet）')
    await fetch(`${base}/interact?kind=pet&session=hook`)
  }
  if (tick === 3) {
    console.log('           （宿主收到"干得漂亮！" → GET /interact?kind=praise）')
    await fetch(`${base}/interact?kind=praise&session=hook`)
  }
  await sleep(1000)
}

console.log('\n真实接入：把这里的 fetch 换成宠物插件的状态机，两个端点不变。')
api.close()
service.dispose()
