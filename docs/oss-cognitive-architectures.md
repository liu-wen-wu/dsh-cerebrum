# 经典认知架构与情感计算架构 · 可落地技术备忘

> 面向 dsh-cerebrum（仿脑记忆/情绪/性格/判断插件）的增量调研。每条架构只给：①定位 ②核心循环 ③可编码公式 ④最值得抄的点。公式为「可直接转成 lib/core/* 纯函数」的形态。来源：各项目 docs/论文 + GitHub + 官方 whitepaper（文末给链接）。

## 1. ACT-R（Anderson，1976–，认知建模事实标准）

- **定位**：模块化符号-子符号混合架构，把「一次提取/一条规则」建模成毫秒级预算分配，是检索与效用学习最可抄的数学。
- **核心结构**：缓冲器模块（goal / imaginal / declarative / procedural / visual / manual）+ 中央生产系统。生产规则 `IF 条件 THEN 动作` 匹配缓冲器内容；声明性记忆是 chunk（槽-值对）。
- **可编码机制**（`memory.js` 已实现简化版，缺 partial matching 与 utility）：
  - 激活方程 `A_i = B_i + Σ_j W_j·S_ji + P·M_li + ε`
  - base-level：`B_i = ln Σ_k (now−t_k)^−d`，`d≈0.5`；`t_k` 为每次成功提取时刻（幂律+对数，等价于现 `baseLevel()`）
  - spreading：`S_ji = S − ln(fan_j)`，源激活按 fan 摊薄 `W_j = W/fan`（现 `fanGain()` 是其近似）
  - partial matching：`P·M_li`，`P` 失配惩罚（默认 1.0），`M` 请求槽与 chunk 槽相似度；**缺失项**
  - noise：`ε ~ logistic`，`s = σ√3/π`，`σ≈0.4`（0.453）；提取概率 `P = 1/(1+e^−(A−τ)/s)`，`τ` 提取阈值；提取时延 `T = F·e^−A`，`F≈0.35s`——**时延当前未建模**
  - utility 学习（生产/习惯选择）：`U_i(n) = U_i(n−1) + α(R_i(n)−U_i(n−1))`，`α=0.2`；选择概率 `P_i = e^{U_i/t} / Σ e^{U_j/t}`，`t = √2·s`。奖励经目标缓冲器回传。
- **最值得抄**：**partial matching + 提取阈值 + 时延**三件套——现在 `recall()` 只做「相似度作为激活」，没有「槽级失配惩罚」和「激活→时延」映射；补上后检索可解释性与单调性都更强。

## 2. SOAR（Laird, Newell & Rosenbloom，1987）

- **定位**：单一长时记忆统一符号架构；「一切认知 = 状态空间搜索 + 自动把结果编译成规则」。
- **核心结构**：工作记忆 WM（WME 有向图 `id ^attr value`）+ 三种长时记忆（semantic / episodic / procedural）+ 决策循环 **elaborate → decide → act**；impasses（无法 decide）→ 生成子目标递归解决。
- **可编码机制**：
  - 决策循环：elaborate 匹配生产→提出 operators；decide 按偏好（可接受/拒绝/更好/numeric）选一；act 触发所选 production 改 WM。
  - **chunking**：子目标达成后，把「到达子目标前的状态 → 结果」编译成新 production（一次学会、下次免搜索）。
  - **RL**：对「numeric indifferent」偏好的 operators 用 `V ← V + α(r − V)` 更新数字偏好（softmax 选择，ε-greedy）。
- **最值得抄**：**chunking = 把「达成结果的条件-动作」沉淀为可复用规则**。对应 dsh-cerebrum 现在 `consolidate()` 只抽 gist/schema、不产「条件→动作」的 `skills.json`（DESIGN.md 路线图 #3 的空缺）。

## 3. LIDA（Franklin 团队，Global Workspace Theory 计算化）

- **定位**：用「全局工作空间广播 + 注意力 codelet 竞争」解释意识；认知循环 ≈ 100–300ms 的注意脉冲。
- **核心结构**：感知 → 前意识缓冲 → 特征/注意力 codelet → **coalition（信息结构联盟）形成与竞争** → 胜者全局广播到所有模块 → 招募相关 scheme → 行动选择 → 学习（修改 episodic/semantic 关联）。
- **可编码机制**：
  - coalition = 一组相互关联的 `{representation + 激活值}`；竞争用 softmax/k-WTA 选单一胜者。
  - 广播 = 胜者把「内容 + 相关记忆 + 行动倾向」一次性写入各工作区（注意选择 = 预算下的 top-1 竞争，不是 top-K 并列）。
  - 学习 = 被广播内容与其唤醒的关联边被强化（等价于现 retrieval 后的 `_rehearse`，但 LIDA 强调「只有广播过的才强化」）。
- **最值得抄**：**单一胜者广播**——现在 `renderPromptState()` 把 top-K 记忆并列注入；LIDA 说应只广播「当前意识内容」1 条 + 其余作为次意识候选，避免 prompt 被 K 条弱相关记忆稀释（对应 DESIGN.md 的「冗余注入」指标）。

## 4. HTM / Numenta（Hawkins，2004–，新皮层序列记忆）

- **定位**：新皮层作为「稀疏序列预测器」；一切 = 稀疏分布式表征(SDR) + 空间池化 + 时序记忆（预测）。
- **核心结构**：层状 minicolumn（2048 列 × 每个 32 细胞）；近端树突→空间池化，远端(基底/顶端)树突→预测性去极化。
- **可编码机制**（重点：预测 + 异常 + 序列记忆）：
  - SDR：二进制稀疏向量，约 **2% 激活**（2048 维 ≈ 40 个 1）；重叠度即相似度（现 `sdr.js` 用加权余弦，等价）。
  - 空间池化 SP：`overlap_j = Σ_i binarize(x_i) × permanence_{ij}`；**boost** 因子提高少用列的竞争力；全局/局部 **k-WTA 抑制**；学习 `permanence += (活性−θ)` 靠近/远离阈值。
  - 时序记忆 TM：细胞处于 **predictive state（去极化，由远端段识别先前上下文）** 时，若列再收到前馈输入则该细胞率先放电（预测下一序列元素）；**未预测列 burst**（minicolumn 全细胞放电），并学习把「刚才的上下文→新段」连上；**anomaly = 未被预测的活性列 / 活性列总数**。
  - 层级：底层学「token→token」，高层学「序列→序列」；顶端学长时程与语义。
  - Hawkins & Ahmad 2016《Why Neurons Have Thousands of Synapses》：一个神经元在树突上识别**数百个**上下文模式，任一匹配即去极化——所以「预测」是细胞级先验，不是全局状态机。
- **最值得抄**：**`anomaly = unpredicted/active` 作为预测性 surprise**——现在 `service.js _surprise()` 只是「与过去 40 条的最大余弦」的反应式度量；改成「用当前上下文预测下一概念集合，再看命中率」后，事件分割与 affect.novelty 会从「像不像旧事」升级为「预没预测到」。

## 5. OpenNARS（Wang）与 OpenCog（Goertzel 团队）

- **定位**：两个「通用智能」路线——OpenNARS 用非公理逻辑(NAL)在有限资源下推理；OpenCog 用超图 + 经济注意分配做认知协同。
- **OpenNARS 可编码机制**：
  - NAL 真值 = `(f, c)`：频率 f=正例/(正例+反例)，置信度 c 随证据量单调升（`c = (w_pos+w_neg)/(w_pos+w_neg+k)`，k 常数）。
  - 推理规则（可编码成纯函数）：deduction / induction / abduction / revision（两条证据合并 f、c 取加权）+ 选择规则。
  - 工作循环：按**优先级**选概念 → 选该概念的 task（belief/goal）→ 与已有概念匹配派生结论 → 按 **budget（priority, durability, quality）** 决定是否写入/丢弃；质量×优先级决定注意分配。
- **OpenCog 可编码机制**：
  - AtomSpace = 带真值/注意值的加权超图；**ECAN（Economic Attention Network）**：每个 Atom 有 STI（短时重要性）/ LTI（长时）/ VLTI；注意「扩散 + 收租（rent）」——重要 Atom 激活邻居，同时所有 STI 周期性衰减（不用的自然掉底）。
  - OpenPsi：需求(demand)→目标→规划，情绪=需求满足度信号；PLN=概率逻辑；MOSES=程序归纳。
- **最值得抄**：**STI/LTI + 收租的注意力经济**——`concepts` 节点现在只有 strength/count 单调增，无「重要度衰减 + 扩散 + 预算驱逐」；给概念加 STI/LTI 并让它决定候选集与 prompt 预算，能治理 hub 垄断与候选膨胀。

## 6. 情感计算架构（appraisal → mood → personality → action 全链路）

- **OCC（Ortony-Clore-Collins 1988）**：22 类情绪按三支分类——事件后果(希望/恐惧/喜悦/痛苦/解脱/失望)、他人行为(赞许/责备→自豪/羞愧/赞赏/谴责/感激/愤怒/满足/悔恨)、对象吸引(爱/恨)。评价变量：desirability / praiseworthiness / appealingness / likelihood / familiarity。**关键**：情绪类型由「支 × 效价 × 主体」决定，不是连续打分。
- **EMA（Gratch & Marsella 2004）**：在 BDI 上做评价。appraisal frame = (person-causal interpretation, beliefs, desires, intentions)；**coping** = 问题聚焦(改计划) vs 情绪聚焦(改解释/否认)；mood = 过去情绪聚合的慢背景；产出 coping intention 反向改 appraisal。
- **ALMA（Gebhard 2005，三层）**：emotion(秒) → mood(小时) → personality(年)；用 **PAD（Pleasure-Arousal-Dominance，Mehrabian）** 三维统一三层的坐标，mood = 情绪按 PAD 的加权滑动均值，personality = mood 的长期设定点。PAD↔Big Five 回归（Mehrabian，近似）：
  - `P = .21E + .59A − .19N`；`A = .15O + .30A − .57N`；`D = .25O + .17C + .60E − .32A`
- **GAMYGDALA（Popescu/Broekens 2014，~200 行开源）**：goal 有 `utility u` 与 `likelihood l`；事件=belief(似然, 因果主体, 受影响目标, congruence)。**`desirability = Δlikelihood × utility`**（`Δlikelihood` 为目标似然的增量或绝对变化）；内部情绪(joy/distress/hope/fear/relief/disappointment)由 desirability 方向定，社交情绪(anger/gratitude/remorse)由 relation(好感 −1..1) 与因果主体定；情绪按 `decayFactor`(默认 0.8) 指数衰减，mood = 情绪加权平均。
- **FAtiMA（Dias & Paiva）**：OCC 评价 + BDI 决策的双层（反应式情绪层 + 审慎层）；评价→情绪→行动倾向(action tendency)直接改计划优先级。**行动倾向是情绪影响行为的标准接口**。
- **PSI 理论（Dörner）**：动机/情绪/人格统一。需求(need：生理=能量/水/完整性；社会=归属/确定性/胜任)产生**调制器** arousal、resolution level、selection threshold；情绪是调制器的组合；**人格 = 调制器参数集**（如抱负水平、激活阈值）。核心公式形如 `need强度 → 调制器 → 认知参数(探索率/计划深度/努力)`。
- **可编码建议链**（增量）：goal 带 `(utility, likelihood)` → 事件算 `Δlikelihood` → `desirability=Δl×u` 驱动 valence；PAD 补上 **Dominance**（现只有 v/a）；情绪分类尊重 OCC 三支（用现 `agency`/`norm` 分出「他人行为」支）；行动倾向直接喂 judge 的方案评分；PSI 的「需求满足度 → 调制器」把 neuromods 与 `self.goals` 进度挂钩。

## 7. 人格建模（Big Five / HEXACO 之外）

- **Big Five OCEAN** 与 **HEXACO**（多 Honesty-Humility + Emotionality，6 维）：都只是「静态特质向量」，关键在**特质→行为参数的映射函数**（现 `personality.params()` 已做，方向对）。
- **ALMA 三层人格**：personality 不是独立维度，而是 **PAD 空间的长期设定点**（mood 向其回归，emotion 围绕其波动）——把人格与情绪放进同一坐标，三层可互换/可加减。→ 现 `affect.baseline` 只回归到固定值，改为「回归到 PAD 人格设定点」即可统一。
- **PSI 参数化人格**：人格 = 一组**可调认知参数**（resolution level 分辨率、activation 激活、selection threshold 选择阈值、抱负水平），直接改变决策算法的运行参数，而非只改文案。→ 现 params() 已参数化，但缺「需求状态动态改参数」（只有 trait 静态映射）。
- **LLM persona 工程实践**：①系统提示词 persona 卡（身份/目标/边界/语气）；②few-shot 范例锚定风格；③Big Five→采样参数（高 O→高 temperature/top_p，高 C→低 temperature/更多 CoT）；④记忆一致性（用跨会话记忆保证 persona 稳定，避免逐轮漂移）；⑤价值观/红线作为硬约束注入（现 `self.values` + judge `NORM_RISK` 已做雏形）。
- **最值得抄**：**把 personality、mood、emotion 放进同一 PAD 空间**（ALMA）——三层互为坐标变换，而不是三套独立状态；这是现 affect.js(2D Russell) 与 personality.js(Big Five) 之间缺的统一层。

## 8. BDI（belief-desire-intention，AgentSpeak(L) / Jason）

- **定位**：实用推理（practical reasoning）= 决定「做什么(desire)」+ 决定「怎么做(intention)」；AgentSpeak 是其逻辑编程实现。
- **核心结构**：beliefs(基事实库)、goals(achievement `!g` / test `?g`)、plans（`触发事件 : 上下文 ← 计划体`）、**intention = 部分执行的计划栈**（承诺，不轻易放弃）。
- **可编码机制**：
  - 解释器循环：感知→belief 修正→事件队列→取事件→匹配 **relevant plans**(触发事件同) → **applicable plans**(上下文为真) → 选一条(意图) → 压入 intention stack 逐条执行（子目标再触发事件）。
  - **意图重考虑**：新信息使上下文失效或出现更优计划时，放弃/替换 intention（Jason 的 `intention selection`）。
  - **信念修正**：`+b / -b` 更新，新事实与旧信念冲突时按信念修正策略（AGM 风格：最小变更、优先级）取舍。
- **与 LLM Agent 结合**：beliefs = 结构化世界状态/记忆摘录；desires = 用户目标与 `self.goals`；intentions = 当前「已承诺待执行」的子任务栈（提示词里显式列出，防遗忘）；plans = 工具调用序列/skills（带上下文前置条件）；「信念修正」对应现 `reconsolidate()`，但缺**显式意图栈 + 计划上下文前置条件**。
- **最值得抄**：**意图栈 + 计划 applicable 上下文**——judge 现在对无前置条件的方案打分，缺「这个方案此刻是否适用(applicable)」；补 `intentions` 结构与 `plan.context` 前置条件后，决策从「评分离散选项」升级为「目标-计划-意图」闭环（对应路线图 #9 前瞻记忆）。

---

## 可复用机制清单（点名机制 + 出处）

1. ACT-R base-level 激活 `ln Σ t^−d`（d=0.5）—— 检索的时间梯度来源（ACT-R）。
2. ACT-R partial matching `P·M` + 提取阈值 `τ` + 时延 `T=F·e^−A` —— 检索可解释三件套（ACT-R）。
3. ACT-R utility 学习 `U←U+α(R−U)` + softmax 选择（α=0.2，t=√2s）—— 习惯/动作选择 RL（ACT-R）。
4. SOAR chunking：子目标结果→`条件→动作`生产编译 —— 一次学会免搜索（SOAR）。
5. SOAR elaborate/decide/act + impasse→子目标 —— 决策循环骨架（SOAR）。
6. LIDA coalition + **单一胜者全局广播** —— 注意选择 = top-1 竞争（LIDA/GWT）。
7. HTM spatial pooler（boost + k-WTA + permanence）—— 稀疏表征的自适应分桶（Numenta）。
8. HTM temporal memory + 树突预测先验（predictive depolarization + bursting，Hawkins & Ahmad 2016）—— 序列预测 + 学习（Numenta）。
9. HTM **anomaly = unpredicted/active columns** —— 预测性 surprise 度量（Numenta）。
10. NARS 真值 `(f, c)` + 推理/修正规则 —— 不确定知识的证据合并（OpenNARS）。
11. OpenCog ECAN：STI/LTI + 扩散 + **收租衰减** —— 注意力经济（OpenCog）。
12. OCC 三支（事件后果/他人行为/对象）× 效价 —— 情绪分类结构（OCC）。
13. EMA coping（问题/情绪聚焦）→ 改 appraisal —— 情绪-应对闭环（Gratch & Marsella）。
14. ALMA PAD 三层统一（emotion/mood/personality 同坐标）+ Mehrabian PAD↔Big Five 回归 —— 情感层次统一（Gebhard）。
15. GAMYGDALA `desirability = Δlikelihood × utility` —— 目标效用情绪（Popescu 等）。
16. FAtiMA 行动倾向(action tendency) → 改计划优先级 —— 情绪影响行为的接口（Dias & Paiva）。
17. PSI 需求 → 调制器(arousal/resolution/threshold) → 认知参数 —— 动机驱动认知（Dörner）。
18. BDI 意图栈 + 计划 applicable 上下文 + 意图重考虑 —— 目标-计划-意图闭环（AgentSpeak/Jason）。

## 对 dsh-cerebrum 的可落地建议（增量，不重复已有实现）

> 每个条目 = 要改的文件/函数 + 改成什么 + 为什么。

1. **`lib/core/memory.js` `recall()`**：激活项补 `P·M_li`（partial matching：把 cue 概念与候选概念做槽级失配惩罚）与显式 `retrievalThreshold τ`；并让返回带 `latency = F·e^−activation`。→ 检索从「相似度排序」升级为「激活 vs 阈值 vs 时延」的可解释三件套（ACT-R）。
2. **`lib/core/judge.js` `_evaluateOption()`**：加 ACT-R utility 学习——按「方案模式」维护 `U_i`，`U←U+0.2(R−U)`（R=事后成功/失败），与前景理论分做加权/门控融合。→ 决策会从历史结果「养成偏好」，而非每轮冷启动（ACT-R）。
3. **`lib/core/memory.js` `consolidate()`**：NREM 阶段加 SOAR chunking——对「结果一致 + 有共同前置条件」的 schema 簇，产出 `skills.json` 规则 `{when:[概念], do:gist, successRate}`。→ 补上「程序性记忆未独立建模」的空缺（SOAR；DESIGN.md #3）。
4. **`lib/service.js` `renderPromptState()`**：只广播 top-1 记忆（「当前意识内容」），其余 K−1 降级为不注入的次意识候选（或折叠成一行计数）。→ 治理 prompt 冗余注入（LIDA 单一胜者广播）。
5. **`lib/service.js` `_surprise()` + `lib/core/memory.js`**：实现 HTM 预测性 surprise——用当前 TCM 上下文在概念图上预测「下一活跃概念集」，`anomaly = 未预测/活跃`；替换纯余弦相似度。→ 事件分割与 novelty 从「像不像旧事」升级为「预没预测到」（HTM）。
6. **`lib/core/memory.js` 概念节点**：给 `concepts` 加 STI/LTI + 收租衰减（每次 `consolidate`/访问时 `STI ← STI·decay`，重要概念扩散激活邻居），用 STI 决定候选集规模与 prompt 预算。→ 注意力经济治理 hub 与候选膨胀（OpenCog ECAN）。
7. **`lib/core/affect.js` `appraise()`**：引入 goal 基评价——`self.goals` 每项带 `{utility, likelihood}`，事件算 `Δlikelihood`，`desirability = Δlikelihood × utility` 驱动 congruence/valence（不再只靠正则 sentiment）。→ 情绪真正反映目标进展（GAMYGDALA）。
8. **`lib/core/affect.js`**：核心情感 2D(v,a) 扩展为 **PAD**，补 `dominance`；`baseline` 改为回归到「PAD 人格设定点」。→ 三层次(emotion/mood/personality)同坐标，可互换算（ALMA）。
9. **`lib/core/personality.js` `params()`**：把 Mehrabian PAD↔Big Five 回归做成 `padOf(traits)`，与 affect 的 PAD 对齐；`describe()`/prompt 用 PAD 而非离散形容词。→ 人格与情绪统一层（ALMA）。
10. **`lib/core/affect.js` `neuromods`**：把 DA/5-HT/NE/ACh 更新与 `self.goals` 满足度挂钩（需求满足 → DA↑；需求受阻 → 5-HT/NE↑），实现 PSI「需求→调制器→认知参数」闭环。→ 动机驱动认知，而非只由事件驱动（PSI）。
11. **`lib/core/affect.js` 情绪分类**：利用现有 `agency`/`norm` 实现 OCC 三支分支——`agency≈self 且 norm<0 → 自豪/羞愧`、`agency≈other 且 norm<0 → 赞赏/谴责/愤怒/感激`，补齐社交情绪（现 15 原型缺 praise/blame 支）。→ 情绪分类结构完整（OCC）。
12. **`lib/core/judge.js`**：情绪加「行动倾向(action tendency)」字段（现 `EMOTION_PROTOTYPES.tendency` 已存但未用），作为方案评分的一个显式偏置项。→ 情绪以结构化方式影响行为，不靠文案（FAtiMA）。
13. **`lib/service.js`**：新增 `intentions.jsonl` 意图栈 + `intend()`/`reconsider()`；每轮做关键词/时间触发匹配（前瞻记忆），意图进入 prompt。→ 补路线图 #9，实现 BDI 意图闭环（AgentSpeak/Jason）。
14. **`lib/core/judge.js` `_evaluateOption()`**：给方案加 `context` 前置条件（来自 #3 的 skills），先筛「applicable 方案」再评分，实现 AgentSpeak 的 relevant→applicable→意图选择。→ 决策尊重前置条件，减少无意义选项（BDI）。
15. **`lib/core/memory.js` `reconsolidate()`**：信念修正改 NARS 真值 `(f,c)` 合并——新旧结论用 revision 规则合并 f/c，而非现在的 0.6/0.4 固定加权。→ 证据量决定置信度，更平滑（OpenNARS）。

---

## 参考文献（核验链接）

- ACT-R 参数与方程：<https://act-r.psy.cmu.edu/wordpress/wp-content/themes/ACT-R/workshops/2001/talks/Subsymbolic.pdf>；激活方程见 <https://research.rug.nl/files/2650996/01_pt1.pdf>
- SOAR 决策循环与 chunking：<https://archive.org/download/DTIC_ADA314690/DTIC_ADA314690_text.pdf>
- LIDA 认知循环时序：<https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0014803>
- HTM 白皮书：<https://www.numenta.com/assets/pdf/whitepapers/hierarchical-temporal-memory-cortical-learning-algorithm-0.2.1-en.pdf>；BaMI：<https://www.numenta.com/assets/pdf/biological-and-machine-intelligence/BaMI-Complete.pdf>
- Hawkins & Ahmad 2016《Why Neurons Have Thousands of Synapses》：<https://arxiv.org/abs/1511.00083>
- OpenNARS/非公理逻辑：<https://www.cis.temple.edu/~pwang/Publication/OpenNARS.pdf>；<https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2025.1586033/full>
- OpenCog ECAN：<https://github.com/OzCog/opencog-unified/blob/main/atenspace/IMPLEMENTATION_ECAN.md>
- GAMYGDALA 源码与文档：<https://github.com/broekens/GAMYGDALA>（`js/Gamygdala.js`）
- EMA：<https://stacymarsella.org/publications/pdf/marsella-aamas03.pdf>；coping：<https://stacymarsella.org/publications/pdf/agents02-coping.pdf>
- OCC《The Cognitive Structure of Emotions》：<https://www.cambridge.org/core/books/abs/cognitive-structure-of-emotions/appraisal-the-value-system-and-primary-sources-of-intensity/A42C0763DCFB4AF678BF0F26EA422085>
- ALMA：<https://opus.lib.uts.edu.au/bitstream/10453/140485/2/02whole.pdf>
- PSI 理论（需求→调制器）：<http://gaips.inesc-id.pt/component/gaips/publications/showPublicationPdf?pid=47&format=raw>
- AgentSpeak/Jason 解释器：<https://lia.deis.unibo.it/corsi/2006-2007/SMA-LS/pdf/other/jason-tutorial06.pdf>
