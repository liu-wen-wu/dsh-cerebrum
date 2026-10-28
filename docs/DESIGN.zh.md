# dsh-cerebrum：仿脑认知架构设计

> 目标：让 DSH 里的 Agent 拥有**可连续的自我**——会记住发生过什么、对经历有情绪色彩、有稳定的性格倾向，并能在决策时把"直觉"和"审慎"分开。本文说明每个脑结构对应哪个计算模块、用什么公式、为什么这样取舍，以及它在 DSH 里如何落地。

- 代码：`lib/`（零运行时依赖，纯 ESM）
- 工具：`cerebrum_recall / remember / judge / appraise / consolidate / profile / state`
- 存储：`$DSH_HOME/cerebrum/`（一个自我 + 按项目分的记忆库）
- 演示：`npm run demo`，图表数据写到 `examples/.demo/timeline.json`

> **v2 记忆与网络升级**：时序上下文（TCM）、CA3 吸引子补全、有向 STDP/BCM 关联、事件分割、4 槽工作记忆、NREM/REM 双阶段巩固、再巩固与提取诱发遗忘。§3、§4 已按 v2 重写；v1 的 SDR/ACT-R/扩散骨架保留。
>
> **v3 遗忘与持久记忆**：保留曲线由指数改为幂律 `R=(1+19/81·t/S)^−0.5`；稳定性 `S` 随"合意困难"增长（间隔/测试效应）；新增突触标记与捕获、倒摄干扰、知道感（FOK）、生动度；schema 记忆获得 permastore 稳定性下限。见 §3.5–§3.6。
>
> **v4 开源方案落位（仍以人脑原理为准）**：词面 BM25 + 语义融合；常驻层 vs 按需层（置信阈值）；幂等去重写入；轮内记忆溯源；概念注意经济（STI+收租）；ACT-R 提取时延；LIDA 单一胜者广播；**HTM 时序记忆（序列预测 → 预测性 surprise）**；**PAD 三维统一（人格=情感设定点，支配随可控性）**。调研与路线图见 [oss-survey.md](./oss-survey.md)。
>
> **v5（P0 批次）**：`rawRefs` 坐标（episode 指回 `session#seq` 原话）；`cerebrum_forget` / `cerebrum_update`（增改删闭环 + 遗忘墓碑审计）；人设三档作用域（会话 > 工作区 > 全局，免重启生效）；巩固决策收据（sha256 可复现）；隐私自查脚本。
>
> **v6（P1 批次）**：程序性记忆 skills（SOAR chunking：一致 schema → `when→do` 规则，子串匹配召回）；前瞻记忆 intentions（触发词/截止时间，命中即注入提醒）；概念 as-of 历史（bi-temporal，可问"当时的结论"）；目标效用情绪（GAMYGDALA：`desirability = Σ utility·Δlikelihood` 调制评价）；好感度 = 情绪史积分（六档关系级别）。
>
> **v7（P2 部分：GUI）**：宿主内置 127.0.0.1 只读 JSON API（`/ping /state /recall`，端口 18734 可配，不阻止进程退出）；同包内置 client bundle（免构建 `ModuleLoader` 协议），在输入框上方注册 `conversation.input.dock` 大脑芯片——情绪/记/好感一键展开成仪表盘（PAD 条、调质、五因素、记忆/技能/意图）。修改仍走工具，UI 只读。
>
> **v8（P3：宠物大脑接口）**：`core/petbrain.js` 翻译层——情绪×PAD×人格 → `{expression, animation, line, voicePitch}`（15 情绪映射 + 四人格语气 + 好感级别）；互动即评价（摸头/喂食/夸奖/批评 → appraisal）；API 新增 `/render-hints`（宠物外壳轮询）与 `/interact`（唯一允许的"写"，只动情绪）。`npm run pet` 演示完整接线：表扬→脸红"嘿嘿，被夸了"，批评→低落，冷落→心境回归发呆。
>
> **v9（P3 补全 + 角色卡）**：`core/charcard.js` 导入 SillyTavern 角色卡（JSON / PNG `chara` tEXt 块，零依赖手写 PNG 解析）→ 关键词词库映射 Big Five → 就近匹配四人格 → `first_meshal` 作声线；`cerebrum_character` 工具（import/apply/list），应用即换全局人设与身份。桥接指南 [pet-bridge.md](./pet-bridge.md)：dsh-pet 走 `ctx.pet.announce` 宿主契约或 `/api/pet/*`，dsh-dafeiyu 走提示词侧零 fork 集成；`npm run pet-hook` 演示 1 秒轮询真实数据形状。

---

## 1. 设计目标与边界

| 目标 | 做法 | 不做什么 |
|---|---|---|
| 跨会话记住事实、偏好、教训 | 情景记忆 + 语义概念 + 幂律遗忘 + 稳定性 | 不替代 DSH 的会话日志，也不压缩对话历史 |
| 检索要"像回忆"而不是"像搜库" | 线索→概念扩散→模式补全→竞争激活 | 不依赖外部 embedding API（离线可用） |
| 情绪要影响行为，而不只是文案 | 效价/唤醒、心境、四种神经调质驱动参数 | 不向用户表演情绪，不伪造感受 |
| 性格要稳定但可成长 | Big Five 基因组 + 极慢的行为漂移 | 不允许单轮对话改写人格 |
| 判断要可解释 | 双过程 + 前景理论 + 冲突监控 + 否决记录 | 不宣称是"正确"决策者，只提供结构化先验 |
| 失败要隔离 | 所有观测/写盘都有 try/catch，坏记忆不能弄挂一轮对话 | 不静默吞掉工具参数错误 |

**一个明确的取舍**：本实现不模拟膜电位与脉冲时序。真正的 LIF/STDP 仿真在 Agent 的时间尺度上没有信息增益，反而让"为什么想起这件事"变得不可解释。这里用**稀疏分布式表征 + k-WTA + 赫布可塑性 + 扩散激活**作为神经元的计算抽象，保留了模式分离、模式补全、联想学习三个真正有用的性质。

