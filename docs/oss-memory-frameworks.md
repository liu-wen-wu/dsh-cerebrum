# 开源 LLM-Agent 记忆框架技术备忘

面向 dsh-cerebrum 的增量调研。每条项目按「定位 / 存储 / 抽取写入 / 检索打分 / 巩固 / API / 最值得借鉴」七项记录，末附可复用模式清单与可落地改造建议。数据来自各仓库 main/master README 与官网（抓取于 2026-10）。

## 1. Mem0（mem0ai/mem0）

- **定位**：面向个性化 AI 的「抽取式事实记忆层」，把对话蒸馏成短事实并按需注入。
- **存储**：记忆=一句事实文本 + 元数据（user_id/agent_id/run_id/created_at/updated_at）；向量库（Qdrant/Chroma/PGVector…）+ 历史库（SQLite/Postgres）；图记忆存实体节点+关系边。
- **抽取/写入**：`memory.add(messages)` 用 LLM（默认 gpt-5-mini）抽事实。经典 v2 pipeline 把新事实与既有记忆对比，输出 **ADD/UPDATE/DELETE/NOOP** 四态：UPDATE 改写旧记忆、DELETE 删过时、NOOP 不写。记忆分 **user / assistant** 两类（谁说的）。v3（2026-04）改为 **single-pass ADD-only**（一次调用、只增不覆写）+ agent 确认的事实一等公民 + 实体链接。
- **检索/打分**：多信号融合 = 语义（embedding 余弦）+ BM25 关键词 + 实体匹配，并行打分后融合；v3 加**时间推理**（对「当前状态/过去事件/未来计划」分别给正确 dated 实例）。`search(query, filters, top_k)`。
- **巩固**：无离线 sleep；靠写入时的四态判定去重、更新、删旧来维持一致性。
- **API**：`add / search / get_all / delete / update / history`；CLI + REST + py/npm SDK。
- **借鉴**：写入即「分类一次」——把「这条新事实和已有记忆什么关系」做成一次 LLM 判定，从源头消灭重复与过时记忆；且每条记忆带 user/assistant 来源。

## 2. Letta / MemGPT（letta-ai/letta）

- **定位**：状态化 agent 框架，把 LLM 上下文当「主存」、外部存储当「磁盘」，虚拟上下文窗口管理。
- **存储**：**core memory blocks**（persona「我是谁」+ human「用户是谁」两块可编辑文本，常驻上下文）+ **recall memory**（会话历史，窗口内）+ **archival memory**（无界外部向量库，Qdrant/Chroma）；DB 存 agent 状态。
- **抽取/写入**：显式工具编辑——`core_memory_append/replace` 改 persona/human；`archival_insert` 写长期记忆（embedding 入库）；对话自动进 recall。**heartbeat**：agent 在无用户输入的 function-loop 里周期性自触发，把窗口内重要内容「自我编辑」进 core/archival。
- **检索/打分**：`archival_search`（embedding 语义 top-k）；`conversation_search`（日期范围 + 关键词过滤 recall）；recall 按 recency 排。
- **巩固**：上下文满时把旧对话「分页」——总结/搬移进 recall 或 archival，腾出主上下文；heartbeat 做无人值守自编辑。
- **API/工具面**：`core_memory_append/replace`、`archival_insert/search`、`conversation_search`、`send_message`（自发送触发 heartbeat）。
- **借鉴**：把「自我」显式拆成 persona/human 两块**可被 agent 自己编辑**的核心记忆块 + heartbeat 自编辑——没有用户消息也能自主整理记忆，这是 dsh-cerebrum 当前缺的「agent 可编辑自我画像 + 无人值守反思」。

## 3. Zep + Graphiti（getzep/zep）

