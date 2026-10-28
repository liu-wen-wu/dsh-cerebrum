# 仿脑 Agent 记忆系统 v2 · 可编码机制与公式

> 目的：为 `lib/core/*` 的 v2 实现提供唯一公式口径。每条给出 ①原始文献 ②一句话机制 ③可编码公式 ④组件映射。
> 核验：2026-10-28。**●** = `api.crossref.org/works/{DOI}` 返回题名/年份/卷期一致，且 `https://doi.org/10.xxxx` 经 `Invoke-WebRequest` 实测 302 跳转到出版商页面。
> 参数标注：**[文]** 原文拟合值或实验值；**[工]** 本文给出的工程默认值（需在代码里可配）。
> 记号：`f_t`/`e_t` 为第 t 个事件的 k-WTA 稀疏码（`lib/core/sdr.js`，dim=2048, k=32），`‖f‖₂=1`，`cos` 为余弦。
>
> **实现状态（2026-10-28 晚，v2.1）**：本文「与当前代码的差距」列出的各项已按本节口径修复——TCM 改为 ρ=0.8/β=0.6（ρ²+β²=1）；`bcmTheta()` 已接入编码路径（τ_θ=20）；边更新合并为单条 BCM+Hebb 规则（`eta·(post(post−θ)+0.12)(1−w)`）；STDP 改为有符号 Δt（乱序可抑郁）；REM 脱钩 λ=0.15/次；工作记忆淘汰时间常数 30 min；schema 判据加入结果一致性。若后续参数再调，只改对应「差距」行即可，公式与文献不受影响。

---
## 1. 时间上下文模型（TCM / TCM-A）

**文献** — Howard, M. W., & Kahana, M. J. (2002). *A distributed representation of temporal context.* Journal of Mathematical Psychology, 46(3), 269–299. ● https://doi.org/10.1006/jmps.2001.1388
　TCM-A：Sederberg, P. B., Howard, M. W., & Kahana, M. J. (2008). *A context-based theory of recency and contiguity in free recall.* Psychological Review, 115(4), 893–912. ● https://doi.org/10.1037/a0013396

**机制** — 每编码一个事件就把当前输入混入一个缓慢漂移的上下文向量；检索用「内容×上下文」双匹配，成功检索后上下文被拉回该事件的编码状态，于是时间邻近的事件互为线索（contiguity）。

**公式**
```text
状态演化   c_t = ρ·c_{t-1} + β·f_t
单位约束   ‖c_t‖₂ = 1  ⇒  ρ = √(1 − β²)（f_t ⟂ c_{t-1}、‖f_t‖=1 时精确）
检索打分   s_i = cos(c_t, t_i) = c_t·t_i ；总分 A_i += w_ctx·s_i
上下文复现 c_{t+1} = (1−γ)·c_t + γ·t_i          # 检索命中后
连续时间   ρ(Δt) = exp(−Δt/τ_c),  β(Δt) = 1 − ρ(Δt)
```
**参数** — **[文]** β=0.627、β_dist=0.977（Sederberg 2008 自由回忆拟合；β 范围 0–1，β_dist 0.1–1）；由此 ρ=√(1−0.627²)=0.779。**[工]** β=0.35⇒ρ=0.937（快漂移，适合回合级）；τ_c=3–10 min；γ=0.35；w_ctx=0.8–1.0。
**映射** — `lib/core/plasticity.js:updateContext()` / `reinstateContext()`；`memory.js:encodeEpisode()` 写 `ep.context`；`recall()` 的 `contextMatch = codeDot(currentContext, ep.context)` 与权重 0.8；`service.js` 每回合 `state.context = updateContext(...)`。
**差距** — 当前 `updateContext` 默认 `rho=0.75, beta=0.35`，二者不满足 ρ²+β²=1（等价 β_eff≈0.42）；`unionCodes` 事后 L2 归一，只保住比例不保单位长度语义。改法见 §清单 1。

