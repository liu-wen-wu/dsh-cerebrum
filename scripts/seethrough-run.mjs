/**
 * Run the See-through decomposition workflow in ComfyUI.
 *
 *   node scripts/seethrough-run.mjs --ref <image.png> [--seed 42] [--steps 30]
 *                                   [--workflow assets/workflows/seethrough-decompose.json]
 *
 * Outputs the layered PSD + layer PNGs into ComfyUI's output directory and
 * prints the paths.
 */

import fs from 'node:fs'
import path from 'node:path'

const ENDPOINT = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '')

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const ref = argOf('--ref')
if (!ref) {
  console.error('usage: node scripts/seethrough-run.mjs --ref <image.png> [--seed 42] [--steps 30]')
  process.exit(1)
}
const workflowPath = path.resolve(argOf('--workflow', 'assets/workflows/seethrough-decompose.json'))
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'))
const steps = Number(argOf('--steps', 30))
const seed = Number(argOf('--seed', 42))
const resolution = Number(argOf('--resolution', 1024))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const uploadImage = async (file) => {
  const form = new FormData()
  form.append('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), path.basename(file))
  form.append('overwrite', 'true')
  const res = await fetch(`${ENDPOINT}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  return (await res.json()).name
}

const main = async () => {
  const refName = await uploadImage(ref)
  const wf = JSON.parse(JSON.stringify(workflow))
  for (const node of Object.values(wf)) {
    if (node.class_type === 'LoadImage') node.inputs.image = refName
    if (node.class_type === 'SeeThrough_GenerateLayers') {
      node.inputs.seed = seed
      node.inputs.num_inference_steps = steps
      node.inputs.resolution = resolution
    }
  }
  const res = await fetch(`${ENDPOINT}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'cerebrum-seethrough' }),
  })
  const json = await res.json()
  if (json.node_errors && Object.keys(json.node_errors).length) throw new Error(JSON.stringify(json.node_errors).slice(0, 800))
  if (!json.prompt_id) throw new Error(JSON.stringify(json).slice(0, 400))
  console.log(`submitted ${json.prompt_id}`)
  const deadline = Date.now() + 30 * 60e3
  while (Date.now() < deadline) {
    const hist = await fetch(`${ENDPOINT}/history/${json.prompt_id}`).then((r) => (r.ok ? r.json() : null))
    const entry = hist?.[json.prompt_id]
    if (entry && entry.status?.status_str === 'error') throw new Error(JSON.stringify(entry.status).slice(0, 600))
    if (entry && entry.outputs && Object.keys(entry.outputs).length > 0) {
      console.log(JSON.stringify(entry.outputs, null, 2))
      return
    }
    await sleep(3000)
  }
  throw new Error('timeout')
}

main().catch((error) => {
  console.error('✗', error.message)
  process.exitCode = 1
})