- **定位**：Zep（CE→Cloud）是 agent 记忆平台；Graphiti 是其开源**时序知识图谱**框架，两者共享同一数据模型。
- **存储**：四类记忆、带 **memory type 字段**——**Message**（消息）/ **Summary**（滚动摘要）/ **Fact**（抽取事实）/ **Episode**（从图召回的情景）。Graphiti 存实体节点 + 关系边（三元组 Entity→Relationship→Entity），每条边即「事实」带 **validity window**（valid_at/valid_from/valid_to，双时态：recorded_at + 有效时段）。
- **抽取/写入**：摄取 episode（文本/JSON）→ LLM 抽实体+关系并 **dedupe nodes/edges**（可路由到 Jev / OpenAI Decisions 裁决）→ 事实变化时旧边 **invalidated（置 valid_to）而非删除**，保留时间历史。
- **检索/打分**：混合检索 = 语义 embedding + BM25 关键词 + **图遍历**，结果用**图距离（graph distance）重排**；可按时间/关系/语义三路查询。
- **巩固**：无离线 sleep；靠摄取时去重 + 事实失效（双向边+失效）+ 社区摘要维持一致性。
- **API**：Graphiti `add_episode / search / get_nodes / get_edges`；Zep Cloud SDK（zep-cloud）。
- **借鉴**：事实用「**双向边 + 有效窗口 + 失效不删**」建模，天然支持「现在是什么 / 过去是什么」双时态——dsh-cerebrum 的图边只有权重无时间无失效，回答不了「后来怎样了」。

## 4. LangMem（langchain-ai/langmem）

- **定位**：LangChain 记忆 SDK，让 agent 从交互中学习（抽取/巩固/prompt 优化）。
- **存储**：四类记忆 API——**procedural**（系统提示/怎么做）、**declarative**（用户画像/偏好）、**episodic**（过去经历）、**semantic**（事实知识）；底层任意 store（LangGraph BaseStore：InMemory/Postgres，带 embedding index + namespace）。
- **抽取/写入**：**热路径**（hot path）agent 用 `create_manage_memory_tool` / `create_search_memory_tool` 自己决定何时存/取；**后台** `create_memory_store_manager` 在对话后异步跑 reflection/consolidation 抽取并更新记忆。
- **检索/打分**：`create_search_memory_tool` 语义检索（embedding 相似），namespace 隔离。
- **巩固**：后台 manager 做 reflection（生成高层结论）+ consolidation（合并/更新）；**prompt 优化** `optimize_prompt` 用反馈改进系统提示。
- **API**：`create_manage_memory_tool`、`create_search_memory_tool`、`create_memory_store_manager`、`optimize_prompt`、核心 `store_memory/search_memory`。
- **借鉴**：**热路径工具 + 后台 manager 分离**——写路径既可由 agent 显式控制，也可后台无人值守巩固；并明确把「procedural 记忆」纳入记忆管理、支持 prompt 自优化。

## 5. Cognee（topoteretes/cognee）

- **定位**：开源 AI 记忆平台，把文档/代码/会话变成自托管知识图谱 + 向量，可完全本地零 API key。
- **存储**：实体节点 + 关系边 + 可检索 chunk（向量）；**DIKW 记忆分层**（data→information→knowledge→wisdom）；底层 Neo4j/NetworkX + 向量库 + 关系库（SQLite/Postgres）。
- **抽取/写入**：**ECL 流水线**——Extract（切 chunk + GLiNER 本地抽实体，可零 LLM）→ **Cognify**（LLM 派生语义/关系、分层记忆）→ Load（写图+向量）。`cognee.remember()/add()`。
- **检索/打分**：`recall()` 混合检索（图 + 向量 + 代码符号）；可按 ontology 自定义实体/边类型；会话蒸馏把「被接受的 lesson」写为永久记忆。
- **巩固**：**session distillation**（会话里被接受的教训提炼为持久知识）。
- **API**：`cognee.remember/recall/add/cognify/search`；CLI + MCP + 插件。
- **借鉴**：ECL 三段显式流水线 + DIKW 记忆分层，且实体抽取可纯本地（GLiNER 零 LLM）——dsh-cerebrum 的抽取是 SDR 词级，缺「实体级」结构。

## 6. CrewAI memory 与 LlamaIndex chat memory

