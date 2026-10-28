import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { MemoryStore } from '../lib/core/memory.js'
import { SdrEncoder } from '../lib/core/sdr.js'
import { CerebrumService } from '../lib/service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-audit2-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('remember: force writes a separate trace instead of merging near-duplicates', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-force-'))
  const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws') }))
  const session = { id: 'f', header: { cwd: path.join(home, 'ws') } }
  const text = '部署前要先跑迁移演练'
  const first = service.remember({ text, sessionId: session.id })
  const merged = service.remember({ text, sessionId: session.id })
  assert.equal(merged.id, first.id, 'a near-duplicate merges by default')
  const forced = service.remember({ text, sessionId: session.id, force: true })
  assert.notEqual(forced.id, first.id, 'force bypasses the merge')
  assert.equal(service._storeForSession('f').episodes.length, 2)
  service.dispose()
})

test('consolidation: schema flags survive a restart (episode log rewrite)', () => {
  const dir = tmp()
  const memory = new MemoryStore({ dir, encoder })
  for (let i = 0; i < 3; i++) {
    memory.encodeEpisode({ text: `第 ${i} 次迁移前备份`, at: Date.now() - i * 60e3, importance: 0.7, outcome: { success: true, errors: 0 } })
  }
  memory.consolidate({ stage: 'nrem', minCluster: 3 })
  const before = memory.episodes.filter((ep) => ep.schema)
  assert.ok(before.length > 0, 'a schema must have formed')

  const reloaded = new MemoryStore({ dir, encoder }).load()
  assert.equal(reloaded.episodes.filter((ep) => ep.schema).length, before.length, 'schema flags are persisted')

  // Stability still round-trips through the review log alone (no rewrite needed).
  const id = reloaded.episodes[0].id
  const stability = reloaded.byId.get(id).stability
  reloaded.lapse(id)
  const after = new MemoryStore({ dir, encoder }).load()
  assert.ok(Math.abs(after.byId.get(id).stability - stability) > 0, 'lapse review replays on load')
})
