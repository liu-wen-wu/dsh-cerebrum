import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const user = (text, seq) => ({ seq, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
const assistant = (text) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const end = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

test('crash recovery: the open event survives a process restart (pending segment)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-crash-'))
  const ws = path.join(home, 'ws')
  const config = resolveConfig({ home, cwd: ws })
  const session = { id: 'crash', header: { cwd: ws } }

  // Process 1: one completed turn, then "crash" (no dispose, no flush).
  const first = new CerebrumService(config)
  first.onSessionEvent(session, user('迁移演练必须先备份', 1))
  first.onSessionEvent(session, assistant('好的，先备份'))
  first.onSessionEvent(session, end(1))
  assert.ok(fs.existsSync(path.join(home, 'cerebrum')), 'store dir created')

  // Process 2: same workspace, the pending event must be restored and merged.
  const second = new CerebrumService(config)
  second.onSessionEvent(session, user('还有一点：备份要验证可恢复', 2))
  second.onSessionEvent(session, assistant('明白'))
  second.onSessionEvent(session, end(2))
  second.flushSession('crash')

  const store = second._storeForSession('crash')
  assert.ok(store.episodes.length >= 1, 'the restored event must become an episode')
  const text = store.episodes.map((episode) => episode.text).join('\n')
  assert.match(text, /迁移演练必须先备份/, 'content from before the crash is preserved')
  assert.match(text, /备份要验证可恢复/, 'content after the restart is appended')

  // The pending file is gone once the event is flushed.
  const pendingDir = path.join(store.dir, 'pending')
  const leftovers = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []
  assert.deepEqual(leftovers, [], 'no stale pending segment after a clean flush')

  second.dispose()
})
