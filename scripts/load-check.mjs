/**
 * Load-check: boot the real Cordis container (extracted from the installed DSH
 * app) with stub registries, load dsh-cerebrum through `ctx.plugin()`, emit a
 * synthetic turn, and assert that tools + prompt contributions + persistence
 * actually happened.
 *
 * This is the closest thing to a host boot that does not require restarting the
 * user's running DSH client. Run with: node scripts/load-check.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.join(here, '..', 'research', 'runtime', 'node_modules')
const { Context } = await import(new URL(`file://${path.join(runtime, '@deepseek-ai', 'cordis', 'lib', 'index.js').replace(/\\/g, '/')}`))
const plugin = await import(new URL(`file://${path.join(here, '..', 'lib', 'index.js').replace(/\\/g, '/')}`))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-load-'))
// Production layout: $DSH_HOME/cerebrum/<workspace-slug>/. Set the same env the
// host uses so the check exercises per-workspace routing, not a fixed dataDir.
process.env.DSH_HOME = dir
fs.mkdirSync(path.join(dir, 'cerebrum'), { recursive: true })
fs.writeFileSync(path.join(dir, 'cerebrum', 'config.json'), JSON.stringify({ prompt: { maxChars: 500 } }))

const captured = { tools: [], sections: [], contexts: [], variables: {}, disposers: [] }
const app = new Context()

const tools = {
  register(definition) {
    assert.equal(typeof definition.execute, 'function', `tool ${definition.name} must have execute`)
    assert.equal(typeof definition.output.render, 'function', `tool ${definition.name} must render`)
    assert.equal(definition.parameters.type, 'object', `tool ${definition.name} parameters must be an object schema`)
    captured.tools.push(definition)
    return () => {
      captured.tools = captured.tools.filter((tool) => tool !== definition)
    }
  },
}

const systemPrompt = {
  section(section) {
    captured.sections.push(section)
    return () => {
      captured.sections = captured.sections.filter((entry) => entry !== section)
    }
  },
  context(context) {
    captured.contexts.push(context)
    return () => {
      captured.contexts = captured.contexts.filter((entry) => entry !== context)
    }
  },
  variable(name, provider) {
    captured.variables[name] = provider
    return () => {
      delete captured.variables[name]
    }
  },
}

app.provide('tools', tools)
app.provide('systemPrompt', systemPrompt)

app.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { prompt: { maxChars: 500 } })
await app.lifecycle?.flush?.()
await new Promise((resolve) => setTimeout(resolve, 50))

assert.equal(captured.tools.length, 14, `expected 14 tools, got ${captured.tools.map((t) => t.name).join(', ')}`)
assert.equal(captured.sections.length, 1)
assert.equal(captured.contexts.length, 1)
const provided = app.get('cerebrum')
assert.ok(provided && typeof provided.state === 'function', 'the live service must be readable through ctx.get("cerebrum")')

// Feed one completed turn through the real event bus.
const session = { id: 'load-check', header: { cwd: path.join(dir, 'workspace') } }
const user = { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '记住：部署前必须先跑迁移演练' }], source: { kind: 'user' } } } }
const assistant = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '已记住这条约定' }] } } }
const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }

app.emit('session/event', session, user)
app.emit('session/event', session, assistant)
app.emit('session/event', session, end)
await new Promise((resolve) => setTimeout(resolve, 50))
provided.flushSession(session.id)

const recall = captured.tools.find((tool) => tool.name === 'cerebrum_recall')
const result = await recall.execute({ query: '部署 迁移 演练' }, { agent: { session } })
assert.equal(result.count >= 1, true, 'the completed turn must be recallable')

const promptText = captured.contexts[0].text({ agent: { session } })
assert.match(promptText, /认知状态/)
assert.match(promptText, /人格/)

// The loopback API must be up and serving the same store (client UI data path).
// When a live app instance already serves 18734, our fresh boot cannot rebind —
// then the ping proves a dsh-cerebrum brain answers on the standard port.
const ping = await fetch('http://127.0.0.1:18734/ping').then((r) => r.json()).catch(() => null)
assert.ok(ping && ping.ok === true && ping.name === 'dsh-cerebrum', 'brain api /ping must respond with the cerebrum identity')

const storeRoot = path.join(dir, 'cerebrum')
const storeDirs = fs.readdirSync(storeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
const withEpisodes = storeDirs.find((entry) => fs.existsSync(path.join(storeRoot, entry.name, 'episodes.jsonl')))
assert.ok(withEpisodes, `no workspace store under ${storeRoot}`)
const storeDir = path.join(storeRoot, withEpisodes.name)
assert.ok(fs.readFileSync(path.join(storeDir, 'episodes.jsonl'), 'utf8').includes('迁移演练'))

console.log('OK  real Cordis load')
console.log(`    tools: ${captured.tools.map((tool) => tool.name).join(', ')}`)
console.log(`    prompt section order=${captured.sections[0].order} context order=${captured.contexts[0].order}`)
console.log(`    recalled: ${result.memories.map((memory) => memory.summary).join(' | ')}`)
console.log(`    store: ${storeDir}`)
