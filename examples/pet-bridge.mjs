/**
 * Pet bridge demo: a simulated pet shell consuming the cerebrum's brain.
 *
 * The loop shows what a pet plugin (dsh-pet / dsh-dafeiyu / live2d) would do
 * with the /render-hints and /interact endpoints:
 *   1. poll hints every second (expression / animation / line / voice pitch),
 *   2. send interactions (pet / feed / praise / scold),
 *   3. watch the emotion, affinity and tone change as the appraisal loop runs.
 *
 * Run: node examples/pet-bridge.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { CerebrumService } from '../lib/service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebrum-pet-demo-'))
const service = new CerebrumService(resolveConfig({ home, cwd: path.join(home, 'ws'), personality: { preset: 'warm-companion' } }))

const session = { id: 'pet-demo', header: { cwd: path.join(home, 'ws') } }
const user = (text) => service.onSessionEvent(session, { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } })
const assistant = (text) => service.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const end = (turn) => service.onSessionEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

// A working day: a success, then a failure.
user('把主题改动发版')
assistant('发版完成，灰度 10% 观察中')
end(1)
service.flushSession('pet-demo')
user('发版出错了，回滚')
assistant('已回滚到上一版本')
end(2)
service.flushSession('pet-demo')

const show = (label, hints) => {
  console.log(
    `${label.padEnd(12)} 表情=${(hints.expression ?? '?').padEnd(9)} 动作=${(hints.animation ?? '?').padEnd(8)} 台词="${hints.line}" 音高=${hints.voicePitch} 好感=${hints.affinityLevel}`,
  )
}

console.log('=== 大肥鱼 · 大脑接线演示（宠物外壳 ↔ dsh-cerebrum） ===\n')
show('启动', service.renderHintsFor('pet-demo'))

const day = [
  ['pet', '主人摸了摸头'],
  ['praise', '“干得漂亮！”'],
  ['feed', '喂了一条小鱼干'],
  ['scold', '“怎么又搞错了”'],
]
for (const [kind, caption] of day) {
  console.log(`\n>>> 互动：${caption}`)
  show('反应', service.interact(kind, 'pet-demo'))
}

console.log('\n>>> 30 分钟后（无人理睬，心境回归）……')
service.sessions.get('pet-demo').lastTurnAt = Date.now() - 10 * 60e3
service.affect.decay(Date.now() + 30 * 60e3)
show('发呆中', service.renderHintsFor('pet-demo'))

const state = service.state('pet-demo')
console.log('\n=== 大脑状态快照 ===')
console.log(`情绪：${state.affect.emotion.label}（强度 ${state.affect.emotion.intensity.toFixed(2)}）`)
console.log(`好感：${state.affinity.level}（正性占比 ${Math.round(state.affinity.positiveShare * 100)}%）`)
console.log(`记忆：${state.memory.episodes} 条情景 · ${state.memory.concepts} 个概念 · 待办意图 ${state.intentions.active} 条`)
console.log(`\n宠物外壳拿到的东西：表情/动作/台词/音高 由 /render-hints 每 5 秒轮询；`)
console.log(`摸头/喂食/夸奖/批评 用 /interact 发回给大脑做评价——这就是 P3 的完整接线。`)
service.dispose()