---

## 2. 脑结构 → 计算模块映射

| 脑结构 | 生物功能 | 本实现 | 代码 |
|---|---|---|---|
| 海马体（DG/CA3） | 一次性编码、模式分离/补全、情景索引 | 情景记忆、稀疏编码、线索补全、episode 间链接 | `core/memory.js`, `core/sdr.js` |
| 内嗅皮层 | 网格/位置细胞，情境锚点 | 会话/工作区/时间戳作为情境字段 | `MemoryStore.encodeEpisode` |
| 新皮层 | 慢速统计学习、图式 | 概念节点、gist、lessons、语义强度 | `concepts.json` |
| 前额叶（PFC） | 工作记忆、抑制、规划、元认知 | 双过程判断、计划深度、NoGo 否决 | `core/judge.js` |
| 前扣带回（ACC） | 冲突监控 | `conflict` 分数触发慢系统 | `core/judge.js` |
| 杏仁核 | 情绪显著性标记、威胁检测 | `salienceGain`、情绪标签、负性偏向 | `core/affect.js` |
| 基底节 | 动作选择、习惯、Go/NoGo | 方案评分与门控、冲动否决 | `core/judge.js` |
| 伏隔核/VTA | 奖赏预测误差 | 多巴胺更新、`outcome()` | `core/affect.js` |
| 蓝斑（LC） | 去甲肾上腺素、警觉/探索 | `ne`：意外不确定性 → 唤醒与探索 | `core/affect.js` |
| 中缝核 | 血清素、耐心、冲动控制 | `ser`：惩罚预测 → 抑制与损失厌恶 | `core/affect.js` |
| 默认模式网络 | 离线重放、自我叙事 | 空闲巩固、`self.json` 叙事与里程碑 | `service.js` |
| 丘脑 | 注意门控/路由 | 检索候选集与 prompt 预算 | `service.renderPromptState` |

---

## 3. 记忆系统

### 3.1 编码：一次经历如何变成记忆

一轮对话结束时（`turn/end`），服务把这一轮压成一条情景：

```
用户：<首句 220 字>   助手：<首句 260 字>   工具：pwsh✓(...)、read✗(...)
```

然后计算四个量：

| 量 | 公式/来源 | 作用 |
|---|---|---|
| `surprise` | `1 - max cos(code, 最近 40 条)` | 模式分离：越不像旧经历，编码越强 |
| `importance` | `0.22 + 0.12·len + 0.2·关键词 + 0.12·目标 + 0.1·工具数 + 0.12·错误 + 0.1·情绪信号` | 决定初始稳定性 S₀ 与保留优先级 |
| `salience` | `0.3 + 0.5·salienceGain·emotionIntensity + 0.2·surprise` | 杏仁核增益：情绪唤醒让记忆更难忘 |
| `strength` | `0.35 + 0.35·salience + 0.3·importance` | 初始痕迹强度 |

**稀疏编码**（`core/sdr.js`）：

1. 分词：英文/数字按词，中文按"单字（去停用词）+ 二元组"；
2. 每个 token 用 FNV-1a 生成 6 个稀疏地址，权重按词长加权；
3. 累加后做 **k-WTA**（默认 2048 维取 32 个），单位化 → 得到 `{idx, w}`。

同一段文本永远得到同一个编码，因此**记忆可以只存文本、重启后重建编码**；相似度用加权余弦，实测同义改写 > 无关文本（见 `test/cognition.test.mjs`）。

**赫布关联**：一条记忆内的概念两两加强边：

```
w ← w + η·(1 − w),   η = 0.05 + 0.12·importance
```

`(1−w)` 让权重饱和而不是无限增长；重要性门控相当于"值得记的事连接得更牢"。

### 3.2 存储：四种记忆

| 类型 | 载体 | 写入者 | 读取者 |
|---|---|---|---|
| 工作记忆 | `service.sessions` 的 turn 缓冲（用户/助手/工具） | `session/event` | 编码器、prompt 渲染 |
| 情景记忆 | `episodes.jsonl`（追加写，原子压缩） | 自动编码 + `cerebrum_remember` | `cerebrum_recall`、判断 |
| 语义记忆 | `concepts.json`（概念→强度/gist/lessons） | 巩固、重复共现 | prompt、判断、`cerebrum_state` |
| 程序性记忆 | 由 `edges.json` 的条件-动作共现近似（尚未独立建模） | 赫布更新 | 扩散激活 |

**一个自我，多套项目记忆。** 情绪、性格、自我叙事只有一份（`$DSH_HOME/cerebrum/<默认工作区>/`），而情景记忆按会话 `session.header.cwd` 分库：在 A 项目里学到的东西不会污染 B 项目的检索，但"我是谁"是连续的。若显式配置了 `dataDir`，则退回单库模式（便于测试与单项目部署）。

另有 `personality.json`、`affect.json`、`self.json`。所有写盘是 **tmp + rename** 原子替换；JSONL 读取会跳过被截断的最后一行。

目录：

```
$DSH_HOME/cerebrum/
  <默认工作区>/            # personality.json affect.json self.json + 默认记忆库
  <项目 A slug>/           # episodes.jsonl reviews.jsonl concepts.json edges.json
  <项目 B slug>/
```

`reviews.jsonl` 是复习事件日志：检索、失效、干扰、捕获、再巩固都追加一条 `{id,S,D,last,n,lapses}`，重启时重放。这样一次凌晨的检索不会因为重写 4000 条情景而丢失，也不会每次都重写大文件。

### 3.3 检索：线索如何"唤醒"记忆

不是向量 top-k，而是四步竞争：

**① 线索 → 概念激活**

```
seed(c) = conceptStrength(c) + 0.35
```

**② 沿**有向**关联图扩散**（3 步，每步 ×0.55，取 max；每个节点的出边再乘 fan 增益）：