- **定位**：框架内建的可开关记忆抽象，体现「多后端可插拔」取舍。
- **CrewAI 四类**：**short-term**（RAG 检索当前 run 上下文）、**long-term**（跨 run 持久，默认 SQLite 可换向量库）、**entity**（从消息抽实体存储）、**contextual**（多 agent 共享/传递的上下文，short-term 组合）；embedder 可配、逐类开关。
- **LlamaIndex 四后端**：`ChatMemoryBuffer`（窗口保留原始消息 + token_limit）、`ChatSummaryMemoryBuffer`（token_limit 内摘要）、`VectorMemory`（向量召回过去消息）、`KGMemory`（PropertyGraphIndex 实体+关系）；可 `SimpleComposableMemory` 组合，`FunctionCallingAgent` 默认带 memory 工具。
- **取舍**：buffer=无损但占窗口；summary=省但丢细节；vector=语义召回但无时序；KG=结构化但抽取贵。
- **抽取/写入**：同步随消息流写入；entity/KG 靠模型抽取。
- **检索/打分**：buffer=精确截窗；summary=生成式压缩；vector=embedding 相似；KG=图查询。
- **借鉴**：把记忆后端做成**同一接口可换**的抽象（buffer/summary/vector/KG），并显式声明取舍——dsh-cerebrum 只有一种 SDR+图后端，无 raw 历史与 summary 两种缓冲层。

## 7. Generative Agents（Park et al.，arXiv:2304.03442）

- **定位**：论文 + 复刻（joonspk-research/generative_agents、a16z-infra/companion-app），agent = memory stream + retrieval + reflection + plan。
- **存储**：**memory stream** = observation 列表（`{content, timestamp, recency, importance, last_access}`）；reflection 树（高层洞察 + 指向源记忆指针）；文件/JSON。
- **抽取/写入**：每条 observation 写入时用 **LLM 评 importance（1–10）**；reflection 周期触发。
- **检索/打分**：`score = recency × importance + recency × relevance`，其中 recency=指数衰减（0.995^hours）、importance∈[1,10]、relevance=query 与记忆的 embedding 余弦（clamp≥0）；取 top-k 拼进 prompt。companion-app `memory.py` 同名公式，`get_top_k_memories`。
- **巩固**：**reflection**——取最近 N 条生成 3 个 salient 问题→逐题检索相关记忆→LLM 生成高层 insight→评 importance→**插回 memory stream**（反思本身参与检索）；**plan**=每日 agenda。
- **API**：无标准 API；函数面 `retrieve/add_memory/generate_questions/generate_insights/score_memories_importance/construct_reflection`。
- **借鉴**：检索打分用**三因子乘积**且 importance 由 LLM 评（非规则）；reflection 把「更高层洞察」作为新条目**回灌同一检索池**——dsh-cerebrum 已有 base-level+spread+context+importance 加权，但 importance 是启发式、且巩固产出的 gist/schema 只挂在 concept 上、不作为可被 recall 的一等条目回灌。

## 8. DSH 记忆插件（dshopen category=memory，按 star）

### 8.1 dsh-mnemon（omdsh-dev，737★）
- **定位**：可组合、视图化的 DSH 记忆——Sources/Strategy/Core/View 四层 + 分层注入。
- **存储**：三类——**Runtime memory**（USER.md/MEMORY.md，每轮常驻注入）、**Project Documents**（Markdown 文档检索）、**Memory Spaces**（长期证据，Provider 可换 Mnemon Native/Mem0/Honcho/Holographic/RetainDB 等 8 家）；本地文件为主。
- **抽取/写入**：脑标记（brain mark）一键送 task Agent 去重、蒸馏后写入对应 Space；skills 自进化在后台复盘会话改 SKILL.md（backtest 后人工 Adopt）。
- **检索/打分**：resident（Runtime）每轮注入、其余 on-demand 检索；图按实体连接记忆。
- **DSH 集成**：`cordis.patch.yml` bundle 自动挂载；Plugins 页组合策略；侧栏 Memory System + 每轮 turn memory bar + `ctx.tools` recall；Provider 走 extension-sdk。
- **借鉴**：把记忆拆成「来源/策略/视图」可插拔 + **resident vs on-demand 分层注入**（偏好常驻、文档按需检索，控制每轮 token）。

