/**
 * ComfyUI provider primitives.
 *
 * ComfyUI's HTTP API only accepts the **API-format** workflow (a map of
 * `nodeId -> {class_type, inputs}`), not the UI-format file with `nodes/links`.
 * Export it once from the ComfyUI menu (Workflow → Export (API)) and point
 * `imagegen.comfyWorkflow` at that file.
 *
 * Flow: POST /prompt → poll GET /history/<id> → GET /view?filename=...
 */

export const isApiWorkflow = (workflow) => {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false
  if (Array.isArray(workflow.nodes)) return false
  const entries = Object.values(workflow)
  if (entries.length === 0) return false
  return entries.every((node) => node && typeof node === 'object' && typeof node.class_type === 'string' && node.inputs && typeof node.inputs === 'object')
}

const looksLikePromptInput = (key, value) => {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  return /^(text|prompt|positive|positive_prompt|description)$/i.test(key)
}

/** Return a copy of the workflow with the prompt substituted. */
export const applyPrompt = (workflow, prompt, { nodeId = null } = {}) => {
  const copy = JSON.parse(JSON.stringify(workflow))
  const text = String(prompt ?? '')
  if (nodeId && copy[nodeId]?.inputs) {
    const target = copy[nodeId].inputs
    const key = Object.keys(target).find((name) => looksLikePromptInput(name, target[name])) ?? Object.keys(target)[0]
    target[key] = text
    return copy
  }
  const placeholders = []
  for (const [id, node] of Object.entries(copy)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (value === '__PROMPT__') {
        node.inputs[key] = text
        placeholders.push(`${id}.${key}`)
      } else if (looksLikePromptInput(key, value)) {
        node.inputs[key] = text
        placeholders.push(`${id}.${key}`)
      }
    }
  }
  if (placeholders.length === 0) throw new Error('workflow has no prompt-like input; set imagegen.comfyPromptNode to the node id')
  return copy
}

/** Submit a workflow; returns the prompt id.
 *  `queueAfter` runs before submit (used to abort other prompts when desired). */
export const submitWorkflow = async (fetchImpl, endpoint, workflow, { clientId = 'cerebrum', timeoutMs = 30000 } = {}) => {
  const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`comfyui /prompt ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json()
  if (json?.error) throw new Error(`comfyui rejected workflow: ${JSON.stringify(json.error).slice(0, 300)}`)
  const promptId = json?.prompt_id
  if (!promptId) throw new Error('comfyui returned no prompt_id')
  return promptId
}

/** Poll /history until the prompt finishes; returns the history entry. */
export const waitForPrompt = async (fetchImpl, endpoint, promptId, { timeoutMs = 300000, intervalMs = 1500 } = {}) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/history/${promptId}`, { signal: AbortSignal.timeout(15000) })
    if (res.ok) {
      const json = await res.json()
      const entry = json?.[promptId]
      if (entry?.status?.completed === true || entry?.status?.status_str === 'success' || entry?.outputs) return entry
      if (entry?.status?.status_str === 'error') throw new Error(`comfyui prompt failed: ${JSON.stringify(entry.status).slice(0, 400)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`comfyui prompt ${promptId} timed out after ${Math.round(timeoutMs / 1000)}s`)
}

/** Pick the first media file from a history entry and download it. */
export const downloadOutput = async (fetchImpl, endpoint, entry) => {
  const outputs = entry?.outputs ?? {}
  for (const node of Object.values(outputs)) {
    const files = [...(node.images ?? []), ...(node.videos ?? []), ...(node.gifs ?? []), ...(node.files ?? [])]
    const file = files[0]
    if (!file?.filename) continue
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/view?${query.toString()}`, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`comfyui /view ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const ext = file.filename.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
    return { bytes, mime, ext, filename: file.filename }
  }
  throw new Error('comfyui returned no output files')
}

/** One-shot: submit → wait → download. */
export const runWorkflow = async (fetchImpl, endpoint, workflow, { prompt, nodeId, clientId, timeoutMs = 300000, pollMs = 1500 } = {}) => {
  const prepared = applyPrompt(workflow, prompt, { nodeId })
  const promptId = await submitWorkflow(fetchImpl, endpoint, prepared, { clientId })
  const entry = await waitForPrompt(fetchImpl, endpoint, promptId, { timeoutMs, intervalMs: pollMs })
  return downloadOutput(fetchImpl, endpoint, entry)
}
