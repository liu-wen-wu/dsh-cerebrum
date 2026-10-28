# 开源记忆框架与认知架构调研 · 综合笔记（v4）

> 本轮目标：看看主流 Agent 记忆框架和经典认知/情感架构是怎么设计的，把真正值得抄的落进 dsh-cerebrum。三份明细：
> - [oss-memory-frameworks.md](./oss-memory-frameworks.md) — Mem0 / Letta / Zep+Graphiti / LangMem / Cognee / CrewAI / LlamaIndex / Generative Agents + 9 个高星 DSH 记忆插件
> - [oss-cognitive-architectures.md](./oss-cognitive-architectures.md) — ACT-R / SOAR / LIDA / HTM / OpenNARS / OpenCog / OCC / EMA / ALMA / GAMYGDALA / FAtiMA / PSI / BDI
> - `research/oss/*.md` — 6 个 DSH 插件 README 原文摘录（mnemon / ReMe / mneme / engramory / memento / project-brain）

---

## 一、三个反复出现、最值得抄的设计洞见

### 1. 「常驻 vs 按需」的分层，而不是一条向量库

MemGPT/Letta 的核心块（persona/human）永远在上下文里，archival 只在需要时搜；dsh-mnemon 的 Runtime / Project Documents / Memory Spaces 三层；ReMe 的 digest/personal 常驻 + BM25 按需。**结论：把"偏好/约定/图式"常驻、把"情节/知识"按需，是降 token 与降噪声的共同答案。** 我们此前每轮无差别注入 top-K，已改为 resident 常驻 + 情节记忆按置信阈值注入。

### 2. 词面 + 语义的混合检索，而不是纯向量

ReMe 用 BM25 + 可选向量 + **RRF 融合**；Zep 用余弦 + BM25 + 图距离重排；engramory 直接断言"在个人规模，一个 always-loaded 索引胜过向量搜索"。**结论：错误码、版本号、专名这类精确 token 必须走词面通道。** 我们已加 BM25 词面层，与 SDR 语义分共同进入激活。

### 3. 记忆是"会被整理、会被编辑"的活体，不是追加日志

Mem0 的 ADD/UPDATE/DELETE/NOOP 四态写入；Letta 的 self-editing + heartbeat；ReMe 的 auto_dream（创建/印证/修正 digest 节点）；mneme 的"空闲时分三层归档、越用越精炼"；memento 的"幂等条件写入 + 批准门"。**结论：写入要幂等去重，巩固要有增/改/删，且每次巩固要可追溯。** 我们已加重复写就地强化（NOOP 化）、再巩固、复习事件日志。

---

## 二、本轮已落地的升级（v4）

| 机制 | 出处 | 落点 |
|---|---|---|
| BM25 词面检索 + 语义融合 | ReMe / Zep / project-brain | `core/bm25.js`，`recall()` 加 `lex` 项与候选集 |
| 常驻层 vs 按需层 + 置信阈值 | Letta / mnemon / ReMe | `memory.resident()`、`prompt.residentMaxChars`、`prompt.recallThreshold` |
| 幂等写入（重复→就地强化） | Mem0 NOOP / memento / mnemon | `MemoryStore.findDuplicate()` + `service.remember()` |
| 轮内记忆溯源（读/写谁） | mnemon turn bar / memento「可见⟺落账」 | `state.turnMemory`，进入 `cerebrum_state` 与 prompt |
| 注意经济（STI + 收租） | OpenCog ECAN / NARS budget | 概念 `hot`：cue 使用→升温，巩固→衰减，进 seed |
| 提取时延 `F·e^−A` | ACT-R | `recall()` 返回 `parts.latency` |
| 单一胜者广播 | LIDA / GWT | prompt 只注入 top-1，其余折叠为计数 |
| 修复 `resolveConfig(home/cwd)` 被忽略的 bug | — | `config.js` 兼容 raw 键与 options 两种传法 |

**测试：44 项全过；`npm run check` 真实 Cordis 加载通过；真实 `~/.dsh` 未被测试污染（已清理）。**

---

## 三、建议路线图（按性价比排序，未实现）

1. **程序性记忆 / skills.json**（SOAR chunking + LangMem procedural + ReMe procedure 层）：`consolidate()` 对"结果一致 + 有共同前置"的 schema 簇产出 `{when:[概念], do:gist, successRate}` 规则；`cerebrum_recall` 命中时把"既有做法"作为可用方案注入。补上 DESIGN 路线图 #3。
2. **LLM importance 评分**（Generative Agents 1–10 评分）：把 `importance` 从正则启发式升级为可选 `ctx.llm` 评分（默认仍走启发式，离线可用）。
3. **forget/update 工具 + 四态写入**（Mem0）：`cerebrum_forget`（显式删除/失效）与 `cerebrum_update`（精确更新某条），配合现有 `reconsolidate` 完成增/改/删闭环。
4. **实体时序图 bi-temporal**（Zep/Graphiti）：实体→关系→时间戳，失效不删、可问"当时的结论是什么"；我们的 `edges` 已是有向+时间戳，缺"as-of 查询"。
5. **PAD 三维统一 + 目标效用情绪**（ALMA + GAMYGDALA）：把 emotion/mood/personality 放进同一 PAD 坐标（现只有 v/a，`d` 已存未用）；`self.goals` 带 `{utility,likelihood}`，事件算 `Δlikelihood×utility` 驱动效价。
6. **前瞻记忆 / intentions 意图栈**（BDI + Einstein & McDaniel）：`intentions.jsonl` + 关键词/时间触发，`intend()/reconsider()`。
7. **HTM 预测性 surprise**（Numenta）：用 TCM 上下文预测"下一活跃概念集"，`anomaly = 未预测/活跃`，替换纯余弦 surprise——让事件分割从"像不像旧事"升级为"预没预测到"。
8. **检索后端抽象 / Provider seam**（mnemon Source/Strategy/Provider、memento typed `ctx.memory` service）：把 MemoryStore 变成可替换后端，让本地文件与外部 provider 可切换。

---

## 四、结论

市面上的好设计高度收敛在三件事上：**分层注入（常驻/按需）、混合检索（词面/语义）、活体记忆（增改删 + 溯源 + 巩固）**。这三件我们这一轮已各落一块；程序性记忆、目标效用情绪、前瞻记忆是下一批最有价值的增量。

详细文献出处见上面两份明细文档；设计推导见 [DESIGN.zh.md](./DESIGN.zh.md)。
