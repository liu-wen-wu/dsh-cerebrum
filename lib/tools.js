/**
 * Model-facing tools.
 *
 * These are the deliberate hands of the system: the model can recall, write a
 * memory, ask for a decision analysis, appraise an event, trigger a sleep-like
 * consolidation, or edit its own personality. Automatic capture happens in
 * service.js without the model's involvement; tools exist for the cases where
 * introspection or explicit control is worth a round-trip.
 *
 * Definitions are plain objects in the shape `@deepseek-ai/dsh-tools` expects, so
 * the plugin needs no runtime import from the harness and keeps working across
 * patch releases.
 */

import { clamp } from './core/math.js'

const json = (schema) => ({ type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [], additionalProperties: false })

/** Minimal argument validation; the registry trusts `defineTool` wrappers otherwise. */
const validate = (schema, args) => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Error(`missing required argument "${key}"`)
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = args[key]
    if (value === undefined) continue
    if (spec.type === 'string' && typeof value !== 'string') throw new Error(`argument "${key}" must be a string`)
    if (spec.type === 'integer' && !Number.isInteger(value)) throw new Error(`argument "${key}" must be an integer`)
    if (spec.type === 'number' && typeof value !== 'number') throw new Error(`argument "${key}" must be a number`)
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`argument "${key}" must be a boolean`)
    if (spec.type === 'array' && !Array.isArray(value)) throw new Error(`argument "${key}" must be an array`)
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`argument "${key}" must be one of ${spec.enum.join(', ')}`)
  }
  return args
}

const define = (definition) => {
  const parameters = definition.parameters
  return {
    name: definition.name,
    description: definition.description,
    parameters,
    output: {
      schema: definition.output.schema,
      render: definition.output.render,
    },
    async execute(args, exec) {
      validate(parameters, args ?? {})
      return definition.execute(args ?? {}, exec)
    },
  }
}

const sessionIdOf = (exec) => {
  const id = exec?.agent?.session?.id ?? exec?.agent?.id
  return typeof id === 'string' ? id : null
}

