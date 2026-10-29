/**
 * ComfyUI connectivity + workflow checker.
 *
 *   node scripts/comfy-check.mjs [--endpoint http://127.0.0.1:8188] [--workflow D:\path\api.json] [--run "prompt"]
 *
 * - pings /system_stats (is ComfyUI running?)
 * - validates that the workflow file is API format (Workflow → Export (API))
 * - with --run, submits one generation and saves the output under ./comfy-out/
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadOutput, isApiWorkflow, runWorkflow, submitWorkflow, waitForPrompt } from '../lib/core/comfy.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const endpoint = argOf('--endpoint', 'http://127.0.0.1:8188').replace(/\/$/, '')
const workflowPath = argOf('--workflow', '')
const runPrompt = argOf('--run', '')

const main = async () => {
  console.log(`ComfyUI endpoint: ${endpoint}`)
  try {
    const res = await fetch(`${endpoint}/system_stats`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const stats = await res.json()
    console.log(`✓ 在线：comfyui ${stats?.system?.comfyui_version ?? '?'} · device ${stats?.devices?.[0]?.name ?? '?'}`)
  } catch (error) {
    console.log(`✗ 连不上：${error.message}`)
    console.log('  启动方式：D:\\ComfyUI\\run_comfy_safe.bat（或 venv\\Scripts\\python.exe main.py --listen 127.0.0.1 --port 8188）')
    process.exitCode = 1
    return
  }

  if (!workflowPath) {
    console.log('· 未提供 --workflow：只做了连通性检查。')
    console.log('  接入生成需要一份 API 格式工作流：ComfyUI 菜单 Workflow → Export (API) → 保存 json。')
    return
  }

  let workflow
  try {
    workflow = JSON.parse(fs.readFileSync(path.resolve(workflowPath), 'utf8'))
  } catch (error) {
    console.log(`✗ 读不到工作流：${error.message}`)
    process.exitCode = 1
    return
  }
  if (!isApiWorkflow(workflow)) {
    console.log('✗ 工作流不是 API 格式（含 nodes/links，是 UI 格式）。')
    console.log('  在 ComfyUI 里用 Workflow → Export (API) 重新导出，然后把路径填到 config.imagegen.comfyWorkflow。')
    process.exitCode = 1
    return
  }
  const nodes = Object.entries(workflow).map(([id, node]) => `${id}:${node.class_type}`).join(', ')
  console.log(`✓ API 格式工作流：${Object.keys(workflow).length} 个节点（${nodes}）`)

  if (!runPrompt) {
    console.log('· 加 --run "提示词" 可以真跑一次生成（会占用 GPU）。')
    return
  }

  const started = Date.now()
  console.log(`▶ 提交生成：${runPrompt}`)
  const result = await runWorkflow(fetch, endpoint, workflow, { prompt: runPrompt, timeoutMs: 600000, pollMs: 2000 })
  const outDir = path.join(root, 'comfy-out')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `comfy-${Date.now()}.${result.ext}`)
  fs.writeFileSync(outFile, result.bytes)
  console.log(`✓ 完成（${Math.round((Date.now() - started) / 1000)}s）→ ${outFile} (${Math.round(result.bytes.length / 1024)} KB, ${result.mime})`)
  console.log('  把它放进 pet-assets/ 后可用 cerebrum_pet_asset 注册，或直接用上面的路径做一次 /anim 测试。')
}

main().catch((error) => {
  console.error('✗', error.message)
  process.exitCode = 1
})