---
## 2. BCM 理论与滑动阈值 θ_M

**文献** — Bienenstock, E. L., Cooper, L. N., & Munro, P. W. (1982). *Theory for the development of neuron selectivity: orientation specificity and binocular interaction in visual cortex.* Journal of Neuroscience, 2(1), 32–48. ● https://doi.org/10.1523/JNEUROSCI.02-01-00032.1982

**机制** — 突触修改方向取决于突触后活动 y 相对滑动阈值 θ_M 的位置；θ_M 追踪 y² 的长期均值并上移，于是同一活动水平在静息期引起 LTP、在饱和期引起 LTD，网络自稳定地形成选择性。

**公式**
```text
权重      Δw = η·x·y·(y − θ_M)          # x=前活动, y=后活动 ≥ 0
分段      y > θ_M → LTP；0 < y < θ_M → LTD；y = θ_M → 0
阈值      θ_M ← θ_M + (y² − θ_M)/τ_θ    # θ_M → E[y²]
稳定条件  τ_θ ≪ 1/η（阈值须快于权重）；若 τ_θ ≫ 1/η，必须叠加 synaptic scaling 兜底
```
**参数** — **[文]** 原文把 θ_M 定义为 E[y²]（滑动平均），未给统一 η/τ_θ 数值。**[工]** η=0.02–0.08（回合级），τ_θ=20–100 回合（毫秒级对应 10²–10⁴ ms）；τ_θ=50 且 η>0.01 时已非准静态，靠 `synapticScaling()` 防发散；θ_M 初值 0.25–0.35。
**映射** — `plasticity.js:bcmDelta()` 与 `bcmTheta()`；`memory.js:_strengthenEdge()` 已调用 `bcmDelta`（`eta*2`，post∈[0.35,0.85]，θ 取概念节点值）；`encodeEpisode()` 内 `node.theta += (0.36 − theta)/50` 是硬编码版。
**差距** — `bcmTheta()` 全库零调用（dead code），且 `_strengthenEdge` 把 BCM 项与 `eta*(1−w)` 相加，单次边权更新可达 0.03–0.05（BCM 单项仅约 0.006）；θ 目标写死 0.36 而非实测 post²。改法见 §清单 4。

---
## 3. 基于迹的 STDP 与 triplet 规则

**文献** — Pfister, J.-P., & Gerstner, W. (2006). *Triplets of spikes in a model of spike timing-dependent plasticity.* Journal of Neuroscience, 26(38), 9673–9682. ● https://doi.org/10.1523/JNEUROSCI.1425-06.2006
　Morrison, A., Diesmann, M., & Gerstner, W. (2008). *Phenomenological models of synaptic plasticity based on spike timing.* Biological Cybernetics, 98(6), 459–478. ● https://doi.org/10.1007/s00422-008-0233-1

**机制** — 突触维护指数衰减的 pre/post 迹，权重改变由「pair 项 + 三重项」共同决定，因此同一 Δt 在不同重复频率下给出不同结果（pair 模型做不到）。

