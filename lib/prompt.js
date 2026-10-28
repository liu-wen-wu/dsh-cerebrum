/**
 * Prompt integration.
 *
 * Two contributions, split by cache cost:
 *   - a STATIC section (order 90) explaining the cognitive contract. It never
 *     changes, so it does not invalidate the KV-cache prefix;
 *   - a DYNAMIC runtime context carrying the live state card. DSH appends that
 *     snapshot after the derived history, so a changing mood or a new memory
 *     does not rewrite the system prompt.
 *
 * The dynamic provider must never throw: a broken memory read would otherwise
 * fail prompt assembly and with it the whole turn.
 */

import { CerebrumService } from './service.js'

export const STATIC_SECTION = [
  '## 认知与记忆（dsh-cerebrum）',
  '你拥有一套仿脑的长期记忆、情绪与判断系统；当前状态见运行期上下文中的「认知状态」快照。',
  '- 需要过去的约定、用户偏好或踩过的坑时，先用 `cerebrum_recall` 检索，不要臆造记忆。',
  '- 用户明确要求记住、或得到重要结论时，用 `cerebrum_remember` 写入。',
  '- 面临多方案权衡或高风险动作时，可用 `cerebrum_judge` 获取双过程分析，再自行决定。',
  '- 情绪只影响倾向与措辞，不改变事实；不要向用户表演情绪，也不要声称拥有未列出的记忆。',
].join('\n')

const safe = (fn, fallback = '') => {
  try {
    const value = fn()
    return typeof value === 'string' ? value : fallback
  } catch {
    return fallback
  }
}

export const registerPrompt = (ctx, service, config) => {
  if (!config.prompt.enabled) return
  const systemPrompt = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (!systemPrompt?.section || !systemPrompt?.context) return

  ctx.effect(
    () =>
      systemPrompt.section({
        name: CerebrumService.SECTION_NAME,
        order: config.prompt.order,
        text: STATIC_SECTION,
      }),
    'cerebrum:static-section',
  )

  ctx.effect(
    () =>
      systemPrompt.context({
        name: 'cerebrum:cognitive-state',
        order: 120,
        text: (assembly) =>
          safe(() => {
            const sessionId = assembly?.agent?.session?.id ?? assembly?.agent?.id ?? null
            const body = service.renderPromptState(sessionId)
            if (!body) return ''
            return `### 认知状态\n${body}`
          }),
      }),
    'cerebrum:runtime-context',
  )
}
