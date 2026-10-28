# dsh-cerebrum：优化空间 × 替代/囊括矩阵

> 结论先行：cerebrum 能囊括的是「记忆大脑 + 人设内核 + 情感内核」这一层；替代不了的是「形象/外壳（动画、Live2D、桌面窗）」「原文底稿（memraw）」「外部服务后端（OpenViking/ReMe/MemSearch）」「上下文压缩（billion-context）」。宠物生态四层里，模型层要留给外壳插件，性格/记忆/情感三层 cerebrum 可以一肩挑。

## 一、还值得优化的点（按性价比排序）

### P0 —— 短期、改动小、收益直接（**已完成 ✅**：rawRefs 坐标、forget/update、人设三档作用域、巩固收据、隐私自查均落地，51 项测试 + 真实 Cordis 加载全绿；LLM importance 仍为可选，未做）

| # | 优化 | 依据/对标 | 现状 |
|---|---|---|---|
| 1 | **rawRefs 坐标**：episode 记录 `{sessionId, seq}` 指回原始事件，检索结果可回读原话 | dsh-memraw（`session#seq`） | ✅ episode.rawSeqs + 工具返回 rawRefs |
| 2 | **forget/update 工具**：显式删除/失效/精确更新某条记忆 | Mem0 四态、memento | ✅ cerebrum_forget（墓碑）+ cerebrum_update |
| 3 | **LLM importance 评分**（可选项）：用 `ctx.llm` 给事件打 1–10 分，无额度时退回正则启发式 | Generative Agents | ⏸ 暂缓（保持零依赖，需要时再接） |
| 4 | **人设三档作用域 + 免重启切换**：全局/工作区/会话 + 动态提示词段 | dsh-persona-dafeiyu | ✅ personas.json + _personaFor（会话>工作区>全局） |
| 5 | **巩固决策收据**：每次 consolidate 留 input 快照 + 决策 + hash，可复现可审计 | dsh-mneme | ✅ receipts.jsonl（sha256） |
| 6 | **隐私自查脚本**（扫密钥/绝对路径，CI 跑） | dsh-persona-dafeiyu | ✅ npm run privacy |

### P1 —— 中期、补上"大脑"的完整器官（**已完成 ✅**：程序性记忆 skills、前瞻记忆 intentions、概念 as-of 历史、GAMYGDALA 目标效用、好感度关系史；57 项测试 + 真实 Cordis 加载全绿）

| # | 优化 | 依据/对标 |
|---|---|---|
| 7 | **程序性记忆 skills.json**：consolidate 把"结果一致+共同前置"的 schema 簇沉淀成 `when→do` 规则，recall 时作为"既有做法"注入 | SOAR chunking、LangMem procedural、ReMe procedure 层 ✅ |
| 8 | **前瞻记忆 intentions**：`intend()/completeIntentions()`，触发词/截止时间命中进 prompt 提醒 | BDI、Einstein & McDaniel ✅ |
| 9 | **实体时序图（轻量）**：概念带 `history`，支持 `asOf(name, time)` 查"当时的结论" | Zep/Graphiti bi-temporal、mneme 实体层 ✅（属性抽取仍未做） |
| 10 | **GAMYGDALA 目标效用**：`desirability = Σ utility·Δlikelihood` 调制评价 | GAMYGDALA、目标监控（PFC-杏仁核） ✅ |
| 11 | **好感度 = 关系史**：情绪史积分 + 六档关系级别，不再是计数器 | @linxin666/dsh-pet（affinity）、whale-girl growth-system ✅ |
| 12 | **显式"情绪→措辞"层**：用 emotion.tendency（已存未用）驱动语气模板，接六种人设 | dsh-live2d-pets 六台词、EMA 行动倾向 |
| 13 | **效用学习**：judge 的选择结果回写效用，形成习惯 | ACT-R utility、SOAR RL |

### P2 —— 中长期、工程化

| # | 优化 | 依据/对标 |
|---|---|---|
| 14 | **Client 面板**：`settings.section` 显示大脑状态（情绪/调质/记忆图/常驻管理） | dsh-persona-dafeiyu 已探明的 4 个 slot；dsh-mnemon 的 turn memory bar | 🟡 **已做核心**：`conversation.input.dock` 大脑芯片 + 展开仪表盘（v7），宿主 127.0.0.1 只读 API；`settings.section` 完整管理页未做 |
| 15 | **typed `ctx.memory` 服务 + 审批门**：把 `ctx.get('cerebrum')` 升级为正式能力缝，写操作可走审批 | dsh-memento |
| 16 | **检索后端抽象**：MemoryStore → Provider 接口，本地文件之外可接外部后端 | dsh-mnemon Sources/Strategy、OpenViking/ReMe |
| 17 | **LLM 后台巩固管道**：空闲时用 `ctx.llm` 做 auto_dream 式摘要（比抽取式好一个量级），失败静默降级 | ReMe auto_dream、mneme autoDream |
| 18 | `/cerebrum` 命令 + 预算账本（每日注入 token 上限，超限自动降 recallK） | dsh-command-compact、memory-eternal token 账本 |
| 19 | **多语言 README + 市场元数据**（title/description zh+en、Logo、徽章） | 上架必备 |
| 20 | **会话历史回读**：索引旧 session 日志做召回（可选，与 deja 互补） | dsh-deja |
| 21 | 性能：recall 候选池上限、attractor 只跑 top-N、flush 频率自适应 | — |