**公式**
```text
迹        τ₊·dx/dt  = −x  + Σ δ(t−t_pre)
          τ₋·dy₁/dt = −y₁ + Σ δ(t−t_post)
          τ_y·dy₂/dt= −y₂ + Σ δ(t−t_post)      # 慢后迹，供 triplet
          τ_x·dx₂/dt= −x₂ + Σ δ(t−t_pre)       # 慢前迹
后发放    Δw = A₂₊·x + A₃₊·x·y₂
前发放    Δw = −A₂₋·y₁ − A₃₋·x₂·y₁
窗函数    W(Δt) = A₊·exp(−Δt/τ₊) (Δt>0) ；−A₋·exp(Δt/τ₋) (Δt<0)
```
**参数** — **[文]** τ₊=16.8 ms、τ₋=33.7 ms（Pfister 固定取 Bi & Poo 2001）；视觉皮层 minimal：A₂₊=0、A₃₊=6.5×10⁻³、A₂₋=7.1×10⁻³、A₃₋=0、τ_x=114、τ_y=125；海马培养 full：A₂₊=6.1×10⁻³、A₃₊=6.7×10⁻³、A₂₋=1.6×10⁻³、A₃₋=1.4×10⁻³、τ_x=946、τ_y=27。
**回合近似** — 令 1 turn = 1 spike，`Δt_min=(t_post−t_pre)/60e3`；毫秒窗口压缩 10⁵ 倍 ⇒ τ_turn=30–90 min（≈16.8 ms 的等价缓慢遗忘）；连续多回合用迹累积 `x ← x·e^{−Δt/τ} + 1`，再 `Δw = A₊·x`（正）/`−A₋·y`（负），可避免只比较相邻两回合。
**映射** — `plasticity.js:stdpDelta()`；`memory.js:encodeEpisode()` 末尾「跨 episode STDP」段（取前后各 2 个概念建边）。
**差距** — 调用处 `Math.max(0, Δt)` 把 Δt 恒置为非负，`aMinus` 分支永不可达（抑郁失效）；`aPlus=0.1 > aMinus=0.04` 与生物学的 A₋≳A₊ 相反（工程上保留前向偏好可接受，但要显式注释，别当作 STDP 拟合）。

---
## 4. 事件分割理论（EST）

**文献** — Zacks, J. M., Speer, N. K., Swallow, K. M., Braver, T. S., & Reynolds, J. R. (2007). *Event perception: a mind-brain perspective.* Psychological Bulletin, 133(2), 273–293. ● https://doi.org/10.1037/0033-2909.133.2.273
　Radvansky, G. A., & Zacks, J. M. (2017). *Event boundaries in memory and cognition.* Current Opinion in Behavioral Sciences, 17, 133–140. ● https://doi.org/10.1016/j.cobeha.2017.08.006
　行为范式：Zacks, J. M., Tversky, B., & Iyer, G. (2001). *Perceiving, remembering, and communicating structure in events.* JEP: General, 130(1), 29–58. ● https://doi.org/10.1037/0096-3445.130.1.29

**机制** — 大脑在线维护「当前事件模型」并预测下一刻；预测误差突增或显著性突变时更新模型并落下边界，边界两侧的记忆被分段、彼此干扰更小、跨边界检索更慢。

**公式**
```text
预测误差  PE_t = 1 − max_i cos(e_t, e_i)                 # 近 W 条历史
标准化    z_t  = (PE_t − μ_{t−W:t}) / (σ_{t−W:t} + 1e−6)
边界      boundary ⇔ (z_t > z*) ∨ (salience_t > s*) ∨ (Δt > Δ_max) ∨ (n_seg ≥ L_max)
风险率    P(boundary | 已存活 t) = h₀·exp(λt)，h₀≈0.02–0.05/回合（基线风险，可叠加记忆项）
边界后    c ← ρ_reset·c，ρ_reset ∈ [0.2,0.5]；不置零，保留跨段线索
```
**参数** — **[文]** 自然事件的时间尺度为秒到分钟量级，同一影片的边界在受试者间高度一致（Zacks 2001 按键分段法）；无统一 z* 数值。**[工]** W=40、z*=1.5–2.5、L_min=2、L_max=6–8、Δ_max=10 min、ρ_reset=0.35。
**映射** — `service.js` 的 `boundary` 判定与 `_flushSegment()`；`config.segmentation = {maxTurns, gapMs, surpriseThreshold}`；`memory.js:encodeEpisode({segments})` 记录回合区间。
**差距** — 当前 `surpriseThreshold=0.72` 是绝对阈值（未做 z 标准化，受语料相似度基线漂移影响）；`boundary` 还含 `importance ≥ 0.72` 与 `errors > 0`，后者使每个失败回合都切段，事件被切碎。改法见 §清单 7–9。

---
## 5. 优先经验回放：need × gain 与 PER

