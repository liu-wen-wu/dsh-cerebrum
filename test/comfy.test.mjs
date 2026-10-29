import assert from 'node:assert/strict'
import test from 'node:test'

import { applyPrompt, downloadOutput, isApiWorkflow, runWorkflow } from '../lib/core/comfy.js'
import { generateImage } from '../lib/core/imagegen.js'

const API_WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 8, model: ['4', 0] } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  9: { class_type: 'SaveVideo', inputs: { images: ['7', 0] } },
}

const stubFetch = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  const text = String(url)
  if (text.endsWith('/prompt')) {
    return { ok: true, json: async () => ({ prompt_id: 'p1' }) }
  }
  if (text.includes('/history/p1')) {
    return { ok: true, json: async () => ({ p1: { status: { completed: true }, outputs: { 9: { videos: [{ filename: 'pet.mp4', subfolder: '', type: 'output' }] } } } }) }
  }
  if (text.includes('/view?')) {
    const bytes = Buffer.from('fake-video')
    return { ok: true, arrayBuffer: async () => bytes }
  }
  return { ok: false, status: 404, text: async () => 'nope' }
}

test('comfyui: UI-format workflows are rejected, API-format accepted', () => {
  assert.equal(isApiWorkflow({ nodes: [], links: [] }), false)
  assert.equal(isApiWorkflow(API_WORKFLOW), true)
  assert.equal(isApiWorkflow(null), false)
})

test('comfyui: prompt substitution targets prompt-like inputs', () => {
  const injected = applyPrompt(API_WORKFLOW, '一只在跳舞的鲸鱼女仆')
  assert.equal(injected[6].inputs.text, '一只在跳舞的鲸鱼女仆')
  assert.equal(API_WORKFLOW[6].inputs.text, 'a cat', 'the template is not mutated')
  const placeholder = applyPrompt({ 1: { class_type: 'X', inputs: { text: '__PROMPT__' } } }, 'hi')
  assert.equal(placeholder[1].inputs.text, 'hi')
  assert.throws(() => applyPrompt({ 1: { class_type: 'X', inputs: { seed: 1 } } }, 'hi'), /no prompt-like input/)
})

test('comfyui: runWorkflow submits, polls history and downloads the output', async () => {
  const calls = []
  const result = await runWorkflow(stubFetch(calls), 'http://127.0.0.1:8188', API_WORKFLOW, { prompt: 'test', pollMs: 10, timeoutMs: 5000 })
  assert.equal(result.mime, 'video/mp4')
  assert.equal(result.bytes.toString(), 'fake-video')
  assert.ok(calls.some((call) => call.url.endsWith('/prompt')))
  assert.ok(calls.some((call) => call.url.includes('/history/p1')))
  assert.ok(calls.some((call) => call.url.includes('/view?')))
})

test('comfyui: generateImage routes to the workflow runner and keeps mime', async () => {
  const calls = []
  const out = await generateImage({
    prompt: 'p',
    provider: 'comfyui',
    endpoint: 'http://127.0.0.1:8188',
    workflow: API_WORKFLOW,
    timeoutMs: 5000,
    pollMs: 10,
    fetchImpl: stubFetch(calls),
  })
  assert.equal(out.mime, 'video/mp4')
  assert.equal(out.meta.provider, 'comfyui')
  assert.equal(out.meta.ext, 'mp4')
})

test('comfyui: missing workflow or endpoint fails with a clear message', async () => {
  await assert.rejects(() => generateImage({ prompt: 'p', provider: 'comfyui', endpoint: 'http://x', fetchImpl: stubFetch([]) }), /workflow/)
  await assert.rejects(() => generateImage({ prompt: 'p', provider: 'comfyui', workflow: API_WORKFLOW, fetchImpl: stubFetch([]) }), /endpoint/)
})

test('comfyui: downloadOutput reports missing outputs', async () => {
  await assert.rejects(() => downloadOutput(stubFetch([]), 'http://x', { outputs: {} }), /no output files/)
})
