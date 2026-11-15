/**
 * Batch-generate sprite frames with ComfyUI (SDXL + IP-Adapter).
 *
 *   node scripts/comfy-gen.mjs --plan plan.json
 *
 * plan.json:
 * {
 *   "workflow": "assets/workflows/sdxl-ipadapter.json",
 *   "ref": "C:/path/to/pet-base-cut.png",
 *   "out": "D:/ComfyUI/output/cerebrum-frames",
 *   "size": [768, 768],
 *   "seed": 1234,
 *   "states": {
 *     "idle": ["prompt 1", "prompt 2"],
 *     "happy": ["prompt 1", ...]
 *   }
 * }
 *
 * Frames are saved as `<state>_<n>.png` so `sprite-pack.mjs` can consume them.
 */

import fs from 'node:fs'
import path from 'node:path'

const ENDPOINT = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '')

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const planPath = argOf('--plan')
if (!planPath) {
  console.error('usage: node scripts/comfy-gen.mjs --plan plan.json')
  process.exit(1)
}
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
const workflowPath = path.resolve(plan.workflow ?? 'assets/workflows/sdxl-ipadapter.json')
const workflowTemplate = JSON.parse(fs.readFileSync(workflowPath, 'utf8'))
const outDir = plan.out
fs.mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const uploadImage = async (file) => {
  const bytes = fs.readFileSync(file)
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: 'image/png' }), path.basename(file))
  form.append('overwrite', 'true')
  const res = await fetch(`${ENDPOINT}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  const json = await res.json()
  return json.name
}

const submit = async (workflow) => {
  const res = await fetch(`${ENDPOINT}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'cerebrum-sprite' }),
  })
  const json = await res.json()
  if (json.node_errors && Object.keys(json.node_errors).length > 0) {
    throw new Error(`workflow error: ${JSON.stringify(json.node_errors).slice(0, 600)}`)
  }
  if (!json.prompt_id) throw new Error(`no prompt_id: ${JSON.stringify(json).slice(0, 400)}`)
  return json.prompt_id
}

const waitFor = async (promptId, timeoutMs = 300000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${ENDPOINT}/history/${promptId}`)
    if (res.ok) {
      const json = await res.json()
      const entry = json[promptId]
      if (entry && entry.outputs && Object.keys(entry.outputs).length > 0) return entry
      if (entry && entry.status && entry.status.status_str === 'error') {
        throw new Error(`prompt failed: ${JSON.stringify(entry.status).slice(0, 400)}`)
      }
    }
    await sleep(1500)
  }
  throw new Error(`timeout waiting for ${promptId}`)
}

const downloadImage = async (entry, target) => {
  for (const node of Object.values(entry.outputs || {})) {
    const file = (node.images || [])[0]
    if (!file) continue
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const res = await fetch(`${ENDPOINT}/view?${query}`)
    if (!res.ok) throw new Error(`view failed: ${res.status}`)
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()))
    return true
  }
  return false
}

const byClass = (workflow, className) => Object.entries(workflow).find(([, node]) => node.class_type === className)

const main = async () => {
  const refName = await uploadImage(plan.ref)
  const [width, height] = plan.size ?? [768, 768]
  let seed = Number(plan.seed ?? 1)
  let count = 0
  for (const [state, prompts] of Object.entries(plan.states ?? {})) {
    for (let i = 0; i < prompts.length; i++) {
      const workflow = JSON.parse(JSON.stringify(workflowTemplate))
      const loadImage = byClass(workflow, 'LoadImage')
      if (loadImage) loadImage[1].inputs.image = refName
      const sampler = byClass(workflow, 'KSampler')
      const positiveId = sampler?.[1]?.inputs?.positive?.[0]
      if (positiveId && workflow[positiveId]) workflow[positiveId].inputs.text = prompts[i]
      const latent = byClass(workflow, 'EmptyLatentImage')
      if (latent) {
        latent[1].inputs.width = width
        latent[1].inputs.height = height
      }
      if (sampler) sampler[1].inputs.seed = seed++
      const started = Date.now()
      const promptId = await submit(workflow)
      const entry = await waitFor(promptId)
      const target = path.join(outDir, `${state}_${i}.png`)
      if (!(await downloadImage(entry, target))) throw new Error(`no images for ${state}_${i}`)
      count++
      console.log(`✓ ${state}_${i} (${Math.round((Date.now() - started) / 1000)}s) → ${target}`)
    }
  }
  console.log(`done: ${count} frames → ${outDir}`)
}

main().catch((error) => {
  console.error('✗', error.message)
  process.exitCode = 1
})