**文献** — Mattar, M. G., & Daw, N. D. (2018). *Prioritized memory access explains planning and hippocampal replay.* Nature Neuroscience, 21(11), 1609–1617. ● https://doi.org/10.1038/s41593-018-0232-z
　Schaul, T., Quan, J., Antonoglou, I., & Silver, D. (2016). *Prioritized experience replay.* ICLR. ● https://arxiv.org/abs/1511.05952

**机制** — 重放优先访问「need（该状态未来还会被用到多少）× gain（在此重规划能带来多少价值提升）」最大的状态；工程实现用 TD 误差的幂律优先级 + 重要性采样纠偏。

**公式**
```text
理论      priority(s) ∝ need(s)·gain(s)
          need(s) = E[未来访问次数 | 当前策略]；gain(s) = max_a Q*(s,a) − V(s)
PER       p_i = |δ_i|^α ；P(i) = p_i / Σ_j p_j
IS 权重   w_i = (N·P(i))^{−β} / max_k w_k
退火      β: 0.4 → 1.0（线性，约 1e5–1e6 次更新）
工程近似  score = importance · (0.4+|v|) · 1/(1+retrievals) · (0.5+0.5·e^{−age/30d})
```
**参数** — **[文]** α=0.6、β₀=0.4（Schaul）；**[工]** ageTau=30 d、need 的 affect 偏置 0.4、gain 用 1/(1+retrievals) 代理不确定性。
**映射** — `plasticity.js:replayPriority()`；`memory.js:consolidate()` 对未巩固 episode 按该分排序后取 top 400。
**差距** — 无 IS 权重（仅离线重放、不做梯度更新时可接受；一旦用于微调必须补 `w_i`）；`replayPriority` 的 gain 只在 retrievals 上单调，未含 PE/TD 误差项。改法见 §清单 10。

---
## 6. 睡眠双阶段：NREM 语义化 + REM 情绪脱钩

**文献** — Walker, M. P., & van der Helm, E. (2009). *Overnight therapy? The role of sleep in emotional brain processing.* Psychological Bulletin, 135(5), 731–748. ● https://doi.org/10.1037/a0016570
　van der Helm, E., & Walker, M. P. (2011). *Sleep and emotional memory processing.* Sleep Medicine Clinics, 6(1), 31–43. ● https://doi.org/10.1016/j.jsmc.2010.12.010

**机制** — NREM（慢振荡/纺锤波）驱动海马→新皮层重放，把情景去情境化为语义；REM 在低 NE/高 ACh 下重激活情绪记忆但抑制杏仁核的肾上腺素能标记，使内容保留、情绪强度衰减——"sleep to forget, sleep to remember"。

**公式**
```text
NREM     replay_rate r ∈ [0.1,0.3]/夜；cluster → gist；strength += κ·n_replay
         语义节点 strength ← 1 − (1−strength)·e^{−κ·n}，κ=0.05–0.15
REM      v_{n+1} = v_n·(1 − λ_rem)，λ_rem = 1 − e^{−1/τ_emo}
         a_{n+1} = a_n·(1 − λ_rem/2)；内容关联 w 不变（只脱钩情绪，不脱钩内容）
守卫     仅 age > 1 d 且 |v| > 0.05 的 episode 参与
```
**参数** — **[文]** τ_emo 为数夜量级（1 夜约衰减 30–50%）；**[工]** τ_emo=2 夜 ⇒ λ=0.39/夜；每夜 3–5 个 REM 周期则每次 0.10–0.15。
**映射** — `memory.js:consolidate({stage:'nrem'|'rem'})`；`plasticity.js:decoupleAffect(rate=0.05)`；NREM 走 `replayPriority` 排序 + 概念聚类，REM 走随机连边 + 情绪衰减。
**差距** — `rate=0.05`/次意味着 20 次巩固才衰减 64%，远慢于 τ=2 夜；且 `decoupleAffect` 同时缩放 a（系数 0.5）缺文献依据，v/a 应有不同 τ。改法见 §清单 11–12。

