import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Headless smoke test for the hand-written client bundle: it must call
 * __ModuleLoader__.load, register the dock slot, and render its chip with a
 * stubbed React/fetch — enough to catch syntax and lifecycle mistakes without
 * a browser.
 */
test('client bundle: loads, registers the dock slot and renders the chip', async () => {
  const cleanups = []
  const reactStub = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: (fn) => {
      try {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      } catch {}
    },
    useRef: (value) => ({ current: value }),
    createElement: (tag, props, ...children) => ({ tag, props, children }),
  }
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (config) => { captured = config } } }
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('/dsh-pet-7340/state')) return { pets: {} }
      if (String(url).includes('/render-hints')) return { emotionKey: 'calm', expression: 'neutral', line: '在呢。', intensity: 0.2 }
      return {
        affect: { emotion: { label: '平静', intensity: 0.2 }, valence: 0, arousal: 0.3, dominance: 0 },
        memory: { episodes: 0, concepts: 0 },
        neuromods: { da: 0.5, ser: 0.5, ne: 0.4, ach: 0.4 },
        personality: { label: '好奇的工程师', traits: {} },
        affinity: { level: '初见' },
        workingMemory: [],
      }
    },
  })

  await import('../lib/client.js')
  assert.ok(captured, 'bundle must call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-cerebrum')

  const requireStub = (name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require: ${name}`)
  }
  const mod = captured.factory(requireStub)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])

  const registrations = []
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (def, component) => {
        registrations.push({ def, component })
        return () => {}
      },
    },
  })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].def.id, 'cerebrum')

  const element = registrations[0].component({ sessionId: 's1' })
  assert.equal(element, null, 'the dock slot renders nothing until the pet menu opens the panel')

  for (const cleanup of cleanups) cleanup()
  delete globalThis.window
})