### 8.2 灵枢 @furongjun1999/dsh-memory（FuRongJun-1999，499★）
- **定位**：确定性规则裁决（**零 LLM 判定**）的长期记忆本体，std::io MCP server 供多宿主挂载。
- **存储**：纯 Markdown 认知图（原文即真源，索引是派生）+ Rust 检索内核；五层 `self/anchor/structural/knowledge/contextual`。
- **抽取/写入**：`cg(op=write)` 过三道闸门 + `committed` 确认（绝不假装成功）；遗忘只能显式 `cg(op=forget)`；分层写闸（contextual 直写→self/anchor 需人工）。
- **检索/打分**：`mdcg_recall` 自动召回注入 + `cg(op=route)` 条件路由 + `stg(op=timeline)` 时间线；Rust 与 Python 口径逐位对拍。
- **DSH 集成**：`session/event` 自动记忆钩子 + 自动召回注入；`ctx.tools`（cg/stg/mdcg_*）；`personaPrefix` 注入纪律；可选 `ui/minimal` 左侧面板。
- **借鉴**：**写入三层闸门 + 确定性裁决可审计**——「记什么/取什么/能否写」全由规则而非 LLM 黑箱，写成功只看 `committed`。

### 8.3 dsh-engram（@kenz1117，40★）
- **定位**：记忆宫殿信息架构（位置当索引/固定路线/骨架复用/门牌唯一）的本地 SQLite 记忆。
- **存储**：双库 `user.db`（跟人走）+ `project-<hash>.db`（跟仓库走）；FTS5（中文 2-gram）+ 本地向量（Xenova MiniLM 384 维）+ 关系边一跳。
- **抽取/写入**：自动摄取（新一轮第一步抽上一轮）或 `engram_save`，写入**四态** accept/merge/defer/drop；实体词典消解；历史会话回填（幂等键续跑）。
- **检索/打分**：FTS5 + 向量 **RRF 融合** + 关系边一跳 + 新鲜度/命中次数乘性 boost；`engram_assess` 证据门（检索≠足以回答，代码强制 sufficient 三条件）；`engram_search` 支持 `room` 走廊路由 + `asOf` 时点回看。
- **巩固**：**SM-2 间隔重复**复习队列（只给坐标线索不给正文）；蒸馏（同主题簇合并 supersedes 取代链）；信念巩固 reflect（form/refine/still/refute，带证据 id）；衰减（低重要+久未访问归档）。
- **DSH 集成**：`sidebar.panellist` + `main` 槽位 client 面板；每轮注入画像（条数+token 双限）；project 库随会话 cwd 归属；协议标签防注入 + 入库脱敏。
- **借鉴**：**写入四态 + 证据门 + SM-2 复习**三件套最完整；分库「偏好跟人、约定跟仓库」直接对应 dsh-cerebrum 的 per-cwd store 但更细。

### 8.4 mneme（@modusensus/dsh-mneme，186★）
- **定位**：跨会话记忆 + 后台 autoDream 自整理，SQLite + Markdown 双向同步。
- **存储**：SQLite + 本地 Markdown 镜像（人工编辑优先，不被机器覆盖）；`~/.dsh/memory`。
- **抽取/写入**：会话自动蒸馏；**矛盾先冻结待裁决**（可疑冲突挂起，状态页并排对比一键裁决）；scope 按 agent/工作区隔离（strictScope 硬隔离）。
- **检索/打分**：BM25 + 向量 + 图谱混合 + 精排；作用域命中加权（他 scope 降权）。
- **巩固**：**autoDream**（空闲去重/合并/归档/修正/冲突冻结，留「决策凭证」输入快照+决策+结果哈希可回放）+ **Sleep Mode** 分层压缩+模式发现+关系补全；M.O. 把工作流搬进仓库（`.mneme/pipelines/<id>.json`）。
- **DSH 集成**：`session/event` 捕获、`turn/end` 触发 M.O. 挖掘、`agent/pre-step` 注入；独立 MCP 六件套 + `dsh-mneme-serve` daemon（8790）。
- **借鉴**：**冲突冻结待裁决 + 可回放决策凭证**（每次自动整理可复现、不默默吞错）——dsh-cerebrum 的再巩固是自动覆写，无「挂起等裁决」的安全带。