---
## 7. 图式加速巩固

**文献** — Tse, D., Langston, R. F., Kakeyama, M., Bethus, I., Spooner, P. A., Wood, E. R., Witter, M. P., & Morris, R. G. M. (2007). *Schemas and memory consolidation.* Science, 316(5821), 76–82. ● https://doi.org/10.1126/science.1135935
　van Kesteren, M. T. R., Ruiter, D. J., Fernández, G., & Henson, R. N. (2012). *How schema and novelty augment memory formation.* Trends in Neurosciences, 35(4), 211–219. ● https://doi.org/10.1016/j.tins.2012.02.001

**机制** — 新信息与既有图式一致时，mPFC 介导的编码/巩固被加速（可一次学习即整合）；不一致时回到海马依赖的慢速路径，需要更多重放。

**公式**
```text
一致性    s = cos(e_new, g_schema) ∈ [−1,1]；或 s = 1 − ‖e−ŷ‖/‖e‖
编码增益  η_eff = η₀·(1 + κ_s·max(0, s−θ_s)/(1−θ_s))
巩固加速  n_req = n₀·(1 − 0.7·max(0, s))        # s=0.8 ⇒ 44% 基线重放次数
分流      s > θ_s → fast-map 直写语义层，ep.schema=true
          s < θ_low → 慢路径，且 replayPriority × (1 + θ_s − s)
```
**参数** — **[文]** 图式一致时大鼠可在单次配对后完成整合，不一致时需多次训练（Tse 2007 的配对联想范式）；**[工]** θ_s=0.55、θ_low=0.2、κ_s=2、η₀ 取 §2 的 η。
**映射** — `memory.js:consolidate()` 的 schema 分支（`node.strength > 0.75` 判定 + `ep.strength += 0.1`）；`ep.schema` 标志参与 `snapshot()` 统计。
**差距** — 判据是「概念强度」而非「新旧一致性」，会给高频但无关的概念误发 schema 通行证；增益固定 +0.1，未随 s 缩放。改法见 §清单 13。

---
## 8. 提取诱发遗忘（RIF）与 fan 效应

**文献** — Anderson, M. C., Bjork, R. A., & Bjork, E. L. (1994). *Remembering can cause forgetting: retrieval dynamics in long-term memory.* JEP: LMC, 20(5), 1063–1087. ● https://doi.org/10.1037/0278-7393.20.5.1063
　Anderson, J. R. (1974). *Retrieval of propositional information from long-term memory.* Cognitive Psychology, 6(4), 451–474. ● https://doi.org/10.1016/0010-0285(74)90021-8
　Anderson, J. R., & Reder, L. M. (1999). *The fan effect: New results and new theories.* JEP: General, 128(2), 186–197. ● https://doi.org/10.1037/0096-3445.128.2.186

**机制** — 提取目标会抑制共享同一线索的竞争者（RIF）；一个概念关联越多（fan 越大），每条关联分到的激活越少，提取越慢越易错（fan effect）。

**公式**
```text
ACT-R     A_i = B_i + Σ_j W_j·S_ji + ε
          S_ji = S − λ·ln(fan_j)，fan_j = 与 j 相连的关联数，λ≈1
检索概率  P_i = 1/(1 + exp(−(A_i − τ)/s))，噪声 s=0.25–0.4
RIF       Δstrength_j = −κ_r·(1 − e^{−n/n₀})，j ∈ competitors(cue) \ {target}
fan 增益  g(fan) = fan^{−λ}（与 log 空间减 λ·ln fan 等价）
```
**参数** — **[文]** S≈1.5–2.0、s≈0.25–0.4；RIF 行为效应量为相对基线个位数到十几个百分点。**[工]** λ=0.6、κ_r=0.03–0.08、n₀=3、τ=0。
**映射** — `memory.js:recall()` 的竞争抑制分支（当前仅 `picked[1].strength *= 0.97`）；`memory.js:spread()` 用 `fanGain(neighbors.size)`。
**差距** — 抑制只作用于「第 2 名」而非「同线索全部非目标」，且每次 recall 放大 3% 会累积成系统性遗忘；`fanGain = 1/(1+0.6·ln(1+fan))` 是有界乘性增益，与 ACT-R 的 `S−ln(fan)` 不同构，两者混用会让 fan 效应量级不可解释。改法见 §清单 5–6。