```
a_{t+1}(n) = max(a_t(n), max_{m→n} a_t(m)·w(m→n)·0.55·fanGain(fanOut(m)))
fanGain(k) = 1 / (1 + 0.6·ln(1+k))
```

前向边（早→晚）比反向边（晚→早）学得更强，所以扩散天然偏向"接下来发生了什么"。

**③ CA3 模式补全**：把线索投进候选模式集合，按现代 Hopfield 更新式迭代 2 步：

```
ξ ← X·softmax(β·Xᵀξ),  β = 12,  然后 k-WTA
```

只有当候选 ≥2 且线索本身已有关联证据（`max cos ≥ 0.12`）时才启用——否则"补全"会退化成给唯一选项盖章。

**④ 候选竞争**，每条候选按 ACT-R 激活方程打分：

```
B_i = ln Σ_j (now − t_j)^(−d)          // d=0.5，t_j 为每次成功提取的时间
sim_i = 0.7·cos(cue, code_i) + 0.3·cos(ξ_completed, code_i)
Â_i = 1.1·norm(B_i) + 0.95·spread_i + 1.4·sim_i + 0.8·ctxMatch_i
      + 0.35·importance_i + 0.6·moodBias·(v_i·v_mood) + ε
P(recall) = σ((Â/3.2 − 0.58)/0.14)
```

- `norm(B) = clamp(1 + B/6)`：单次访问约 0.66，久远记忆快速下降；
- `ctxMatch_i = cos(c_t, context_i)`：**时序上下文**（TCM）匹配。上下文每轮漂移 `c_t = 0.8·c_{t-1} + 0.6·f_t`（ρ²+β²=1），检索成功后向被提取项复现——这就是"相邻事件一起回来"的连续性效应；
- `moodBias`：心境一致性检索；
- `ε ~ N(0, 0.04)`：由查询哈希播种，可复现但不死板。

**证据门槛**：上下文只是偏置，不是证据。候选必须满足 `cos(cue) ≥ 0.10` 或扩散 `≥ 0.12`，否则不进入排序——宁可回答"没有相关记忆"。

每次成功提取会**强化赢家**（`strength += 0.04`）、**抑制接近的竞争者**（`×0.96`，提取诱发遗忘），并把上下文拉向被检索的记忆（复现）。这就是间隔效应与连续效应的共同来源。

### 3.4 巩固：NREM + REM 双阶段

`cerebrum_consolidate` 或空闲定时器触发，分两个阶段：

**NREM（重放与语义化）**

1. **优先重放**：按 `priority = importance·(0.4+|v|)·1/(1+retrievals)·recency` 排序（need×gain 的代理，Mattar & Daw 2018），而不是按时间顺序；
2. **模型摘要优先**：接受 `{episodeIds, gist, lesson}`，直接写入概念节点（质量高于抽取式）；
3. **自动聚类**：统计概念频次，取 ≥`minCluster`（默认 3）聚成一簇，生成 gist；
4. **图式判定**：概念强度 > 0.7 且簇内结果**一致**（全部成功或全部失败）才标记 `schema`，并给成员 `strength += 0.1`——只看频率会给"高频但结论矛盾"的概念误发通行证；
5. **突触下调**：所有边 `w ×= 0.94`，`w < 0.02` 删除（Tononi & Cirelli 的突触稳态）。

**REM（联想与情绪脱钩）**

6. **松散联想**：在高强度概念间随机建立弱边（`w += 0.02`），模拟 REM 的远距离联想；
7. **情绪脱钩**：对 >1 天的负性记忆，`v ← v·(1−0.15)`、`a ← a·(1−0.075)`。"sleep to forget, sleep to remember"：内容保留，情绪电荷衰减（约 2 晚半衰）；
8. **突触缩放**：出度 ≥4 的概念把出边总和归一到 1（突触稳态），防止 hub 垄断。

### 3.5 遗忘曲线：幂律，而不是指数悬崖

v2 用指数衰减；v3 换成记忆心理学支持更好的**幂律保持函数**（Wixted & Ebbesen 1991；Anderson & Schooler 1991；Rubin & Wenzel 1996）：

```
R(t, S) = (1 + (19/81)·t/S)^(−0.5)        t 为距上次复习的天数
```

`S` 是**稳定性**（天），含义是"保有率降到 90% 所需的时间"。区别很关键：

| 模型 | 10 年后 | 形态 |
|---|---|---|
| 指数（同样 90% 起点） | ≈ 0% | 先平后断崖，最后归零 |
| 幂律 S=1 天 | 3.4% | 快速下降，长尾 |
| 幂律 S=90 天 | 30.8% | 缓慢下降 |
| 幂律 S=365 天（图式） | 54.7% | 近乎永久 |

**持久记忆**在这个模型里不是"不遗忘"，而是 `S` 足够大，长尾足够高。

`S` 不是常数，它随每次成功提取增长：

```
R_now = R(距上次复习, S)
S' = S · (1 + 1.2·(1−R_now)) · (1 + 0.4·(1−difficulty))
```

`(1−R)` 越大（提取越费劲、"合意困难"），`S` 增长越多——这是间隔效应与测试效应的共同数学形式。提取失败则：

```
S' = max(0.5, 0.4·S),  difficulty += 0.15
```

初始稳定性由重要性、情绪显著性与图式决定：`S₀ = 0.5 + 20·importance² + 8·salience + 4·|v|`（图式 ×3）。

**永久存储候选**：巩固判定为 schema 的情景获得 `S ≥ 180 天` 且 `S ×2`；这些记忆即使多年不复习也保留可检索的长尾。演示中 365 天后仍有 54.7% 的保有率。

**可用性门槛**：当 `R < 0.08` 时，只有强线索（语义相似 ≥0.22 或扩散 ≥0.3）才能召回；模糊提示取不回旧记忆——这正是编码特异性（Tulving & Thomson 1973）在检索侧的体现。

### 3.6 持久记忆的四个附加机制