### 8.5 dsh-prime-memory（drscrewdriver，15★）
- **定位**：分层蒸馏记忆（移植 TencentDB Agent Memory）——L0 对话→L1 原子记忆→L2 场景→L3 画像。
- **存储**：SQLite + `conversations/ records/ scenes/` 目录 + `memory.db`。
- **抽取/写入**：后台逐层 LLM 抽取/去重/L2/L3；复用宿主 `ctx.llm`；成本看板按 provider/model 记 token。
- **检索/打分**：`agent/pre-step` 每步前注入相关记忆（**消息侧合成注入行**，用户可见）；**同会话去重**（已注入不再注，/compact 后重置）；时效加权 `相关度 × max(0.5, 0.5^(距上次更新天数/30))`。
- **巩固**：L2 场景整合 + L3 画像蒸馏，逐层精炼。
- **DSH 集成**：`session/event` 捕获、`agent/pre-step` 注入、`settings.register`、输入栏档位 pill、`dsh-memory/session-stats` 端点；工具 `memory_search/conversation_search/memory_read_scene`。
- **借鉴**：**L0–L3 分层 + 主动/被动双通道召回**（被动注入 78% + 模型主动查工具兜底），以及时效软加权（相关度高的老记忆不沉底）。

### 8.6 memory-eternal（EternalNight996，82★）
- **定位**：review-gated 的本地「第二大脑」，SQLite + Markdown vault，一库多 agent（DSH/Claude/Codex/Cursor 经 MCP）。
- **存储**：SQLite + Markdown；核心记忆（core）常驻注入 + 待审队列 + 回收站（30 天）。
- **抽取/写入**：**review-before-commit**——新卡片进 pending 队列，人工 approve 才入主库；agent 只能 propose 不能 approve 自己；每次变更写不可变审计日志（SQLite 层强制）。
- **检索/打分**：核心记忆每会话自动注入；知识图谱按 kind 聚类 + tag 边；token 账本记录 recall 命中/注入字符/有用性。
- **巩固**：core 晋升（approved 卡升为 always-on 核心）；token 账本量化「净收益 ≈ 避免的上下文成本 − 注入字符 − 蒸馏调用成本」。
- **DSH 集成**：侧栏 Memory panel（review/graph/config/ledger）、系统提示注入 core、`dsh plugin add memory-eternal`。
- **借鉴**：**review-before-commit + token 账本**——沉默全量写入迟早把错误当真相；账本让「记忆到底省没省 token」可测。

### 8.7 dsh-deja（vshulcz/deja-vu，1318★）
- **定位**：索引本地会话历史（JSONL/SQLite），**零 LLM 倒排索引**，单 Go 二进制跨 40+ agent。
- **存储**：本地倒排索引（`records.bin` + token buckets + manifest），`~/.cache/deja`；可选语义 sidecar（`.vectors.bin`）。
- **抽取/写入**：构建索引时脱敏（密钥/token 剥离）；增量索引（只读变更文件）；不生成新事实、只检索已有历史。
- **检索/打分**：纯词面检索 + 新鲜度重排；可选 embedding 语义（`deja embed` 指向 Ollama/OpenAI 端点）；MCP 单工具 `deja(mode)` 约 477 token 定义。
- **巩固**：`deja promote` 把会话蒸馏成带来源的 curated note（note 优先于原始 transcript）；`rules candidates` 归纳「用户更正过 agent」的回合供生成规则。
- **DSH 集成**：读 DSH 会话文件 + MCP 挂载 + session-start 自动召回 + 每会话 guidance/skill 注入。
- **借鉴**：把「**已有会话历史**」当记忆原料、零 LLM 倒排 + **会话开始即召回**（无人提问也能答）——dsh-cerebrum 只写自己的 episode，不读宿主已有的历史会话文件。