---
## 9. 工作记忆容量与衰减

**文献** — Cowan, N. (2001). *The magical number 4 in short-term memory: A reconsideration of mental storage capacity.* Behavioral and Brain Sciences, 24(1), 87–114. ● https://doi.org/10.1017/S0140525X01003922
　Baddeley, A. (2000). *The episodic buffer: a new component of working memory?* Trends in Cognitive Sciences, 4(11), 417–423. ● https://doi.org/10.1016/S1364-6613(00)01538-2
　Baddeley, A. (2012). *Working memory: Theories, models, and controversies.* Annual Review of Psychology, 63, 1–29. ● https://doi.org/10.1146/annurev-psych-120710-100422

**机制** — 容量约 4±1 个组块；超限时按「激活×重要性」淘汰；未被复述的项按指数衰减，中央执行通过注意刷新维持 1–2 个优先项。

**公式**
```text
容量      K = 4（3–5）
淘汰      while n > K: remove argmin_i score_i
          score_i = w_r·e^{−Δt_i/τ_wm} + w_i·imp_i + w_g·goal_i
衰减      A_i(t) = A_i(0)·e^{−t/τ_wm}
刷新      A_i ← A_i + ρ_refresh（被注意时），ρ=0.3–0.5
优先级    p_i = softmax(β·(A_i + w_g·goal_i))，β=1–3
精度      σ_i² ∝ 1/(K·A_i)  ⇒ 置信度随槽位占用下降      # [工] 设计式，非原文
```
**参数** — **[文]** K=4±1；无复述保持窗口为秒级（Cowan 2001 综述）。**[工]** τ_wm 实验室 2–10 s ⇒ 回合级 1–2 回合（约 10–30 min 墙钟）；w_r=0.6、w_i=0.4、ρ_refresh=0.4。
**映射** — `service.js:_pushWorkingMemory()`（slots=4，score=0.6·e^{−Δt/1h}+0.4·imp）；`config.workingMemory.slots`；`prompt.js` 渲染 `state.wm`。
**差距** — 时间常数写死 1 h，淘汰几乎只按 importance；无 goal_match 项，也没有 refresh（同一摘要重复出现时不会加权）；`prompt.js` 按插入序而非 score 序渲染。改法见 §清单 14–15。

---
## v2 设计清单