**突触标记与捕获**（Frey & Morris 1997；Redondo & Morris 2011）：一个强事件（`salience ≥ 0.7`）会把 ±90 分钟内编码的弱记忆"捕获"进长期存储：

```
S_weak' = S_weak · (1 + 0.9·salience_strong·(1 − |Δt|/90min))
```

这解释了为什么一次事故会让当天所有细节都变得难忘。

**倒摄干扰**（Wixted 2004）：新编码与旧记忆相似（`cos > 0.55`）时，旧记忆 `S ×= 1 − 0.15·cos`；schema 记忆免疫。遗忘很大程度上不是"时间到了"，而是"被相似的新经验覆盖"。

**知道感**（Brown & McNeill 1966；Koriat 1993）：检索为空但线索有部分匹配时，不返回冷冰冰的"不知道"，而是给出 `feelingOfKnowing` 分数与"换关键词"的建议。

**生动度**（Brown & Kulik 1977；Talarico & Rubin 2003）：高唤醒 + 高意外的事件记录 `vividness`，检索时置信度更高，但工具会提示"主观生动 ≠ 客观准确"。

### 3.7 参数表（`lib/config.js`）

| 参数 | 默认 | 含义 |
|---|---|---|
| `memory.dim` / `sparsity` | 2048 / 32 | SDR 维度与活跃维数（含三元组顺序特征） |
| `memory.maxEpisodes` | 4000 | 容量上限 |
| `memory.baseLevelDecay` | 0.5 | ACT-R 衰减指数 |
| `memory.attractor.beta` / `iterations` | 12 / 2 | CA3 补全温度与步数 |
| `segmentation.maxTurns` | 4 | 一个事件最多合并的轮数 |
| `segmentation.gapMs` | 10 min | 超过即切分事件 |
| `segmentation.surpriseThreshold` | 0.72 | 预测误差触发事件边界 |
| `workingMemory.slots` | 4 | 工作记忆槽位（Cowan 4±1） |
| `consolidation.everyTurns` / `minCluster` | 12 / 3 | 自动巩固周期与聚类规模 |
| `prompt.recallK` / `maxChars` | 3 / 900 | 注入 prompt 的记忆条数与上限 |

### 3.8 事件分割、工作记忆与再巩固

**事件分割**（Event Segmentation Theory，Zacks et al. 2007）：不是每轮都写一条记忆，而是把连续工作压成一个"事件"。边界条件：

```
boundary = surprise ≥ 0.72
         ∨ gap ≥ 10 min
         ∨ 事件已含 ≥ 4 轮
         ∨ 本轮 importance ≥ 0.72
         ∨ 本轮出现工具错误
```

边界是"切换点"而不是"终点"：先关闭旧事件，再由这一轮开启新事件；失败/高利害的一轮单独成篇，避免教训被长事件平均掉。`surprise` 只看用户输入（助手的"好的，继续"不能掩盖话题切换），并与**尚未写入的当前事件**比较，否则每轮都会被判为新事件。

**工作记忆**（PFC，4±1 槽）：每轮压入 `{summary, code, at, importance}`，超出容量时淘汰分数最低者：

```
score = 0.6·exp(−Δt/30min) + 0.4·importance
```

它进入 prompt 的"工作记忆"一行，让模型知道"此刻手里握着哪四件事"。

**再巩固**（reconsolidation）：检索到的记忆如果与新经验冲突——结果相反（成功 vs 失败）或效价翻转超过 0.6——不另写一条，而是原地更新摘要、情绪与结果，`reconsolidations++`，并重新标记为未巩固。这避免了"同一件事有两条互相矛盾的记忆"。

**提取诱发遗忘**（RIF）：一次检索里与赢家激活接近（≥90%）的竞争者 `strength ×= 0.96`，只有赢家获得强化。竞争越激烈，记忆的选择性越强。

### 3.9 v4 增量：预测、注意与分层（脑机制）

**时序记忆与预测性 surprise**（HTM，Numenta）：概念之间存在转移概率 `P(next | context)`，形成一阶时序记忆。每轮用上一轮的概念集预测下一轮，`anomaly = 未预测到的活跃概念 / 活跃概念总数`：

```
surprise = 0.6·(1 − cos(本轮, 近40条)) + 0.4·anomaly
```

"像不像旧事"（反应式）与"预没预测到"（预测式）各占一半。一个话题延续时 anomaly 接近 0；话题突变时即便文字相似度尚可，anomaly 也会把 surprise 顶上去——这是事件分割从"相似度"升级为"预测误差"的关键。

**注意经济**（OpenCog ECAN / 丘脑注意）：概念带 `hot`（短时重要性 STI），被当作线索使用就升温，巩固（睡眠）时收租衰减。线索的 seed 强度 = `conceptStrength + 0.4·hot`，因此"刚提到过的概念更容易被再次激活"（启动效应）。

**常驻层 vs 按需层**（海马-新皮层分工的工程镜像）：偏好/约定/图式记忆（`resident`/`schema`）每轮注入；情节记忆只有当最佳命中置信度 ≥ `prompt.recallThreshold` 才注入，且只广播 top-1（LIDA 单一胜者），其余折叠为"次意识候选"计数。

**幂等写入**：`cerebrum_remember` 写入前查近重复（`cos > 0.82`），命中则就地强化（再巩固）而不是再写一条——防止"同一件事说三遍变成三条记忆"。

**轮内溯源**：`state.turnMemory` 记录本轮读/写了哪些记忆，进入 `cerebrum_state` 与 prompt，让"模型看到了什么、写了什么"可审计。

**坐标溯源（v5）**：每条情景记忆带 `rawSeqs`（本会话 `session#seq` 坐标），检索结果可据此回读原始事件（配合 memraw 或 DSH 会话日志回答"具体哪天哪句话"）。遗忘/更新同样留痕：`forgot.jsonl` 墓碑、`receipts.jsonl` 巩固收据（sha256，同样输入复现同样哈希）。