### 8.8 billion-context（ranxianglei，3063★）
- **定位**：上下文压缩代理（ACP），夹在 agent 与模型 API 之间重写流，模型驱动增量分层压缩。
- **存储**：分层 summary fold（可逆）；会话状态 `~/.local/share/billion-context/`；SQLite 引擎。
- **抽取/写入**：模型**自己决定**何时/什么压缩成高保真 summary（非硬截断）；`compress` 折叠消息区间为摘要、`decompress` 按需还原。
- **检索/打分**：`search_context` 对已压缩摘要+可见消息做关键词检索；`acp_status` 看可压缩区间。
- **巩固**：增量、可逆、**prefix-cache 友好**（小范围写摘要，缓存前缀不失效）；95–97% 前缀命中率目标。
- **DSH 集成**：`bili dsh`（--patch 全量原生插件）或 `dsh plugin add billion-context`；注入 compress 工具 + 压缩哲学。
- **借鉴**：把「压缩」做成**模型自驱动的可逆 fold**（summary + 按需解压 + 关键词搜索折叠区），而不是硬截断——对应 dsh-cerebrum 无会话历史压缩层。

### 8.9 @klarkxy/dsh-memory（klarkxy，13★）
- **定位**：小而聚焦的 per-scope 长期记忆（词汇/偏好/近期活动），Dream 后台整理。
- **存储**：按作用域（scope）组织，本地持久化。
- **抽取/写入**：会话中捕获词汇、偏好、近期活动；Dream 在空闲时把短期痕迹整理进长期记忆。
- **检索/打分**：按 scope 过滤注入。
- **DSH 集成**：标准 dsh-plugin cordis，按会话/作用域注入。
- **借鉴**：**Dream 命名**（把「睡眠整理」作为显式后台进程）+ per-scope 隔离的最小可用闭环（README 细节有限，仅列定位）。

## 可复用设计模式清单

1. **写入四态判定（ADD/UPDATE/DELETE/NOOP）**：新记忆先分类与既有记忆的关系，从源头去重/更新/删旧——Mem0。
2. **记忆来源分类（user/assistant/fact）**：每条记忆带「谁说的 + 类型」字段——Mem0、Zep type 字段。
3. **实体链接 + 图记忆**：记忆间经实体连接，检索时用实体匹配 boost——Mem0、Cognee。
4. **多信号融合检索（语义+BM25+图/实体）**：并行打分后 RRF/融合，抗单一信号盲区——Mem0、Graphiti、engram。
5. **核心记忆块 + 自我编辑**：persona/human 可被 agent 自己 append/replace——Letta。
6. **心跳/后台自编辑**：无用户消息也能周期反思并写回——Letta heartbeat、LangMem 后台 manager。
7. **主存/磁盘分层 + 上下文分页**：窗口满时旧内容总结搬移到外部存储——Letta。
8. **时序图 + 事实失效不删**：双向边 + validity window，支持双时态查询——Graphiti。
9. **图距离重排**：混合检索结果按图距离二次排序——Graphiti。
10. **热路径工具 + 后台 manager 分离**：写路径可显式可后台——LangMem。
11. **记忆四分类（procedural/declarative/episodic/semantic）**：把系统提示也当记忆管——LangMem。
12. **prompt 自优化**：反馈/更正反哺系统提示——LangMem optimize_prompt、mnemon skills 自进化。
13. **ECL 三段流水线 + DIKW 分层**：Extract→Cognify→Load 显式阶段化——Cognee。
14. **可插拔后端抽象（buffer/summary/vector/KG）**：同一接口换后端、明示取舍——LlamaIndex。
15. **三因子检索分（recency×importance×relevance）**：importance 用 LLM 评——Generative Agents。
16. **反思树回灌记忆流**：高层洞察作为新条目插回检索池参与排序——Generative Agents。
17. **写入四态 + 证据门 + SM-2 复习**：检索≠足以回答，代码强制证据门槛 + 间隔复习——dsh-engram。
18. **review-before-commit + token 账本**：人工/模型审核闸门 + 量化记忆净收益——memory-eternal、mneme 冲突冻结。
19. **零 LLM 倒排历史召回**：把已有会话历史当原料、会话开始即召回——deja。
20. **可逆上下文压缩 fold**：模型自驱动 summary + 按需解压——billion-context。

## 对 dsh-cerebrum 的可落地建议

