import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

const makeCtx = () => {
  const captured = { tools: [], sections: [], contexts: [], variables: {}, listeners: {}, disposers: [], service: null }
  const systemPrompt = {
    section: (section) => {
      captured.sections.push(section)
      return () => {}
    },
    context: (context) => {
      captured.contexts.push(context)
      return () => {}
    },
    variable: (variable, provider) => {
      captured.variables[variable] = provider
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register: (definition) => {
        captured.tools.push(definition)
        return () => {}
      },
    },
    systemPrompt,
    get: (service) => (service === 'systemPrompt' ? systemPrompt : undefined),
    effect: (fn, label) => {
      const dispose = fn()
      captured.disposers.push({ label, dispose })
      return dispose
    },
    on: (event, fn) => {
      captured.listeners[event] = fn
      return () => {
        delete captured.listeners[event]
      }
    },
    set: (key, value) => {
      if (key === 'cerebrum') captured.service = value
    },
  }
  return { ctx, captured }
}

const userMessage = (text) => ({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
const assistantMessage = (text) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const toolCall = (id, toolName, args) => ({ type: 'tool/call', data: { callId: id, name: toolName, arguments: args, turn: 1, step: 1 } })
const toolResult = (id, text, isError = false) => ({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', callId: id, isError, content: [{ type: 'text', text }] } } })
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

test('plugin: registers tools, prompt contributions and observes turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-plugin-'))
  const { ctx, captured } = makeCtx()
  apply(ctx, { dataDir: dir, api: { enabled: false }, prompt: { maxChars: 600 }, consolidation: { everyTurns: 100 } })

  assert.equal(name, 'cerebrum')
  assert.deepEqual(inject, ['tools'])
  assert.equal(captured.tools.length, 13)
  const toolNames = captured.tools.map((tool) => tool.name).sort()
  assert.deepEqual(toolNames, [
    'cerebrum_appraise',
    'cerebrum_character',
    'cerebrum_consolidate',
    'cerebrum_forget',
    'cerebrum_intend',
    'cerebrum_judge',
    'cerebrum_pet_asset',
    'cerebrum_pet_visual',
    'cerebrum_profile',
    'cerebrum_recall',
    'cerebrum_remember',
    'cerebrum_state',
    'cerebrum_update',
  ])
  assert.equal(captured.sections.length, 1)
  assert.equal(captured.sections[0].order, 90)
  assert.equal(captured.contexts.length, 1)
  assert.equal(captured.contexts[0].order, 120)
  assert.ok(typeof captured.listeners['session/event'] === 'function')

  const session = { id: 'sess-1' }
  const emit = (event) => captured.listeners['session/event'](session, event)

  emit(userMessage('部署脚本时数据库迁移失败了，请帮我回滚并记录原因'))
  emit(assistantMessage('先回滚迁移，再补一份原因记录。'))
  emit(toolCall('c1', 'pwsh', { command: 'rollback' }))
  emit(toolResult('c1', 'rollback ok', false))
  emit(turnEnd(1))

  const service = captured.service
  assert.ok(service, 'plugin exposes the live service')
  service.flushSession('sess-1')
  const state = service.state()
  assert.equal(state.memory.episodes, 1)
  assert.ok(state.affect.valence > -0.2)
  assert.ok(state.affect.emotion.key.length > 0)

  const recall = captured.tools.find((tool) => tool.name === 'cerebrum_recall')
  return recall.execute({ query: '数据库迁移 回滚' }, { agent: { session } }).then((result) => {
    assert.equal(result.count >= 1, true)
    assert.match(result.text, /回滚/)

    const contextText = captured.contexts[0].text({ agent: { session } })
    assert.match(contextText, /认知状态/)
    assert.match(contextText, /人格/)

    // A malformed event must not throw into the session loop.
    assert.doesNotThrow(() => emit({ type: 'tool/result', data: null }))
    service.dispose()
  })
})

test('plugin: recall tool returns an honest empty answer for a fresh memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-plugin-'))
  const { ctx, captured } = makeCtx()
  apply(ctx, { dataDir: dir, api: { enabled: false }, prompt: { enabled: false } })
  const recall = captured.tools.find((tool) => tool.name === 'cerebrum_recall')
  const result = await recall.execute({ query: '从未发生过的事' }, { agent: { session: { id: 'x' } } })
  assert.equal(result.count, 0)
  assert.match(result.text, /没有检索到/)
  captured.service.dispose()
})

test('plugin: judge and state tools return structured, renderable results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-plugin-'))
  const { ctx, captured } = makeCtx()
  apply(ctx, { dataDir: dir, api: { enabled: false }, prompt: { enabled: false } })
  const judge = captured.tools.find((tool) => tool.name === 'cerebrum_judge')
  const verdict = await judge.execute(
    { question: '是否要在生产环境直接改配置？', options: ['直接改生产配置', '先在预发验证再灰度'], stakes: 'high' },
    { agent: { session: { id: 'x' } } },
  )
  assert.ok(verdict.choice.length > 0)
  assert.ok(typeof verdict.text === 'string' && verdict.text.length > 0)
  assert.ok(['S1', 'S2', 'S1-vetoed'].includes(verdict.system))

  const stateTool = captured.tools.find((tool) => tool.name === 'cerebrum_state')
  const snapshot = await stateTool.execute({}, {})
  assert.ok(snapshot.text.includes('神经调质'))
  assert.ok(snapshot.personality.traits.openness > 0)
  captured.service.dispose()
})