---

## 4. 神经元层：吸引子网络 + 迹 STDP

v1 只用 SDR，v2 增加了两个真正的网络动力学组件：

### 4.1 CA3 补全网络（现代 Hopfield）

```
ξ_{t+1} = k-WTA( X · softmax(β·Xᵀξ_t) )
```

- `X` 是候选情景的稀疏编码矩阵，`β=12`，迭代 2 步；
- 与 transformer attention 同构（Ramsauer et al. 2021），但在稀疏码上只需 `O(M·k)`；
- 能量 `E(ξ) = −(1/β)·ln Σ exp(β·xᵢᵀξ)` 可用来判断线索落进了哪个吸引域；
- 只有"候选 ≥2 且线索已有部分匹配"才启用，防止对唯一候选自我确认。

### 4.2 迹 STDP + BCM 可塑性

边不是静态共现计数，而是突触：

```
w ← w + η·[post·(post − θ_M) + 0.12]·(1 − w)      // BCM，带饱和
θ_M ← θ_M + (post² − θ_M)/τ_θ                      // 滑动阈值，τ_θ≈20
w(a→b) += stdp(Δt),  stdp(Δt) = A₊·e^(−Δt/τ) (Δt>0)，否则 −A₋·e^(Δt/τ)
```

- `Δt` 是相邻两个事件的间隔（分钟），`τ=45min`：先后发生的概念形成**前向**关联，乱序则抑郁；
- 同一事件内的概念按顺序配对，早→晚的权重是晚→早的约 3 倍；
- 出度大的概念在扩散时乘 `fanGain`，并在巩固时做突触缩放（总和归一到 1），防止 hub 垄断。

### 4.3 为什么生产路径仍不用 LIF

| 需求 | LIF 仿真 | 本实现 |
|---|---|---|
| 模式分离 | 需要精细调参 | 高维稀疏 + k-WTA |
| 模式补全 | 吸引子动力学 | 现代 Hopfield 补全（同构） |
| 联想学习 | STDP 窗口 | 迹 STDP + BCM（同构，时间单位换成轮/分钟） |
| 可解释性 | 差（脉冲串） | 好（激活值、贡献分解） |
| 成本 | 每 token 数千次积分 | 每条记忆 32 个整数 |

`SpikingAssembly`（LIF + 侧抑制 + STDP）作为诊断/教学模型保留在 `core/assembly.js`，测试证明它能从 50% 线索补全训练过的细胞集群；生产检索走上面的速率编码版本。

---

## 5. 情绪系统

### 5.1 三段时间尺度

```
事件 → 评价（毫秒） → 情绪（秒~分） → 心境（小时） → 性格（月）
```

### 5.2 评价维度（Scherer SEC + OCC）

| 维度 | 含义 | 来源 |
|---|---|---|
| relevance | 与目标的相关性 | 文本长度、目标词、工具数 |
| congruence | 与目标一致（−1..1） | 成败、用户情绪、完成措辞 |
| novelty | 新颖/意外 | 1 − 与近期记忆的最大相似度 |
| certainty | 确定性 | 错误数、风险词 |
| agency | 自因/他因 | 用户称赞→他因 |
| control | 应对能力 | 错误数 |
| norm | 规范一致性 | 预留（自我/社会标准） |
| urgency | 紧迫性 | 截止词、风险词 |
| magnitude | 后果量级 | 工具数、错误、重要词 |

### 5.3 情绪 = 评价空间中的最近原型

15 个情绪原型（喜悦、满足、好奇、期待、自豪、感激、如释重负、恐惧、焦虑、愤怒、内疚、羞愧、失落、挫败、平静），每个有评价向量与核心情感质心。选择用带温度的 softmax：

```
d_i = sqrt( Σ_dim w_dim·(â_dim − p_i,dim)² / Σ w_dim )
P(i) = softmax(−d_i / 0.13)
intensity = activation·(0.45 + 0.55·P(best))
```

若 `P(best) < 0.09` 或 `d > 0.42`，回落到"平静"——**没有明确情绪时不要编一个**。