1. `lib/core/memory.js::encodeEpisode` 前加 `classifyOperation()`（ADD/UPDATE/DELETE/NOOP）：新文本与现有近邻（复用 `similar` 计算）对比，update→`reconsolidate`、noop→不写、delete→软删。参照 Mem0/engram；当前只靠 `service._maybeReconsolidate` 事后修矛盾，无 no-op 抑制、无 delete。
2. `lib/tools.js` 新增 `cerebrum_forget`（软删）与 `cerebrum_update`（显式修正），`service.js` 加 `forget(id)/update(id, patch)` 并落 reviewLog 留痕。参照 Mem0 delete/update、engram_forget；当前工具面只有 recall/remember/consolidate，模型无法主动纠错。
3. `lib/service.js::_finishTurn` 的 importance 从纯规则改为「规则 + 可选 LLM 评分」：高信号回合（含 IMPORTANT/GOAL 或越过阈值）用 `ctx.llm` 评 1–10（参照 Park generate_importance_score），与规则分融合、失败静默回落。参照 Generative Agents；当前正则对「话少但重要」漏判。
4. `lib/core/memory.js` 加 `speaker`（user/assistant/tool）字段与 `kind:'fact'`，`recall(...,{speakers})` 过滤。参照 Mem0 user/assistant、Zep type 字段；当前 episode 无来源人维度。
5. `lib/core/memory.js` 在 concepts 之上加实体层：`entities.json` 存实体+别名，`edges.json` 扩展为 `{a,b,rel,validFrom,validTo}` 类型化时序边；编码时抽实体（复用 `selectConcepts` 多字 token 或 `ctx.llm`）。参照 Graphiti 双向边+失效、Mem0 entity linking；当前边只有权重无关系类型无时间。
6. `lib/core/memory.js::recall` 加词面通道：对 query 的 token 做精确/前缀命中（`encoder.topTokens` 已可得），与 SDR 语义分 RRF/线性融合（加 `config.memory.lexicalWeight`）。参照 Graphiti/Zep/engram hybrid；当前纯 SDR 对报错串、文件名、专名召回差。
7. `lib/service.js` 加 raw-history 摘要缓冲：`state` 里 ring buffer 存每回合原始 user/assistant（截断），超窗/`/compact` 时用 `ctx.llm` 折叠为分层 summary。参照 Letta recall 分页、billion-context fold；当前只有 episode 摘要，模型拿不到近期原始上下文。
8. `lib/service.js::consolidateIdle` 升级为 reflection：空闲且满足条件时用 `ctx.llm` 生成 3 个 salient 问题→`recall` 检索→生成 insight→作为新 `kind:'semantic'` 条目 `encodeEpisode` 回灌（带指向源 episode 的 `links`）。参照 LangMem 后台 manager、Park reflection；当前 consolidate 只聚类/schema，洞察挂 concept.gist 不参与 recall 排序。
9. `lib/tools.js` + `lib/prompt.js` 加 procedural 规则沉淀：从「用户更正/失败工具」回合抽一条「下次该怎么做」规则，写 `self.json` 的 rules 并在 prompt.js 动态段渲染。参照 LangMem procedural/optimize_prompt、mnemon skills 自进化；当前 prompt 静态段不变、学不到行为规则。
10. `lib/core/memory.js` 抽象检索后端：把 `recall` 内候选生成+打分抽成 `retrievers`（sdr/spread/lexical/entity）列表可配可开关。参照 LlamaIndex 可插拔后端；当前一种硬编码实现无法对比/替换。
11. `lib/service.js::remember` 与 `autoCapture` 加可选 review-gate：`config.autoCapture.reviewGate` 开启时显式/高重要度写入先入 `pending.json`，模型或人工 approve 后才 `encodeEpisode`。参照 memory-eternal、mneme 冲突冻结；当前全自动写入，错误事实无闸门。
12. `lib/tools.js::cerebrum_recall` 输出加 provenance：每条命中带 source 会话/轮次/时间（episode 已有 sessionId/turn/at），提示模型「这是历史记忆非当前事实」。参照 engram 三级溯源、Graphiti episode provenance；当前只输出 summary+时间，无来源可核。
13. `lib/core/memory.js::recall` 加 `{asOf}` 双时态 + `lib/tools.js` 加 `cerebrum_export`（Markdown/JSON 导出 episodes+concepts）。参照 Graphiti bi-temporal、engram asOf/export；当前 recall 只有「现在」视角、无导出可移植。