const bar = (value, width = 10) => {
  const filled = Math.round(clamp(value, 0, 1) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))} ${clamp(value, 0, 1).toFixed(2)}`
}

const toneOf = (v) => (v > 0.15 ? '正' : v < -0.15 ? '负' : '中')

const ago = (at, now = Date.now()) => {
  const delta = Math.max(0, now - at)
  if (delta < 60e3) return '刚刚'
  if (delta < 3600e3) return `${Math.round(delta / 60e3)}分钟前`
  if (delta < 86400e3) return `${Math.round(delta / 3600e3)}小时前`
  return `${Math.round(delta / 86400e3)}天前`
}

export const buildTools = (service) => [
  define({
    name: 'cerebrum_recall',
    description:
      '按线索检索长期记忆（海马式模式补全 + 概念扩散激活）。当需要过去的决定、用户偏好、踩过的坑或未完成的约定时先调用它。返回记忆摘要、时间、情绪色彩与置信度，而不是原始全文。',
    parameters: json({
      properties: {
        query: { type: 'string', description: '检索线索：关键词、问题或情境描述' },
        k: { type: 'integer', description: '返回条数，默认 5，最大 10' },
        kinds: {
          type: 'array',
          description: '限定记忆类型',
          items: { type: 'string', enum: ['episodic', 'explicit', 'semantic'] },
        },
      },
      required: ['query'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const k = Math.min(Math.max(args.k ?? 5, 1), 10)
      const sessionId = sessionIdOf(exec)
      const hits = service.recall(args.query, { k, kinds: args.kinds, sessionId })
      const skills = service.skills(args.query, sessionId)
      if (hits.length === 0) {
        // Partial cue with no full match: report a graded feeling of knowing
        // rather than a flat "I don't remember" (Koriat 1993).
        const probe = service.probe(args.query, sessionId)
        const confidence = Math.min(0.45, Math.max(0, (probe.similarity - 0.03) * 1.2))
        const hint = confidence > 0.08
          ? `知道感 ${(confidence * 100).toFixed(0)}%：可能有一条相关记忆（线索相似度 ${probe.similarity.toFixed(2)}），但当前线索不足以取回。可以换关键词或提供更多上下文。`
          : '没有检索到相关长期记忆。这是一段新经验，建议从头建立上下文。'
        return { count: 0, confidence: 0, feelingOfKnowing: Number(confidence.toFixed(3)), text: hint, memories: [] }
      }
      const lines = [`检索「${args.query}」→ ${hits.length} 条记忆（按激活强度排序）：`]
      for (const hit of hits) {
        const ep = hit.episode
        const retention = hit.parts.r ?? 0
        lines.push(
          `- [${ago(ep.at)}｜${toneOf(ep.affect.v)}向｜重要度 ${ep.importance.toFixed(2)}｜保有 ${(retention * 100).toFixed(0)}%｜置信 ${hit.probability.toFixed(2)}] ${ep.summary}`,
        )
      }
      const best = hits[0]
      lines.push(
        `\n机制：扩散 ${best.parts.spread.toFixed(2)}｜语义相似 ${best.parts.similarity.toFixed(2)}｜词面 ${(best.parts.lex ?? 0).toFixed(2)}｜时序上下文 ${(best.parts.context ?? 0).toFixed(2)}｜补全 ${best.parts.attractor ?? 0} 步｜稳定性 ${best.episode.stability.toFixed(1)} 天｜提取时延 ~${Math.round(best.parts.latency ?? 0)}ms`,
      )
      if (best.parts.linked) lines.push('（含 1 条由情景链接补全的邻近记忆）')
      if (skills.length > 0) lines.push(`\n既有做法（程序性记忆）：${skills.map(({ skill }) => `${skill.do}（强度 ${skill.strength.toFixed(2)}）`).join('；')}`)
      lines.push(`\n最相关的一条（激活 ${best.activation.toFixed(2)}）：${best.episode.text.slice(0, 280)}`)
      return {
        count: hits.length,
        confidence: Number(best.probability.toFixed(3)),
        skills: skills.map(({ skill, score }) => ({ id: skill.id, when: skill.when, do: skill.do, strength: skill.strength, score })),
        memories: hits.map((hit) => ({
          id: hit.episode.id,
          at: hit.episode.at,
          summary: hit.episode.summary,
          importance: hit.episode.importance,
          valence: hit.episode.affect.v,
          probability: Number(hit.probability.toFixed(3)),
          retention: hit.parts.r ?? null,
          stabilityDays: Number(hit.episode.stability.toFixed(2)),
          activation: Number(hit.activation.toFixed(3)),
          concepts: hit.episode.concepts,
          rawRefs: (hit.episode.rawSeqs ?? []).map((seq) => ({ sessionId: hit.episode.sessionId, seq })),
        })),
        text: lines.join('\n'),
      }
    },
  }),

  define({
    name: 'cerebrum_remember',
    description:
      '显式写入一条长期记忆（情景/事实/偏好）。适合用户明确要求记住的内容、重要结论或跨会话约定。写入会自动建立概念关联并受情绪显著性加权。',
    parameters: json({
      properties: {
        text: { type: 'string', description: '要记住的内容，写清情境与结论' },
        summary: { type: 'string', description: '一句话摘要，用于未来检索展示' },
        importance: { type: 'number', description: '重要度 0..1，默认 0.6' },
        resident: { type: 'boolean', description: '标记为常驻记忆（偏好/约定），每轮注入；默认 false' },
        force: { type: 'boolean', description: '跳过近重复合并，强制写入一条新记忆；默认 false' },
        tags: { type: 'array', description: '标签', items: { type: 'string' } },
        kind: { type: 'string', enum: ['explicit', 'semantic', 'episodic'], description: '记忆类型，默认 explicit' },
      },
      required: ['text'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const episode = service.remember({
        text: args.text,
        summary: args.summary,
        importance: args.importance,
        resident: args.resident === true,
        force: args.force === true,
        tags: args.tags,
        kind: args.kind ?? 'explicit',
        sessionId: sessionIdOf(exec),
      })
      const dedup = episode.duplicate ? '（与既有记忆重复，已就地强化而非重复写入）' : ''
      return {
        id: episode.id,
        at: episode.at,
        summary: episode.summary,
        concepts: episode.concepts,
        resident: episode.resident === true,
        duplicate: episode.duplicate === true,
        strength: Number(episode.strength.toFixed(3)),
        text: `${episode.duplicate ? '已强化' : '已写入'}记忆 ${episode.id}${dedup}：${episode.summary}\n关联概念：${episode.concepts.join('、') || '（无）'}\n初始强度 ${episode.strength.toFixed(2)}（受当前情绪显著性影响）`,
      }
    },
  }),

  define({
    name: 'cerebrum_forget',
    description:
      '主动忘记记忆：按 id 列表删除，或按 query 精确命中一条后删除（写进遗忘日志，可审计）。适合用户要求"忘掉这件事/以后别提"的场景。',
    parameters: json({
      properties: {
        ids: { type: 'array', description: '要删除的记忆 id 列表', items: { type: 'string' } },
        query: { type: 'string', description: '按线索定位一条记忆（取最佳命中），与 ids 合并执行' },
        reason: { type: 'string', description: '遗忘原因（写入审计日志）' },
      },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const removed = service.forget({ ids: args.ids, query: args.query, reason: args.reason, sessionId: sessionIdOf(exec) })
      const lines = removed.length > 0
        ? [`已遗忘 ${removed.length} 条记忆：`].concat(removed.map((item) => `- ${item.id}：${item.summary}`))
        : ['没有匹配到要遗忘的记忆。']
      return { removed, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_update',
    description:
      '就地修正一条记忆（摘要/正文/重要度/标签/常驻标记），不改变其稳定性与复习史。用于"我之前记得不准确，改成这样"。',
    parameters: json({
      properties: {
        id: { type: 'string', description: '要更新的记忆 id；与 query 二选一' },
        query: { type: 'string', description: '按线索定位一条记忆（取最佳命中）' },
        summary: { type: 'string', description: '新的摘要' },
        text: { type: 'string', description: '新的正文' },
        importance: { type: 'number', description: '新的重要度 0..1' },
        resident: { type: 'boolean', description: '是否常驻' },
        tags: { type: 'array', description: '新标签', items: { type: 'string' } },
      },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const store = service._storeForSession(sessionId)
      let id = args.id
      if (!id && typeof args.query === 'string' && args.query.trim().length > 0) {
        const hit = store.recall(args.query, { k: 1, reinforce: false })[0]
        id = hit?.episode.id
      }
      if (!id) return { updated: null, text: '需要 id 或能定位一条记忆的 query。' }
      const updated = service.update(id, { summary: args.summary, text: args.text, importance: args.importance, tags: args.tags, resident: args.resident }, sessionId)
      if (!updated) return { updated: null, text: `记忆 ${id} 不存在。` }
      return {
        updated: { id: updated.id, summary: updated.summary, importance: updated.importance, resident: updated.resident },
        text: `已更新记忆 ${updated.id}：${updated.summary}`,
      }
    },
  }),

  define({
    name: 'cerebrum_intend',
    description:
      '前瞻记忆：设定"当触发词出现时提醒我做 X"的意图（事件型线索），或带截止时间的时间型意图。当前轮命中触发词时意图会自动出现在提示里。',
    parameters: json({
      properties: {
        operation: { type: 'string', enum: ['add', 'list', 'complete'], description: 'add=新增意图，list=查看，complete=按 ids 完成' },
        trigger: { type: 'string', description: '触发词/关键词（用户提到它时提醒）' },
        action: { type: 'string', description: '提醒的动作内容' },
        dueAt: { type: 'number', description: '可选：截止时间（毫秒时间戳）' },
        ids: { type: 'array', description: 'complete 时要完成的意图 id', items: { type: 'string' } },
      },
      required: ['operation'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      if (args.operation === 'add') {
        const item = service.intend({ trigger: args.trigger, action: args.action, dueAt: args.dueAt })
        return { intention: item, text: `已记住意图 ${item.id}：当出现「${item.trigger}」时 → ${item.action}` }
      }
      if (args.operation === 'complete') {
        const completed = service.completeIntentions(args.ids ?? [])
        return { completed, text: `已完成 ${completed} 条意图。` }
      }
      const active = service.intentions.filter((item) => !item.done)
      const done = service.intentions.filter((item) => item.done)
      const lines = [`前瞻意图：${active.length} 条待办，${done.length} 条已完成。`]
      for (const item of active) lines.push(`- ${item.id}：出现「${item.trigger}」→ ${item.action}${item.dueAt ? `（截止 ${new Date(item.dueAt).toISOString()}）` : ''}`)
      return { active, done: done.length, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_character',
    description:
      '角色卡（SillyTavern/tavern 格式）：import 导入 JSON 或带 chara 元数据的 PNG 并映射为 Big Five 人设；apply 加载为全局人格；list 查看已导入的角色。',
    parameters: json({
      properties: {
        operation: { type: 'string', enum: ['import', 'apply', 'list'], description: '默认 list' },
        card: { type: 'string', description: 'import 用：卡片 JSON 文本，或 PNG 文件的绝对路径' },
        name: { type: 'string', description: 'apply 用：已导入的角色名' },
      },
      required: ['operation'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (args.operation === 'import') {
        let input = args.card
        if (typeof input === 'string' && input.trim().startsWith('{')) input = JSON.parse(input)
        else if (typeof input === 'string' && input.trim().match(/^[A-Za-z]:[\\/]/)) input = service.readFile?.(input) // host helper (see below)
        if (input == null) return { persona: null, text: '需要 card：JSON 文本或 PNG 绝对路径（PNG 需通过 cerebrum_character 的 host 支持）。' }
        const persona = service.importCard(input, { sessionId })
        return {
          persona,
          text: `已导入角色「${persona.name}」→ 人设 ${persona.preset}（O${persona.traits.openness} C${persona.traits.conscientiousness} E${persona.traits.extraversion} A${persona.traits.agreeableness} N${persona.traits.neuroticism}）。用 operation=apply 加载。`,
        }
      }
      if (args.operation === 'apply') {
        const persona = service.applyCard(args.name, { sessionId })
        if (!persona) return { persona: null, text: `没有找到角色「${args.name}」，先用 import 导入。` }
        return { persona, text: `已加载角色「${persona.name}」：${persona.identity.slice(0, 120)}` }
      }
      const cards = service.self.cards ?? []
      const lines = [`角色卡：${cards.length} 张。`]
      for (const entry of cards) lines.push(`- ${entry.name}（${entry.persona.preset}，${new Date(entry.at).toISOString().slice(0, 10)}）`)
      return { cards: cards.map((entry) => ({ name: entry.name, preset: entry.persona.preset })), text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_pet_asset',
    description:
      '扩展宠物的动作/表情库：把 $DSH_HOME/cerebrum/pet-assets/ 下的文件（或 http(s) URL）注册成"某种情绪下的动作"，自主行为会按情绪择机播放并学习权重。operation=add/list/remove。',
    parameters: json({
      properties: {
        operation: { type: 'string', enum: ['add', 'list', 'remove'], description: '默认 list' },
        file: { type: 'string', description: 'add 用：pet-assets/ 下的文件名（如 开心转圈.webm）' },
        url: { type: 'string', description: 'add 用：http(s) 远程素材地址（与 file 二选一）' },
        emotion: { type: 'string', description: '动作对应的情绪 key（joy/gratitude/fear/...），默认 calm' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        kind: { type: 'string', enum: ['anim', 'image'], description: '素材类型' },
        id: { type: 'string', description: 'remove 用：资产 id' },
      },
      required: ['operation'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      if (args.operation === 'add') {
        const record = service.addPetAsset({ file: args.file, url: args.url, emotion: args.emotion, tags: args.tags, kind: args.kind })
        return { asset: record, text: `已注册动作 ${record.id}：${record.name}（情绪 ${record.emotion}，权重 ${record.weight}）→ ${record.publicUrl}` }
      }
      if (args.operation === 'remove') {
        const removed = service.removePetAsset(args.id)
        return { removed, text: removed ? `已移除 ${removed.id}（${removed.name}）` : '没有找到该资产。' }
      }
      const assets = service.listPetAssets({})
      const lines = [`宠物动作库：${assets.length} 个。`]
      for (const entry of assets) lines.push(`- ${entry.id}：${entry.name}｜情绪 ${entry.emotion}｜权重 ${entry.weight}${entry.uses ? `｜被用 ${entry.uses} 次` : ''}`)
      return { assets, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_pet_visual',
    description:
      '用图像模型生成一张全新的宠物表情：按当前情绪自动写提示词，生成后存入动作库并返回可播放地址。provider 由 config.imagegen 决定（默认 mock，可离线测试）。',
    parameters: json({
      properties: {
        prompt: { type: 'string', description: '场景/动作描述（可选，情绪模板会自动补充）' },
        emotion: { type: 'string', description: '情绪 key（决定表情模板），默认 calm' },
        scene: { type: 'string', description: '补充场景描述' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      },
      required: ['prompt'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const record = await service.generatePetVisual({ prompt: args.prompt, emotion: args.emotion, scene: args.scene, tags: args.tags })
      return {
        asset: record,
        text: `已生成表情 ${record.id}（情绪 ${record.emotion}，${record.meta?.provider ?? 'mock'}）→ ${record.publicUrl}\n提示词：${record.prompt.slice(0, 160)}`,
      }
    },
  }),

  define({
    name: 'cerebrum_judge',
    description:
      '双过程决策分析：先用记忆中的躯体标记给出直觉，再用期望值、风险、可逆性、努力与价值观做慢系统评估，并返回是否被冲动抑制否决。适合在多个方案间取舍、评估高风险动作前调用。',
    parameters: json({
      properties: {
        question: { type: 'string', description: '要做的决定' },
        options: { type: 'array', description: '候选方案，最多 6 个；留空则只给倾向与检查清单', items: { type: 'string' } },
        stakes: { type: 'string', enum: ['low', 'medium', 'high'], description: '利害程度，默认 medium' },
      },
      required: ['question'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const result = service.judge(args.question, args.options ?? [], args.stakes ?? 'medium', sessionIdOf(exec))
      const lines = [
        `决策：${result.question}`,
        `系统：${result.system === 'S1' ? '快系统（直觉/习惯）' : result.system === 'S1-vetoed' ? '快系统 + 前额叶否决' : '慢系统（审议）'} · 利害：${result.stakes} · 置信：${(result.confidence * 100).toFixed(0)}%`,
        `直觉（躯体标记）：${result.gut.leaning}${result.gut.option ? `，倾向「${result.gut.option}」` : ''}（${result.gut.value}）· 冲突：${result.conflict}`,
        `建议：${result.choice}`,
      ]
      if (result.options.length > 0) {
        lines.push('', '方案评分：')
        for (const option of result.options) {
          lines.push(`- ${option.option}\n  得分 ${option.score}｜期望值 ${option.expectedValue}｜风险 ${option.risk}｜成功概率 ${(option.probability * 100).toFixed(0)}%｜${option.reversible ? '可逆' : '不可逆'}`)
        }
      }
      if (result.reasons.length > 0) lines.push('', '理由：', ...result.reasons.map((reason) => `- ${reason}`))
      if (result.checklist.length > 0) lines.push('', '慢系统检查清单：', ...result.checklist.map((item) => `- ${item}`))
      return { ...result, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_appraise',
    description:
      '对一件事做情绪评估并更新内部状态（效价、唤醒、心境、四种神经调质）。可显式给出评估维度；给出 outcome 时会先按成败注入奖赏/惩罚信号。适合在任务成功、失败或用户强烈反馈后调用。',
    parameters: json({
      properties: {
        event: { type: 'string', description: '发生了什么（用于情绪归因）' },
        outcome: { type: 'string', enum: ['success', 'failure'], description: '客观结果，可省略' },
        relevance: { type: 'number', description: '与目标的相关性 0..1' },
        congruence: { type: 'number', description: '与目标一致程度 -1..1' },
        novelty: { type: 'number', description: '新颖/意外程度 0..1' },
        certainty: { type: 'number', description: '确定性 0..1（越低越焦虑/好奇）' },
        agency: { type: 'number', description: '自因程度 0..1' },
        control: { type: 'number', description: '可控/应对能力 0..1' },
        norm: { type: 'number', description: '规范一致性 -1..1' },
        urgency: { type: 'number', description: '紧迫性 0..1' },
        magnitude: { type: 'number', description: '后果量级 0..1' },
      },
      required: ['event'],
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const dimensions = {}
      for (const key of ['relevance', 'congruence', 'novelty', 'certainty', 'agency', 'control', 'norm', 'urgency', 'magnitude']) {
        if (typeof args[key] === 'number') dimensions[key] = args[key]
      }
      if (Object.keys(dimensions).length === 0 && args.outcome) {
        Object.assign(dimensions, {
          relevance: 0.7,
          congruence: args.outcome === 'success' ? 0.8 : -0.7,
          novelty: 0.4,
          certainty: 0.7,
          agency: 0.6,
          control: args.outcome === 'success' ? 0.75 : 0.35,
          urgency: 0.4,
          magnitude: 0.6,
        })
      }
      const emotion = service.appraise({ event: args.event, dimensions, outcome: args.outcome })
      const snapshot = service.state().affect
      const lines = [
        `评估：${args.event}`,
        `情绪：${emotion.label}（强度 ${emotion.intensity.toFixed(2)}）`,
        `核心情感：效价 ${snapshot.valence}｜唤醒 ${snapshot.arousal}｜心境 ${snapshot.mood.valence}`,
        `神经调质：DA ${snapshot.neuromods.da}｜5-HT ${snapshot.neuromods.ser}｜NE ${snapshot.neuromods.ne}｜ACh ${snapshot.neuromods.ach}`,
      ]
      return { emotion, affect: snapshot, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_consolidate',
    description:
      '触发一次“睡眠式”记忆巩固：把重复出现的经历提炼为语义概念与规律，强化概念关联，弱化无用连接并压缩低价值记忆。可附带模型自己写的摘要（gist/lesson），质量高于自动抽取。',
    parameters: json({
      properties: {
        stage: { type: 'string', enum: ['nrem', 'rem', 'both'], description: 'nrem=重放与语义化，rem=联想与情绪脱钩，both=两阶段（默认）' },
        summaries: {
          type: 'array',
          description: '可选的模型摘要，每条针对若干记忆 id',
          items: {
            type: 'object',
            properties: {
              episodeIds: { type: 'array', items: { type: 'string' } },
              gist: { type: 'string' },
              lesson: { type: 'string' },
              skill: {
                type: 'object',
                description: '可选：沉淀一条程序性规则（when→do），来源标为 model',
                properties: {
                  when: { type: 'array', items: { type: 'string' }, description: '触发情境关键词' },
                  do: { type: 'string', description: '做法/动作' },
                },
                required: ['do'],
              },
            },
            required: ['episodeIds', 'gist'],
          },
        },
      },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const report = service.consolidate({ modelSummaries: args.summaries, stage: args.stage ?? 'both' })
      const lines = [
        `巩固完成（${report.stage}）：应用模型摘要 ${report.applied.length} 组，自动聚类 ${report.created.length} 组，共形成 ${report.semanticNodes} 个语义节点。`,
        `当前记忆：${report.episodes} 条情景 · ${report.concepts} 个概念 · ${report.schemaEpisodes} 条 schema 情景。`,
      ]
      if (report.created.length > 0) {
        lines.push('', '新形成的语义记忆：')
        for (const item of report.created.slice(0, 5)) lines.push(`- ${item.concept}：${item.gist}`)
      }
      return { ...report, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_profile',
    description:
      '查看或修改性格与价值观。Big Five 五维（开放性/尽责性/外向性/宜人性/神经质）会派生探索率、计划深度、冲动抑制、损失厌恶等决策参数。修改会持久化到本工作区的记忆库。',
    parameters: json({
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: '默认 get' },
        scope: {
          type: 'string',
          enum: ['global', 'workspace', 'session'],
          description: '生效范围（set 时用）：全局 / 当前工作区 / 仅本会话；get 会返回三层解析结果',
        },
        preset: {
          type: 'string',
          enum: ['curious-engineer', 'stoic-guardian', 'warm-companion', 'restless-artist'],
          description: '人格预设',
        },
        traits: {
          type: 'object',
          description: '五维取值 0..1',
          properties: {
            openness: { type: 'number' },
            conscientiousness: { type: 'number' },
            extraversion: { type: 'number' },
            agreeableness: { type: 'number' },
            neuroticism: { type: 'number' },
          },
        },
        values: { type: 'array', items: { type: 'string' }, description: '价值排序' },
        goals: { type: 'array', items: { type: 'string' }, description: '长期目标' },
      },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const result = service.profile(args.action ?? 'get', args, { sessionId: sessionIdOf(exec), scope: args.scope ?? 'global' })
      const P = result.params
      const lines = [
        `${result.personality.label}（${result.personality.preset}）`,
        `开放性 ${result.personality.traits.openness}｜尽责性 ${result.personality.traits.conscientiousness}｜外向性 ${result.personality.traits.extraversion}｜宜人性 ${result.personality.traits.agreeableness}｜神经质 ${result.personality.traits.neuroticism}`,
        `生效范围：全局=${result.layers.global} · 工作区=${result.layers.workspace} · 会话=${result.layers.session ?? '跟随'}`,
        `派生参数：探索 ${fmt(P.exploration)}｜计划深度 ${P.planningDepth}｜冲动抑制 ${fmt(P.impulseInhibition)}｜损失厌恶 ${fmt(P.lossAversion)}｜耐心 ${fmt(P.patience)}`,
        `价值观：${result.values.join('、')}`,
        result.goals.length > 0 ? `长期目标：${result.goals.join('；')}` : '长期目标：（未设置）',
      ]
      return { ...result, text: lines.join('\n') }
    },
  }),

  define({
    name: 'cerebrum_state',
    description: '查看当前完整认知状态：人格、情绪、神经调质、记忆规模、核心概念与自我叙事计数。用于自检或向用户解释“我现在怎么想”。',
    parameters: json({}),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(_args, exec) {
      const state = service.state(sessionIdOf(exec))
      const affect = state.affect
      const traits = state.personality.traits
      const lines = [
        '## 认知状态',
        `**人格** ${state.personality.label}`,
        `开放性 ${traits.openness}｜尽责性 ${traits.conscientiousness}｜外向性 ${traits.extraversion}｜宜人性 ${traits.agreeableness}｜神经质 ${traits.neuroticism}`,
        '',
        `**情绪** ${affect.emotion.label}（${affect.emotion.intensity}）${affect.emotion.cause ? ` — ${affect.emotion.cause}` : ''}`,
        `效价 ${bar((affect.valence + 1) / 2)}｜唤醒 ${bar(affect.arousal)}｜支配 ${bar((affect.dominance + 1) / 2)}`,
        `心境 ${bar((affect.mood.valence + 1) / 2)}`,
        '',
        '**神经调质**',
        `DA  ${bar(state.neuromods.da)}`,
        `5-HT ${bar(state.neuromods.ser)}`,
        `NE  ${bar(state.neuromods.ne)}`,
        `ACh ${bar(state.neuromods.ach)}`,
        '',
        `**记忆** 情景 ${state.memory.episodes}｜概念 ${state.memory.concepts}｜关联 ${state.memory.edges}｜已巩固 ${state.memory.consolidated}｜schema ${state.memory.schema ?? 0}｜永久存储候选 ${state.memory.permastore ?? 0}｜常驻 ${state.memory.resident ?? 0}｜已遗忘 ${state.memory.forgotten ?? 0}｜巩固收据 ${state.memory.receipts ?? 0}`,
        `**保持** 平均稳定性 ${state.memory.avgStabilityDays ?? 0} 天｜被捕获 ${state.memory.tagged ?? 0}｜补全 ${state.memory.completions ?? 0}｜再巩固 ${state.memory.reconsolidations ?? 0}｜干扰 ${state.memory.interferences ?? 0}`,
        `**近期主题** ${state.concepts.map((c) => `${c.name}(${c.strength})`).join('、') || '（无）'}`,
        `**程序性记忆** ${state.skillCount ?? 0} 条规则${state.skills?.length ? `｜最新：${state.skills.at(-1).do.slice(0, 40)}` : ''}`,
        `**前瞻意图** 待办 ${state.intentions?.active ?? 0}${state.intentions?.matched?.length ? `｜本轮命中：${state.intentions.matched.map((m) => m.action).join('、')}` : ''}`,
        `**好感** ${state.affinity?.level ?? '初见'}（互动 ${state.affinity?.interactions ?? 0}，正性占比 ${Math.round((state.affinity?.positiveShare ?? 0.5) * 100)}%）`,
        state.workingMemory?.length
          ? `**工作记忆** ${state.workingMemory.map((slot, i) => `${'①②③④⑤⑥⑦⑧⑨'[i] ?? i + 1}${slot.summary.slice(0, 30)}`).join(' ｜ ')}`
          : '**工作记忆** （空）',
        `**当前事件** ${state.segmentation?.open ? `进行中（${state.segmentation.turns?.length ?? 0} 轮，尚未写入长期记忆）` : '无（已关闭）'}`,
        `**本轮记忆** 读 ${state.turnMemory?.read?.length ?? 0} · 写 ${state.turnMemory?.wrote?.length ?? 0}`,
        `**自我计数** 回合 ${state.self.counters.turns}｜工具 ${state.self.counters.tools}｜成功 ${state.self.counters.successes}｜失败 ${state.self.counters.failures}`,
      ]
      if (state.self.milestones.length > 0) {
        lines.push('', '**里程碑**')
        for (const milestone of state.self.milestones) lines.push(`- ${ago(milestone.at)}：${milestone.summary}（${milestone.emotion}）`)
      }
      return { ...state, text: lines.join('\n') }
    },
  }),
]

const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2)

export { sessionIdOf, bar }