核心情感（PAD 三维：效价/唤醒/**支配**）取原型加权质心，按强度增益更新；支配由可控性决定 `d = 2·control − 1`：

```
v ← v + (Σ P_i·v_i − v)·(0.25 + 0.55·intensity)
a ← a + (Σ P_i·a_i − a)·(0.25 + 0.55·intensity)
d ← d + ((2·control − 1) − d)·(0.25 + 0.55·intensity)
```

PAD 让情绪、心境、性格落在同一坐标：人格经 Mehrabian 回归给出 PAD 设定点（见 §6），心境向其回归，情绪围绕它波动——这是 ALMA 三层的数学统一。

### 5.4 心境与神经调质

心境是慢积分，并向性格设定点回归（τ≈40 min）：

```
mood ← mood + (v − mood)·(0.06 + 0.18·intensity)
mood ← mood + (baseline − mood)·(1 − e^(−Δt/40min))
```

四种调质（0..1，基线 DA .5 / 5-HT .55 / NE .35 / ACh .4），更新都按"剩余空间"缩放，避免一次事件把状态钉死：

| 调质 | 触发 | 半衰期 | 行为后果 |
|---|---|---|---|
| DA 多巴胺 | 正 RPE `congruence·relevance·magnitude` | 8 min | `exploration↑`、努力↑ |
| 5-HT 血清素 | 负 RPE、失败 | 45 min | `inhibition↑`、`lossAversion↓`（更有耐心） |
| NE 去甲肾上腺素 | 新颖、紧迫、失败 | 12 min | `arousal↑`、探索↑、警觉↑ |
| ACh 乙酰胆碱 | 确定性低（`certainty<0.45`） | 20 min | `learningRate↑`、注意↑ |

派生增益：

```
salienceGain = clamp(0.5 + 0.9·arousal·threatSensitivity + 0.4·|v|)
lossAversion = base·(1 + 0.45·(1−ser))·(1 + 0.25·ne)
exploration  = base·(0.55 + 0.9·da)·(0.7 + 0.6·ne)
inhibition   = base·(0.6 + 0.7·ser)·(1 − 0.25·arousal)
```

这对应 Doya(2002) 的元学习映射与 Boureau & Dayan(2011) 的 DA/5-HT 对抗：**不是"快乐值"，而是四个影响学习率、探索、耐心、警觉的控制信号**。

---

## 6. 性格系统

### 6.1 Big Five 作为"基因组"

四个预设：

| 预设 | O | C | E | A | N | 适合 |
|---|---|---|---|---|---|---|
| 好奇的工程师 `curious-engineer` | .78 | .74 | .42 | .66 | .38 | 默认，工程/研究 |
| 克制的守门人 `stoic-guardian` | .45 | .88 | .35 | .72 | .22 | 高风险运维 |
| 温和的同伴 `warm-companion` | .62 | .55 | .82 | .88 | .45 | 陪伴/客服 |
| 不安分的创作者 `restless-artist` | .92 | .30 | .70 | .50 | .70 | 创意探索 |

### 6.2 特质 → 决策参数（这是性格真正起作用的地方）

| 派生参数 | 公式 | 作用点 |
|---|---|---|
| 探索率 | `0.15 + 0.55·O + 0.1·E − 0.1·N` | 判断：是否考虑非常规方案 |
| 计划深度 | `round(1 + 3·C)` → 1..4 | 判断：是否强制慢系统 |
| 冲动抑制 | `0.25 + 0.5·C + 0.15·(1−N) + 0.1·(1−E)` | NoGo 门控 |
| 损失厌恶 | `1.4 + 1.6·N − 0.35·O` | 前景理论 λ |
| 威胁敏感 | `0.2 + 0.8·N` | 杏仁核增益 |
| 社会温暖 | `0.15 + 0.55·E + 0.4·A` | 措辞与配合 |
| 从众/规范 | `0.2 + 0.6·A` | 规范惩罚权重 |
| 耐心 | `0.3 + 0.5·C + 0.2·(1−N)` | 与 5-HT 相乘 |

### 6.3 稳定性

- 每轮结束后按表达行为做**极慢漂移**：`η = 0.001`，且被限制在基因组 ±0.08 内；
- 单轮对话不会改变人格，只有长期行为模式才会；
- 用户可通过 `cerebrum_profile` 显式设定（会同时移动基因组）。

---

## 7. 判断系统

### 7.1 双过程

```
线索 → 记忆证据 → 躯体标记（S1） → 是否冲突/高风险/证据不足？
                                   ├─ 否 → S1 直接给建议
                                   └─ 是 → S2：期望值 / 风险 / 可逆性 / 努力 / 规范
```

- **S1**：证据的效价加权平均 `gut = Σ p_i·v_i / Σ p_i`，对应 Damasio 的躯体标记假说；
- **冲突**：`0.55·(1 − tanh(margin/0.35)) + 0.45·[直觉与最优解不一致]`；
- **S2 触发**：冲突 > 0.45、stakes=high、证据强度 < 0.18、或计划深度 ≥ 3。

### 7.2 方案评分（前景理论 + 成本）

```
p = clamp(0.5 + 0.32·evidenceValence + 0.18·(outcomeRate−0.5)·2)
v(x) = x^0.88                     (x ≥ 0)
v(x) = −λ·|x|^0.88                (x < 0)
EV = p·v(gain) + (1−p)·v(−loss)
risk = p(1−p)(|v(gain)| + |v(−loss)|)·riskScale
score = EV − 0.55·κ·risk − 0.22·effort − normPenalty·(0.55+0.45·conformity) − (可逆?0:0.12)
```

`riskScale` 识别"灰度/试点"（×0.62）、"直接/全量"（×1.22）；`λ` 由性格 + 5-HT 共同决定。

### 7.3 冲动否决（NoGo）

若某方案带"立刻/马上/直接"等冲动标记，且（抑制压力 > 0.45 或 不可逆/触规范）且 `inhibition > 0.4`：

- 记录 `S1-vetoed`，从可选项中剔除该方案，选次优；
- 理由写入 `reasons`，**否决必须有记录**，不做无声改写。

### 7.4 输出

```json
{
  "system": "S2",
  "choice": "先灰度 10% 观察一小时",
  "confidence": 0.42,
  "gut": {"value": -0.8, "leaning": "回避"},
  "conflict": 0.55,
  "options": [{"option": "...", "score": -1.30, "expectedValue": -0.90, "risk": 0.49, "probability": 0.5, "reversible": true}],
  "reasons": ["..."],
  "evidence": [{"summary": "...", "probability": 0.73}],
  "checklist": ["基准率：...", "可逆性：...", "最坏情况：..."]
}
```

`checklist` 是给模型继续推理用的，不是装饰。

---

## 8. 与 DSH 的集成

### 8.1 事件流

```
session/event(user/message)      → 记录"用户要什么"
session/event(tool/call)         → 记录"做了什么"（忽略 cerebrum_*）
session/event(tool/result)       → 立即的情绪结果信号（失败 → 5-HT/NE↑）
session/event(assistant/message) → 记录"说了什么"
session/event(turn/end)          → 评价 → 编码 → 自我计数 → 可能巩固
```

所有处理在 `try/catch` 内：**记忆系统故障不允许弄挂对话**。

### 8.2 Prompt：静态段 + 动态快照

- `systemPrompt.section`（order 90）：**静态**认知契约（怎么用工具、不要伪造记忆），不破坏 KV cache 前缀；
- `systemPrompt.context`（order 120）：**动态**状态卡（情绪、调质、相关记忆、决策倾向），DSH 会把它作为 runtime-context 快照追加在历史之后，因此状态变化不会重写系统提示词。

状态卡示例：

```markdown
### 认知状态
- 人格：好奇的工程师：好奇、乐于探索；有条理、重承诺；…
- 情绪：如释重负（强度 0.30）· 效价 0.21 · 唤醒 0.35 · 心境偏正
- 神经调质：DA 0.59｜5-HT 0.55｜NE 0.46｜ACh 0.40（影响探索、耐心、警觉与学习率）
- 价值排序：正确、可验证、简洁、尊重用户自主
- 工作记忆（2/4）：①部署前先迁移演练 ｜ ②对比度回归测试
- 相关记忆（供参考，不必复述）：
  · 3 分钟前｜部署脚本迁移失败并回滚（负向，置信 0.73）
- 当前决策倾向：谨慎 0.48 · 探索 0.72 · 冲动抑制 0.79 · 损失厌恶 0.61
```

### 8.3 工具

| 工具 | 何时用 | 副作用 |
|---|---|---|
| `cerebrum_recall` | 需要过去约定/偏好/教训 | 强化被提取记忆 |
| `cerebrum_remember` | 用户要求记住、重要结论 | 写入情景 |
| `cerebrum_judge` | 多方案权衡、高风险动作前 | 无（只读记忆与状态） |
| `cerebrum_appraise` | 任务成败、用户强烈反馈后 | 更新情绪/调质 |
| `cerebrum_consolidate` | 告一段落、需要提炼规律 | 语义化 + 突触下调 |
| `cerebrum_profile` | 查看/修改性格与价值观 | 持久化人格 |
| `cerebrum_state` | 自检、向用户解释 | 无 |

### 8.4 安装

```powershell
# 本地目录安装到 desktop profile（重启客户端后生效）
dsh plugin --profile desktop add D:\workspace\dsh-cerebrum
```

或手工：把包链接进 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-cerebrum`，并在 profile 的 `package.json` → `dsh.profile.bundles` 追加 `dsh-cerebrum`。`cordis.patch.yml` 已提供 `insert` 行。

### 8.5 配置

优先级：默认值 < `$DSH_HOME/cerebrum/config.json` < 行配置。

```json
{
  "personality": { "preset": "stoic-guardian" },
  "prompt": { "recallK": 4, "maxChars": 1200 },
  "autoCapture": { "enabled": true }
}
```

---

## 9. 工程约束

| 约束 | 措施 |
|---|---|
| Token 预算 | 静态段约 120 字；状态卡默认 ≤900 字符；记忆只给摘要 |
| KV cache | 动态内容走 runtime context，不写系统提示词 |
| 性能 | 2048 维 SDR、候选集上限（线索概念 ∪ 最近 120 ∪ 重要 60）；单次检索 O(候选×32) |
| 隐私 | 只存本地；`dataDir` 可按工作区隔离；可随时删除目录 |
| 失败隔离 | 事件处理、prompt 渲染、写盘全部 try/catch |
| 可复现 | 编码确定性；检索噪声用查询哈希播种 |
| 可测试 | 纯函数模块 + 假 ctx 集成测试（14 个测试，含工作区隔离） |

---

## 10. 评估方案

**工程验证（已通过）**

- `npm test`：57 项（SDR 顺序敏感、检索排序、ACT-R 单调性、CA3 补全、TCM 单位范数与消歧、STDP 符号、RIF 三候选、幂律保持/90% 区间、间隔效应、遗忘曲线长尾、标记捕获、倒摄干扰、schema permastore、知道感、复习日志重启恢复、词面+语义混合检索、幂等去重、常驻/按需分层、轮内溯源、注意经济、提取时延、单一胜者广播、时序记忆预测、PAD 支配、rawRefs 坐标、forget/update、人设三档作用域、巩固收据、程序性记忆 chunking、前瞻记忆触发、as-of 历史、目标效用、好感度、巩固/schema、REM 脱钩、再巩固、事件分割、工作记忆、持久化、情绪方向、调质回归、性格映射、双过程、插件装配、工作区隔离）。
- `npm run check`：从安装包提取的 **Cordis 4.0.5** 容器中真实加载插件——`ctx.plugin()` 启动、7 个工具注册、section(90)/context(120) 注册、`session/event` 投递、一轮对话落盘并可召回。这一步覆盖了"假 ctx 测试"无法证明的容器契约。

**离线指标（`npm run demo`）**

- 检索命中率：手工构造「相关/无关」对，检查排序（已有断言）；
- 情绪合理性：给定成败与用户反馈，检查效价方向与情绪标签（已有断言）；
- 判断一致性：高风险题必须进 S2，不可逆冲动必须被否决（已有断言）；
- 巩固收益：巩固前后 `概念数/情景数` 比值、重复概念压缩率。

**在线（建议接入）**：

| 指标 | 定义 | 期望 |
|---|---|---|
| 记忆复用率 | 被 `cerebrum_recall` 命中且随后被引用的比例 | 上升 |
| 冗余注入 | 状态卡中与当前问题无关的记忆占比 | < 20% |
| 情绪-事件一致率 | 人工标注 50 轮，情绪标签与标注一致 | > 70% |
| 判断校准 | `confidence` 与实际结果的分箱校准误差（ECE） | 下降 |
| 成本 | 每轮额外 token 与延迟 | < 300 token / < 20ms |

**消融**：关闭情绪（固定中性）、关闭性格（固定 0.5）、关闭扩散（只留余弦）、关闭巩固，比较上述指标。

---

## 11. 已知局限与路线图

1. **没有语义 embedding**：SDR 对同义改写与词序有效，但对"换一种说法且无共同词"会漏。路线：可选接入本地嵌入模型，`MemoryStore` 的 `code` 字段已抽象。
2. **自动巩固是抽取式的**：gist 质量一般；高质量路径是模型调用 `cerebrum_consolidate` 自带摘要。路线：空闲时用 `ctx.llm` 生成摘要（需额度与延迟预算）。
3. **程序性记忆未独立建模**：目前用概念共现与 STDP 前向边近似"条件-动作"。路线：`skills.json` + 成功率/触发条件，接入判断的 `habit` 项。
4. **事件分割的阈值是启发式**：`surprise` 用 SDR 相似度而非模型的预测误差，跨语言改写会误判边界。路线：用 `ctx.llm` 的下一 token 概率或显式主题模型替代。
5. **没有 client UI**：状态通过 `cerebrum_state` 的 ASCII 仪表与 `examples/dashboard.html` 呈现。路线：注册 `settings.section` 或 `conversation.input.dock`，实时显示效价/唤醒与记忆图。
6. **子 Agent 记忆共用父工作区**：子 Agent 的会话 cwd 与父级相同，因此会写进同一个项目库。路线：按 `agent.id` 或 `delegationDepth` 分区，或给 episode 加 `scope` 字段。
7. **情绪标签仍是离散原型**：连续维度 + 建构情绪观只体现在心境与检索偏置上。路线：用维度向量直接驱动措辞而不是先分类。
8. **LIF 只用于诊断**：生产路径是速率编码的吸引子与迹 STDP；真正的脉冲时序（theta 相位、尖峰时序依赖的序列记忆）未进入检索热路径。
9. **前瞻记忆未实现**："以后提醒我做 X"目前只能写成显式记忆靠检索带出，没有事件型/时间型线索的主动触发。路线：`intentions.jsonl` + 每轮关键词/时间匹配，在 prompt 中作为待办提醒注入。
10. **幂律模型的参数尚未按真实使用数据拟合**：`S₀`、`(1−R)` 增益、90 分钟捕获窗口来自文献与工程判断；接入真实 Agent 日志后应做一次拟合（FSRS 的 w 参数即由此而来）。

---

## 12. 参考文献

完整书目、可核验链接与 18 组公式见 [`research-notes.md`](./research-notes.md)（59 条文献，● 为实测 HTTP 200，○ 为 DOI 经 Crossref 核验）；v2 机制的公式、参数与"当前实现差距"见 [`research-v2.md`](./research-v2.md)；v3 的遗忘曲线、持久记忆、间隔/测试效应、干扰与知道感见 [`research-memory-v3.md`](./research-memory-v3.md)。

实现与文献的对应关系：

| 实现模块 | 主要依据 |
|---|---|
| `core/sdr.js` 稀疏编码 / k-WTA / 三元组顺序 | [C3] 模式分离、[B9] 稀疏表示 |
| `core/assembly.js` CA3 补全 | 现代 Hopfield（Ramsauer et al. 2021）、[B1][B2] 吸引子与 SDM |
| `core/plasticity.js` TCM / STDP / BCM / RIF / 重放优先级 | [TCM] Howard & Kahana 2002、Sederberg et al. 2008；[STDP] Bi & Poo 1998、Pfister & Gerstner 2006；[BCM] Bienenstock et al. 1982；[RIF] Anderson et al. 1994；[REPLAY] Mattar & Daw 2018 |
| `core/memory.js` 情景库 / 重放 / 巩固 / 再巩固 | [C1][C2] CLS、[C4][C5] 睡眠重放、[C7] 重放优先级、REM 情绪脱钩（van der Helm & Walker 2011）、schema（Tse et al. 2007） |
| `core/memory.js` ACT-R 激活 / 扩散 / fan | [B7][B8] ACT-R |
| `core/retention.js` 遗忘曲线 / 稳定性 / 捕获 / 干扰 | 幂律保持（Wixted & Ebbesen 1991；Anderson & Schooler 1991）、FSRS/DSTM（Settles & Meeder 2016；Mozer & Lindsey 2016）、间隔与测试效应（Cepeda 2006；Roediger & Karpicke 2006）、突触标记（Frey & Morris 1997）、干扰（Wixted 2004）、FOK（Koriat 1993） |
| `service.js` 事件分割 / 工作记忆 | 事件分割理论（Zacks et al. 2007、Radvansky & Zacks 2017）、Cowan 2001（4±1） |
| `core/affect.js` 评价与调质 | [N1][N3][N4][N5][N6] DA/5-HT/NE/ACh、[E1][E2] OCC/Scherer、[E3] Russell |
| `core/personality.js` | [P2] 五因素、[P4] 控制论 Big Five |
| `core/judge.js` 双过程 / 冲突 / NoGo | [J1] 模型基/无模型、[J2] PFC 控制、[J3] ACC、[J4] 基底节门控、[J5] 前额叶-基底节工作记忆 |
| 整体记忆范式参照 | [G1] Generative Agents、[G2] MemGPT、[G3] HippoRAG、[G4] A-MEM |

经典来源：

- McClelland, McNaughton & O'Reilly (1995) *Complementary Learning Systems*；Kumaran, Hassabis & McClelland (2016) 更新版
- Anderson et al. *ACT-R*：声明性记忆激活方程（base-level + spreading）
- Hopfield (1982)；Kanerva (1988) *Sparse Distributed Memory*
- Schultz, Dayan & Montague (1997) 奖赏预测误差；Doya (2002) 神经调质元学习；Boureau & Dayan (2011) DA/5-HT 对抗
- Scherer (2001) SEC；Ortony, Clore & Collins (1988) OCC；Russell (1980) 环状情感模型；Barrett (2017) 建构情绪
- Damasio (1994) 躯体标记；Miller & Cohen (2001) 前额叶控制；Botvinick et al. (2001) 冲突监控；Daw, Niv & Dayan (2005) 模型基/无模型
- DeYoung (2015) 控制论 Big Five；McCrae & Costa 五因素模型
- Park et al. (2023) *Generative Agents*；Packer et al. (2023) *MemGPT*；Gutiérrez et al. (2024) *HippoRAG*；Xu et al. (2025) *A-MEM*；Behrouz et al. (2024) *Titans*
- Tononi & Cirelli (2006) 突触稳态；Walker & Stickgold 睡眠依赖巩固；Ebbinghaus 遗忘曲线
