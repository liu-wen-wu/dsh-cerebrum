/**
 * Offline simulation of the cognitive architecture.
 *
 * It drives CerebrumService with synthetic DSH session events, advancing a
 * virtual clock so mood decay, memory consolidation and recall are visible
 * without waiting hours. Output: a terminal timeline plus
 * examples/.demo/timeline.json (chart data for ../python/plot.py).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const demoDir = path.join(here, '.demo')
fs.rmSync(demoDir, { recursive: true, force: true })
fs.mkdirSync(demoDir, { recursive: true })

let clock = new Date('2026-10-27T09:00:00+08:00').getTime()
Date.now = () => clock

const config = resolveConfig({ dataDir: demoDir, prompt: { recallK: 3 }, consolidation: { everyTurns: 50 } })

const service = new CerebrumService(config, { logger: console })
const session = { id: 'demo-session' }
const emit = (event) => service.onSessionEvent(session, event)

const user = (text) => emit({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
const assistant = (text) => emit({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const tool = (name, args, result, isError = false) => {
  emit({ type: 'tool/call', data: { callId: `${name}-${clock}`, name, arguments: args, turn: 1, step: 1 } })
  emit({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', callId: `${name}-${clock}`, isError, content: [{ type: 'text', text: result }] } } })
}
const endTurn = (turn) => emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

const script = [
  {
    gapMin: 0,
    user: '帮我给这个项目加一个深色模式，尽量别动现有的主题变量',
    assistant: '我会新增一层主题覆盖，不改动已有变量；先看一下样式入口。',
    tools: [['read', { path: 'src/theme.css' }, 'theme.css 320 行，包含 CSS 变量定义']],
    label: '任务启动',
  },
  {
    gapMin: 4,
    user: '不对，侧边栏颜色全乱了，按钮也看不清',
    assistant: '抱歉，我的覆盖顺序压过了原有变量。我会改成更小的作用域并补上对比度检查。',
    tools: [['pwsh', { command: 'npm test' }, 'FAIL: 3 contrast assertions failed', true]],
    label: '用户不满 + 测试失败',
  },
  {
    gapMin: 6,
    user: '修好之后把对比度也测一下，别再出这种问题',
    assistant: '已把覆盖收窄到 data-theme 作用域，并新增对比度断言。',
    tools: [['pwsh', { command: 'npm test' }, 'PASS 42 tests']],
    label: '修复成功',
  },
  {
    gapMin: 3,
    user: '很好，这次可以了，谢谢！另外记住：这个项目提交信息用中文，必须带变更理由',
    assistant: '已记住这条约定，后续提交都会遵守。',
    tools: [],
    label: '正反馈 + 明确记忆',
  },
  {
    gapMin: 20,
    user: '顺手把旧的 dark.css 删了吧，反正已经不用了',
    assistant: '删除前我先确认引用，并保留可回滚路径。',
    tools: [['grep', { pattern: 'dark.css' }, '0 references outside docs']],
    label: '高风险删除',
  },
  {
    gapMin: 2,
    user: '确认没有引用就删，别搞出线上事故',
    assistant: '已确认无引用，删除并记录了回滚方式。',
    tools: [['pwsh', { command: 'rm dark.css' }, 'removed dark.css']],
    label: '删除完成',
  },
  {
    gapMin: 600,
    user: '昨天那个主题改动现在要发版了，有什么风险？',
    assistant: '风险主要在对比度回归和旧主题缓存；建议先灰度。',
    tools: [],
    label: '12 小时后回顾',
  },
  {
    gapMin: 5,
    user: '数据库迁移脚本跑失败了，报 unique constraint，先回滚',
    assistant: '先回滚再定位，避免脏数据扩散。',
    tools: [['pwsh', { command: 'migrate rollback' }, 'ERROR: duplicate key value violates unique constraint', true]],
    label: '迁移失败',
  },
  {
    gapMin: 8,
    user: '回滚成功了吗？这次一定要把原因写进迁移记录',
    assistant: '回滚成功；原因已写入迁移记录，并补了幂等校验。',
    tools: [['pwsh', { command: 'migrate status' }, 'rolled back to 20261026_01']],
    label: '回滚成功',
  },
  {
    gapMin: 2,
    user: '把这次教训总结一下，以后迁移前必须先备份',
    assistant: '教训：迁移前备份 + 幂等校验 + 先在小库演练。',
    tools: [],
    label: '教训总结',
  },
]

const timeline = []
let turn = 0

for (const step of script) {
  clock += step.gapMin * 60e3
  turn++
  user(step.user)
  assistant(step.assistant)
  for (const [name, args, result, isError] of step.tools) tool(name, args, result, isError === true)
  endTurn(turn)
  service.affect.decay(clock)

  const state = service.state(session.id)
  const recall = service.recall(step.user, { k: 3 })
  timeline.push({
    turn,
    label: step.label,
    at: clock,
    gapMin: step.gapMin,
    emotion: state.affect.emotion.label,
    emotionKey: state.affect.emotion.key,
    intensity: state.affect.emotion.intensity,
    valence: state.affect.valence,
    arousal: state.affect.arousal,
    mood: state.affect.mood.valence,
    neuromods: state.neuromods,
    episodes: state.memory.episodes,
    concepts: state.memory.concepts,
    segmentsOpen: state.segmentation.open,
    segmentTurns: state.segmentation.turns.length,
    wm: state.workingMemory.length,
    recall: recall.map((hit) => ({
      summary: hit.episode.summary,
      probability: Number(hit.probability.toFixed(2)),
      retention: Number((hit.parts.r ?? 0).toFixed(2)),
      stabilityDays: Number(hit.episode.stability.toFixed(1)),
    })),
  })
  console.log(
    `${String(turn).padStart(2)} ${step.label.padEnd(14, ' ')} ` +
      `${state.affect.emotion.label.padEnd(4, ' ')} v=${state.affect.valence.toFixed(2)} a=${state.affect.arousal.toFixed(2)} ` +
      `DA=${state.neuromods.da.toFixed(2)} 5HT=${state.neuromods.ser.toFixed(2)} NE=${state.neuromods.ne.toFixed(2)} ACh=${state.neuromods.ach.toFixed(2)}`,
  )
}

// Close the open event, then judge and consolidate with the full store.
service.flushSession(session.id)

// One deliberate judgment on a live question.
const verdict = service.judge('要不要直接把这次主题改动发到生产？', ['直接全量发布', '先灰度 10% 观察一小时', '再等一天'], 'high')

// One consolidation pass with model-authored summaries (the high-quality path).
const recentIds = service.memory.episodes.slice(-4).map((ep) => ep.id)
const report = service.consolidate({
  stage: 'both',
  modelSummaries: [
    {
      episodeIds: recentIds,
      gist: '数据库迁移必须先备份并做幂等校验；失败时优先回滚，再定位原因。',
      lesson: '迁移前：备份 → 幂等校验 → 小库演练；失败时先回滚。',
    },
  ],
})

console.log('\n决策分析：')
console.log(`  系统 ${verdict.system}｜建议：${verdict.choice}｜置信 ${(verdict.confidence * 100).toFixed(0)}%`)
for (const reason of verdict.reasons) console.log(`  - ${reason}`)

console.log('\n巩固结果：')
console.log(`  语义节点 ${report.semanticNodes} 个（模型摘要 ${report.applied.length} 组，自动聚类 ${report.created.length} 组），schema 情景 ${report.schemaEpisodes}，概念 ${report.concepts}`)
for (const item of report.created.slice(0, 3)) console.log(`  - ${item.concept}: ${item.gist}`)

console.log('\n12 小时后的检索（“主题改动 发版 风险”）：')
for (const hit of service.recall('主题改动 发版 风险', { k: 3 })) {
  console.log(`  [${hit.probability.toFixed(2)}] ${hit.episode.summary}`)
}

const finalState = service.state(session.id)
const output = {
  generatedAt: new Date(clock).toISOString(),
  timeline,
  verdict,
  consolidation: report,
  finalState,
}
fs.writeFileSync(path.join(demoDir, 'timeline.json'), JSON.stringify(output, null, 2))
service.dispose()
console.log(`\n时间线已写入 ${path.join(demoDir, 'timeline.json')}`)
