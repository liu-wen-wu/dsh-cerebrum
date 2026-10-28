import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MemoryStore } from '../lib/core/memory.js'
import { SdrEncoder } from '../lib/core/sdr.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-audit6-'))
const encoder = new SdrEncoder({ dim: 1024, k: 24 })

test('edge pruning: noise edges dropped, strong/persistent edges kept', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  memory._strengthenEdge('迁移', '备份', 0.6, Date.now(), 0.9)
  memory._strengthenEdge('迁移', '回滚', 0.6, Date.now(), 0.9)
  const weakKey = '迁移\u0001日志'
  memory.edges.set(weakKey, { w: 0.02, count: 1, at: Date.now() })
  const strongKey = '迁移\u0001演练'
  memory.edges.set(strongKey, { w: 0.5, count: 4, at: Date.now() })

  const removed = memory._pruneEdges(Date.now())
  assert.ok(removed >= 1)
  assert.equal(memory.edges.has(weakKey), false, 'weak one-off edge is dropped')
  assert.equal(memory.edges.has(strongKey), true, 'strong repeated edge is kept')
  const strongPair = memory.edges.get('迁移\u0001' + '备份')
  assert.ok(strongPair && strongPair.w > 0.3, 'edges built by co-activation survive')
})

test('edge fan-out: a node keeps at most `fanout` strongest outgoing links', () => {
  const memory = new MemoryStore({ dir: tmp(), encoder }).load()
  for (let i = 0; i < 60; i++) {
    const key = `hub\u0001leaf${i}`
    memory.edges.set(key, { w: 0.05 + i * 0.001, count: 2, at: Date.now() })
  }
  memory._pruneEdges(Date.now(), { fanout: 40 })
  const outgoing = [...memory.edges.keys()].filter((key) => key.startsWith('hub\u0001')).length
  assert.equal(outgoing, 40, 'fan-out is capped at 40 strongest')
})