1. `lib/core/plasticity.js:updateContext()`：默认改 `rho = Math.sqrt(1 − beta*beta)`（beta=0.35 ⇒ rho=0.937），并在 JSDoc 写明「ρ、β 是单位球面上的混合权重，`unionCodes` 的 L2 归一不替代该约束」；保留 `k=40`。
2. `memory.js:recall()`：`w_ctx` 0.8 → 1.0，且当 `currentContext` 为空时跳过该分项（现 `clamp` 返回 0 但仍占权重，等于给所有候选同分惩罚）；命中后 `reinstateContext(..., {gamma:0.35})`。
3. `memory.js:encodeEpisode()`：把 `state.context` 的推进改为 `updateContext(prev, code, {rho: 0.937, beta: 0.35, k: 40})`，与 §1 的 ρ²+β²=1 对齐；`ep.context` 存快照而非引用。
4. `memory.js:_strengthenEdge()`：BCM 项与 Hebb 项二选一——`delta = bcmDelta({pre:1, post, theta: node.theta ?? 0.3, eta: 0.04})`，删掉 `eta*(1−w)` 的线性项（当前两者相加使单次更新达 0.03–0.05，边权数次即饱和）。
5. `plasticity.js:fanGain()`：改为 `Math.pow(Math.max(fan,1), -lambda)`，`lambda=0.6`；`memory.js:spread()` 传 `neighbors.size`，使 log 空间等价于 `S − 0.6·ln(fan)`。
6. `memory.js:recall()`：RIF 从「第 2 名 ×0.97」改为对同 cue 非选中且 `activation > 0.8·top` 的候选统一 `×0.96`，每会话每候选最多 3 次（`ep.rifCount` 计数），避免复利式遗忘。
7. `service.js:_surprise()`：改为滑动 z 分数——`z=(1−maxCos−μ_40)/σ_40`，`boundary` 用 `z > 1.5`；新增 `config.segmentation.minTurns=2`，`segment.turns.length < minTurns` 时禁切。
8. `service.js` 边界条件：`errors > 0` → `errors >= 2`；`importance >= 0.72` → `>= 0.8`（importance 现在同时驱动切段与 salience，重复计权）。
9. `lib/config.js`：`segmentation.maxTurns` 4 → 6，新增 `peZ=1.5`、`minTurns=2`，并在 `resolveConfig` 里按现有 `clampNumber` 风格 clamp 到 [1,12]/[1,8]/[0.5,4]。
10. `memory.js:consolidate()` NREM：`pending` 从「全部未巩固取 400」改为 `replayPriority` top 20%（上限 200），每个 concept 最多吸收 3 个 episode 生成 gist，避免 gist 每轮被最新一条覆盖。
11. `plasticity.js:decoupleAffect()`：`rate` 改为按 REM 次数累计 `1 − Math.exp(-1/2)`≈0.39，或每次 0.12（每夜 3 周期）；`v` 与 `a` 分别用 `τ_v=2` 夜、`τ_a=1` 夜，删掉 `a` 的 0.5 系数。
12. `memory.js:consolidate()` REM：随机连边 `0.02` → `0.01`，且只允许 `node.schema === true` 的概念参与（当前 24 个强节点随机配对，每轮 6 条边，长期会把图变成稠密噪声）。
13. `memory.js:consolidate()` schema 分支：判据 `node.strength > 0.75` → `s = encoder.similarity(ep.code, gistCode) > 0.55 && node.count >= 3`；`ep.strength += 0.1` → `ep.strength *= (1 + 2*s)`，并把 `s` 写进 `ep.schemaScore` 便于审计。
14. `service.js:_pushWorkingMemory()`：`3600e3` → `1800e3`（30 min），score 加 `+0.2*goalMatch`（复用 `service.js` 的 `GOAL` 正则命中）；`slots` 保持 4，`config.workingMemory.slots` clamp [3,5]。
15. `lib/prompt.js`：WM 渲染前按 `score` 降序（与 `_pushWorkingMemory` 同一函数导出），最多 4 条、每条 ≤36 字，并在段首标注 `n/K`（当前已打印 `state.wm.length/slots`）。
16. `memory.js:retention()` / `prune()`：`keep` 分数加 `· g(fan)`（§8 的 fan 惩罚），防止高 fan 概念把长尾 episode 永久顶在保留区；`prune` 阈值保持 `0.9·maxEpisodes`。
17. `test/`：新增 `tcm.test.js`（断言 `‖c_t‖≈1` 且 `ρ²+β²≈1`）、`stdp.test.js`（构造 `Δt<0` 用例，断言抑郁分支可达）、`rif.test.js`（同 cue 三候选，断言非目标强度下降且目标上升）。
18. `lib/config.js` + `docs/DESIGN.zh.md`：把上述新键（`segmentation.peZ/minTurns`、`workingMemory.goalWeight`、`plasticity.lambda`）登记进 `DEFAULT_CONFIG` 与设计文档的参数表，避免「代码有、配置无」的隐参数。
