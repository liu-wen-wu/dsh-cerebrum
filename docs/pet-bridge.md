# 把 cerebrum 接到真实宠物插件的桥接指南

cerebrum 的 P3 输出是 `GET /render-hints`（表情/动作/台词/音高/好感）与 `GET /interact`（摸头/喂食/夸奖/批评 → 评价）。下面是接进两个真实宠物插件的具体路径。

## 1. 接 dsh-pet（@linxin666 注册表式，有公开契约）

dsh-pet 的宿主契约（README 原文）：浏览器↔宿主走 same-origin `/api/pet/*` JSON 端点（state/pets/interact/...）；**宿主侧兄弟插件**用 Cordis 服务 `ctx.pet` 推送结构化公告：

```js
ctx.pet.announce({ source: 'cerebrum', kind: 'emotion', title: hints.line, ... })
```

### 方案 A：宿主侧桥接（推荐，30 行小插件）

```js
// dsh-cerebrum-pet-bridge/lib/index.js —— 说明性代码，端点字段以 dsh-pet 实现为准
export const name = 'cerebrum-pet-bridge'
export const inject = []
export function apply(ctx) {
  const cerebrum = ctx.get('cerebrum')     // 我们 provide 的服务
  const pet = ctx.get('pet')               // dsh-pet 的服务
  let last = null
  const timer = setInterval(() => {
    const hints = cerebrum.renderHintsFor()        // 或轮询 http://127.0.0.1:18734/render-hints
    if (!last || last.emotionKey !== hints.emotionKey || last.animation !== hints.animation) {
      last = hints
      pet.announce?.({ source: 'cerebrum', kind: 'emotion', title: hints.line, expression: hints.expression, animation: hints.animation })
    }
  }, 5000)
  ctx.effect(() => () => clearInterval(timer))
}
```

反向通道：dsh-pet 的 `petCooldown / feed / noTreats` 等互动事件 → 调 `cerebrum.interact('pet' | 'feed', sessionId)` 或 GET `/interact?kind=…`，宠物的互动就成为大脑的评价事件。

### 方案 B：浏览器半侧

我们的 client bundle（`lib/client.js`）已示范浏览器如何消费大脑状态。要驱动 dsh-pet，浏览器插件直接 fetch 同源 `/api/pet/*` 端点即可（dsh-pet README 明示"浏览器半侧插件通过现有 /api/pet/* 端点驱动宠物"）。

## 2. 接 dsh-dafeiyu（509★ 桌面窗宠物，无公开控制 API）

dsh-dafeiyu 的状态全部来自 DSH 会话事件、不读屏幕。**零 fork 集成**靠"提示词侧"：

1. cerebrum 的动态上下文每轮都在（情绪/人格/常驻记忆行）；
2. 让模型偶尔通过 `cerebrum_state` 或直接在回复中表达情绪——宠物读到的就是真实的情绪状态；
3. 原生窗口的 8 态动画已经会跟着会话事件走，大脑状态跟着助手消息走。

要更深集成（改窗口气泡）需要给 dsh-dafeiyu 提 PR 加一个可选的状态源，我们的 `/render-hints` 是现成的喂给它的端点。

## 3. 端到端验证（不必装宠物也能验）

```powershell
npm run pet                  # 大脑侧：表情/台词随互动变化的完整弧线
node examples/pet-hook.mjs   # 轮询循环示例（1 秒采样，等价于宠物外壳的轮询）
```

## 4. 桥接层放哪

**不需要新仓库**：桥接逻辑就两个 fetch/两个服务调用，适合做成 30 行的 `dsh-cerebrum-pet-bridge` 小插件（依赖 dsh-pet + dsh-cerebrum），或者干脆直接内嵌进任何宠物二创里。cerebrum 本体只负责把大脑语言翻译好（已做）。
