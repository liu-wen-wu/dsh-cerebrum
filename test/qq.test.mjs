import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { createQqClient, EXTRACT_TEXT, parseRecentContacts } from '../lib/core/qq.js'
import { CerebrumService } from '../lib/service.js'

const startMockOneBot = (state) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {}
      state.calls.push({ action: req.url.slice(1), payload })
      res.setHeader('Content-Type', 'application/json')
      const action = req.url.slice(1)
      if (action === 'send_private_msg') return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }))
      if (action === 'get_recent_contact') {
        return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: state.contacts }))
      }
      if (action === 'get_msg') {
        return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message: state.message } }))
      }
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: null }))
    })
  })
  server.listen(18798, '127.0.0.1', () => resolve(server))
})

test('qq: OneBot client sends the documented shape and parses recent contacts', async () => {
  const state = { calls: [], contacts: [], message: '' }
  const server = await startMockOneBot(state)
  const client = createQqClient({ baseUrl: 'http://127.0.0.1:18798', token: 't0k' })
  await client.sendPrivate(123456, '你好呀')
  const call = state.calls[0]
  assert.equal(call.action, 'send_private_msg')
  assert.deepEqual(call.payload, { user_id: 123456, message: '你好呀' })

  const parsed = parseRecentContacts([
    { peerUin: '123456', lastestMsg: { msgId: 'm42', msgTime: 1000, elements: [{ type: 'text', data: { text: '你好呀' } }] } },
  ])
  assert.deepEqual(parsed, [{ userId: '123456', messageId: 'm42', time: 1000, text: '你好呀' }])
  assert.equal(EXTRACT_TEXT([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: {} }, { type: 'text', data: { text: 'b' } }]), 'ab')
  server.close()
})

test('qq: a new message becomes an episode and triggers a brain reply', async () => {
  const state = {
    calls: [],
    contacts: [{ peerUin: '8888', lastestMsg: { msgId: 'm7', msgTime: Date.now(), elements: [{ type: 'text', data: { text: '大肥鱼在吗' } }] } }],
    message: '',
  }
  const server = await startMockOneBot(state)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-qq-'))
  const service = new CerebrumService(resolveConfig({
    home,
    cwd: path.join(home, 'ws'),
    qq: { enabled: true, baseUrl: 'http://127.0.0.1:18798', friendId: '8888', autoReply: true, replyCooldownMs: 0 },
  }))

  const handled = await service.pollQq()
  assert.equal(handled, 1)
  assert.ok(service.memory.episodes.some((episode) => episode.tags.includes('qq')), 'QQ message stored as an episode')
  const sent = state.calls.filter((call) => call.action === 'send_private_msg')
  assert.equal(sent.length, 1, 'auto-reply sent once')
  assert.equal(sent[0].payload.user_id, 8888)

  const again = await service.pollQq()
  assert.equal(again, 0, 'the same message id is not processed twice')
  service.dispose()
  server.close()
})