## 二、替代/囊括矩阵

图例：🟢 已囊括 · 🟡 可囊括（需上面某项 P0/P1）· 🔴 替代不了（不该做）· 🔵 互补（应协作）

### DSH 记忆插件

| 插件 | 结论 | 说明 |
|---|---|---|
| @klarkxy/dsh-memory（Dream 后台整理） | 🟢 | NREM/REM + 空闲巩固已覆盖 |
| @furongjun1999/dsh-memory（Markdown 认知图） | 🟢 | 概念图+召回+反思已覆盖 |
| dsh-engram（SQLite 图+混合检索+四态） | 🟢 | 图+BM25+SDR+幂等写入已覆盖；SM-2 我们换成 FSRS 式幂律 |
| dsh-prime-memory（L0-L3 分层蒸馏） | 🟢 | 蒸馏/语义化已覆盖；缺主动/被动双通道注入（P2 #18 可补） |
| memory-eternal（知识卡+审核） | 🟢 | 知识卡≈语义记忆 |
| meow-memory（SQLite 分层+反思） | 🟢 | 分层+反思已覆盖，缺 SQLite/FTS 原文（可加，非必需） |
| dsh-mneme（实体+关系+Sleep Mode） | 🟡 | 记忆部分已覆盖；实体属性/时间轴（P1 #9）与决策收据（P0 #5）待补 |
| dsh-memento（SQLite+审批+快照注入） | 🟡 | 幂等写入已覆盖；审批门（P2 #15）与 snapshot 注入策略待补 |
| @restregular/dsh-memory（JSONL+BGE-M3 向量） | 🟡 | SDR 替代 embedding（零依赖但语义略弱）；可选真 embedding 后端（P2 #16） |
| dsh-deja（零 LLM 历史召回） | 🔵 | 我们不索引旧会话日志；互补（P2 #20）或直接联用 |
| **dsh-memraw（原文底稿）** | 🔵 | **定位互补**：它存底稿，我们存印象；rawRefs（P0 #1）把两边接起来 |
| billion-context（上下文压缩） | 🔵 | 压缩是另一个问题，不替代；可协作（压缩后我们补缺口摘要） |
| OpenViking / ReMe / MemSearch（外部服务） | 🔵 | 外部后端，作为 Provider 接入（P2 #16），不本地替代 |

### 框架级参照

| 框架 | 结论 | 差距 |
|---|---|---|
| Mem0 | 🟡 | 去重/分类/检索已覆盖；LLM 抽取式 pipeline（P0 #3、P2 #17）未做 |
| Letta/MemGPT | 🟡 | core blocks≈resident、archival≈episodic 已覆盖；自编辑 heartbeat（P2 #17）未做 |
| Zep/Graphiti | 🟡 | 四类记忆已覆盖三类；实体时序图（P1 #9）未做 |
| LangMem | 🟡 | 四类记忆已覆盖三类；procedural（P1 #7）未做 |
| Generative Agents | 🟡 | retrieval 三因子+reflection 已覆盖；LLM importance（P0 #3）未做 |
| Cognee | 🟡 | 知识图谱语义已覆盖；零 LLM 实体抽取（GLiNER）未做 |
| CrewAI / LlamaIndex | 🟢 | 同类抽象，我们的分层等价且更"脑" |

### 宠物/角色插件

| 插件 | 结论 | 说明 |
|---|---|---|
| dsh-pet / dsh-dafeiyu / pet-live2d / remielle / whale-girl / live2d-pets / token-pet | 🔴 | **外壳层，不替代**——cerebrum 正是它们缺的大脑；应做 PetBrain 适配层对接 |
| dsh-persona-dafeiyu | 🟡 | 人设内核可囊括（P0 #4 三档作用域+免重启）；UI 半边不替代 |
| dsh-soul | 🟡 | 人设+记忆规划可囊括；审批/回滚 UI（P2 #15）待补 |
| dsh-tavern | 🔵 | 角色卡/世界书是内容格式：可加"导入角色卡→初始化 personality/世界观"（P3） |
| Herta-dsh | 🔵 | 语音不替代；角色预设可囊括 |
| dsh-token-pet | 🔵 | 账本不替代 |

## 三、推荐路线图

```
P0（2–4 天）✅  P1（1–2 周）✅  P2 ⚡（dock 面板 + 只读 API 已做；settings 管理页/审批/Provider/LLM 巩固待做）
P3 ✅ 已全部完成：petbrain 翻译层 + /render-hints + /interact + **SillyTavern 角色卡导入**（JSON/PNG→Big Five，`cerebrum_character`）+ **桥接指南与示例**（[pet-bridge.md](./pet-bridge.md)、`npm run pet` / `npm run pet-hook`）
```

每完成一级，`npm test + npm run check + demo` 全绿后再进下一级；P0 完成后即可按 [publish.md](./publish.md) 上架。
