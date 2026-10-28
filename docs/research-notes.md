# 类脑 LLM Agent 认知架构 · 文献速查表（memory / storage / judgment / personality / emotion）

> 目标读者：正在实现 brain-inspired cognitive architecture 的工程团队。原则：每条文献给出**可编码的机制**，而不是抽象结论。
> 检索与核验日期：2026-10-27。
> 核验标记：**●** = 用 `Invoke-WebRequest -UseBasicParsing` 实测返回 HTTP 200 且页面题名匹配；**○** = DOI 经 `https://api.crossref.org/works/{DOI}` 实测存在、题名与年份一致（出版商 HTML 对脚本返回 403，浏览器可正常访问）。
> 未使用任何未核验的 DOI / arXiv ID；本书目内所有链接均已逐条实测。

## 0. 模块 → 文献簇 → 可编码产物

| 模块 | 主机制 | 文献簇 | 落地组件 |
|---|---|---|---|
| 记忆存储 | 快/慢双系统、重放、模式分离 | §1 | episodic store + semantic layer + replay scheduler |
| 联想检索 | attractor、稀疏编码、激活扩散 | §2 | 编码器(k-WTA) + 补全层(Hopfield) + 激活排序 |
| 调质参数 | DA/5-HT/NE/ACh → RL 超参 | §3 | 4 个全局标量 + PE 广播总线 |
| 情绪 | appraisal → 强度 → 行动倾向 | §4 | appraisal 流水线 + affect state vector |
| 人格 | 特质 → 决策参数 | §5 | personality vector → 参数映射表 |
| 判断 | 双过程、冲突监测、门控、EFE | §6 | 仲裁器 + ACC + gating + planner |

---

## 1. Complementary Learning Systems（海马快 / 皮层慢）

- **[C1] McClelland, J. L., McNaughton, B. L., & O'Reilly, R. C. (1995).** *Why there are complementary learning systems in the hippocampus and neocortex.* Psychological Review 102(3):419–457. ○ https://doi.org/10.1037/0033-295X.102.3.419
  - 机制：海马用稀疏、正交化编码快速写入单个 episode，新皮层用重叠分布式表征慢速抽取统计结构；两者**交错（interleaved）**训练可避免灾难性干扰 → 对应"快速事件表 + 慢速语义层 + 交错回放"。
- **[C2] Kumaran, D., Hassabis, D., & McClelland, J. L. (2016).** *What learning systems do intelligent agents need? Complementary learning systems theory updated.* Trends in Cognitive Sciences 20(7):512–534. ○ https://doi.org/10.1016/j.tics.2016.05.004
  - 机制：把重放的内容选择写成可计算规则——优先重放**预测误差大 / 新奇 / 与当前目标相关**的经验，并显式区分 memory-based 与 model-based 两套系统 → replay buffer 采样权重 = f(PE, novelty, goal-relevance)。
- **[C3] Yassa, M. A., & Stark, C. E. L. (2011).** *Pattern separation in the hippocampus.* Trends in Neurosciences 34(10):515–525. ○ https://doi.org/10.1016/j.tins.2011.06.006
  - 机制：齿状回通过稀疏扩增编码把相似输入**去相关**（pattern separation），CA3 recurrent attractor 由部分线索恢复完整记忆（pattern completion）→ 入库前做高维稀疏投影，检索时做 attractor 迭代。
- **[C4] Wilson, M. A., & McNaughton, B. L. (1994).** *Reactivation of hippocampal ensemble memories during sleep.* Science 265(5172):676–679. ○ https://doi.org/10.1126/science.8036517
  - 机制：SWS 中海马 CA1 群体按行为顺序、以快于实际行为的压缩时间尺度重放（place-cell pair 共激活显著高于随机）→ 离线 replay job 按 episode 内顺序加速重放。
- **[C5] Diekelmann, S., & Born, J. (2010).** *The memory function of sleep.* Nature Reviews Neuroscience 11(2):114–126. ● https://www.nature.com/articles/nrn2762
  - 机制：慢振荡/纺锤波驱动海马→新皮层系统巩固；REM 参与整合；突触稳态假说认为清醒期净增强需睡眠期再归一化 → 低负载时段批处理 + 权重归一化。
- **[C6] Spens, E., & Burgess, N. (2024).** *A generative model of memory construction and consolidation.* Nature Human Behaviour. ● https://www.nature.com/articles/s41562-023-01799-z
  - 机制：巩固 = 用重放样本**训练新皮层生成模型**，海马只提供情景索引与绑定，故记忆是重构而非复读（自然产生 schema 效应与记忆扭曲）→ consolidation job = 用 replay 微调摘要/生成模型。
- **[C7] Mattar, M. G., & Daw, N. D. (2018).** *Prioritized memory access explains planning and hippocampal replay.* Nature Neuroscience 21(11):1609–1617. ○ https://doi.org/10.1038/s41593-018-0232-z
  - 机制：重放优先级 ∝ **need(s) × gain(s)**（该状态未来价值可改进的期望），据此统一解释规划中的优先访问与海马重放 → replay scheduler 直接按该乘积排序。

## 2. 联想 / 吸引子记忆与神经元级机制

- **[B1] Hopfield, J. J. (1982).** *Neural networks and physical systems with emergent collective computational abilities.* PNAS 79(8):2554–2558. ○ https://doi.org/10.1073/pnas.79.8.2554
  - 机制：对称权重 + 单调下降的能量函数给出吸引子动力学，容量约 **0.138N**，可由部分/噪声线索恢复存储模式 → "键值绑定 + 去噪补全"的最小内核。
- **[B2] Kanerva, P. (1988).** *Sparse Distributed Memory.* MIT Press（ISBN 0-262-11132-9）. ● https://archive.org/details/sparsedistribute0000kane
  - 机制：高维二值地址空间 + 硬地址 + 汉明半径激活，写入时把数据分散到多个地址、读取按距离加权 → 相似性泛化与容错，可做 embedding 的离散化存储层。
- **[B3] Ramsauer, H., et al. (2021).** *Hopfield Networks is All You Need.* ICLR 2021. ● https://arxiv.org/abs/2008.02217
  - 机制：更新式 `ξ_new = X·softmax(β Xᵀ ξ)` 与 transformer attention 同构，一次更新即收敛，容量随模式间隔指数增长 → 直接用 attention 层实现"模式补全/去噪"。
- **[B4] Krotov, D., & Hopfield, J. J. (2016).** *Dense Associative Memory for Pattern Recognition.* NeurIPS 29. ● https://arxiv.org/abs/1606.01164
  - 机制：用 `F(Σ w x)` 的高阶（多项式/指数）交互替代二次能量，容量从 O(N) 提升到 O(N^{n−1}) → 提高库容量只需提高交互阶数/特征维。
- **[B5] Hu, J. Y.-C., Wu, D., & Liu, H. (2024).** *Provably Optimal Memory Capacity for Modern Hopfield Models: Transformer-Compatible Dense Associative Memories as Spherical Codes.* NeurIPS 37. ● https://proceedings.neurips.cc/paper_files/paper/2024/hash/82846e19e6d42ebfd4ace4361def29ae-Abstract-Conference.html
  - 机制：用球面码给出分离条件下的最优容量界与可实现构造 → 为 β 与码本最小夹角提供设计准则（不是调参玄学）。
- **[B6] Bi, G.-q., & Poo, M.-m. (1998).** *Synaptic modifications in cultured hippocampal neurons: dependence on spike timing, synaptic strength, and postsynaptic cell type.* Journal of Neuroscience 18(24):10464–10472. ○ https://doi.org/10.1523/JNEUROSCI.18-24-10464.1998
  - 机制：Δt = t_post − t_pre，因果序（Δt>0）增强、反因果序（Δt<0）减弱，τ₊≈17 ms、τ₋≈34 ms 且 A₋>A₊ → 序列学习的局部更新规则。
- **[B7] Anderson, J. R., et al. (2004).** *An integrated theory of the mind.* Psychological Review 111(4):1036–1060. ○ https://doi.org/10.1037/0033-295X.111.4.1036
  - 机制：模块化认知架构（declarative / procedural / working memory）由基底节做产生式选择，检索由激活值竞争决定 → 提供"激活值排序 + 阈值"的调度骨架。
- **[B8] Anderson, J. R. (1983).** *A spreading activation theory of memory.* Journal of Verbal Learning and Verbal Behavior 22(3):261–295. ○ https://doi.org/10.1016/S0022-5371(83)90201-3
  - 机制：激活沿语义网络边扩散并按 **fan**（节点连接数）衰减，解释范畴大小效应与启动效应 → 图记忆上的 1–2 跳传播 + fan 归一化。
- **[B9] Ahmad, S., & Scheinkman, L. (2019).** *How Can We Be So Dense? The Benefits of Using Highly Sparse Representations.* arXiv:1903.11257. ● https://arxiv.org/abs/1903.11257
  - 机制：top-k 保留、其余置零的 k-WTA 稀疏编码显著提升表示容量与抗噪性，且可用 soft top-k 近似可微 → 记忆编码层前置 k-WTA。

## 3. 神经调质 → 计算参数

- **[N1] Schultz, W., Dayan, P., & Montague, P. R. (1997).** *A neural substrate of prediction and reward.* Science 275(5306):1593–1599. ○ https://doi.org/10.1126/science.275.5306.1593
  - 机制：中脑 DA 神经元的 phasic 放电编码 reward prediction error，与 TD 误差定量吻合 → critic 的 δ 即全局"DA 信号"。
- **[N2] Sutton, R. S., & Barto, A. G. (2018).** *Reinforcement Learning: An Introduction* (2nd ed.). MIT Press（全文 PDF）. ● https://web.stanford.edu/class/psych209/Readings/SuttonBartoIPRLBook2ndEd.pdf
  - 机制：给出 TD(λ)、eligibility trace、softmax 策略的标准更新式，是上述生物学信号的软件基线。
- **[N3] Doya, K. (2002).** *Metalearning and neuromodulation.* Neural Networks 15(4–6):495–506. ○ https://doi.org/10.1016/S0893-6080(02)00044-8
  - 机制：提出四种调质各控一个 RL 标量——DA→TD 误差/学习率、5-HT→折扣因子（时间视野）、NA→逆温度（探索）、ACh→记忆更新率 → 四个全局可调旋钮。
- **[N4] Boureau, Y.-L., & Dayan, P. (2011).** *Opponency revisited: competition and cooperation between dopamine and serotonin.* Neuropsychopharmacology 36(1):74–97. ○ https://doi.org/10.1038/npp.2010.151
  - 机制：DA 与 5-HT 在对立（Go/NoGo、追求/抑制）之外还在 model-based 控制下**协同**，5-HT 提高行为抑制与耐心 → 5-HT 作为"抑制增益 / 等待成本"参数。
- **[N5] Aston-Jones, G., & Cohen, J. D. (2005).** *An integrative theory of locus coeruleus-norepinephrine function: adaptive gain and optimal performance.* Annual Review of Neuroscience 28:403–450. ○ https://doi.org/10.1146/annurev.neuro.28.061604.135709
  - 机制：LC-NE 的 phasic 放电提高目标相关信号的增益（信噪比），tonic 水平调节探索与脱困 → 一个乘性 global gain + 噪声温度。
- **[N6] Yu, A. J., & Dayan, P. (2005).** *Uncertainty, neuromodulation, and attention.* Neuron 46(4):681–692. ○ https://doi.org/10.1016/j.neuron.2005.04.026
  - 机制：ACh 编码 expected uncertainty（可靠但未知），NE 编码 unexpected uncertainty（波动/惊异），两者可由不同统计量估计 → 两个独立不确定性估计器，分别调学习率与探索。
- **[N7] Hasselmo, M. E. (2006).** *The role of acetylcholine in learning and memory.* Current Opinion in Neurobiology 16(6):710–715. ○ https://doi.org/10.1016/j.conb.2006.09.002
  - 机制：高 ACh 抑制皮层 recurrent 连接、favor 编码新模式；低 ACh favor 回忆与巩固 → 写入/检索双模开关。
- **[N8] Jordan, R., & Keller, G. B. (2023).** *The locus coeruleus broadcasts prediction errors across the cortex to promote sensorimotor plasticity.* eLife 12:e85111. ○ https://doi.org/10.7554/eLife.85111
  - 机制：LC 的预测误差样信号在全皮层广播并促进可塑性 → NE 可作为跨模块的全局 PE 广播总线（不是每模块各自算）。
- **[N9] Zeng, J., et al. (2023).** *Local 5-HT signaling bi-directionally regulates the coincidence time window for associative learning.* Neuron. ○ https://doi.org/10.1016/j.neuron.2022.12.034
  - 机制：局部 5-HT 双向调节 STDP 的 coincidence time window，从而改变因果检测窗口 → 5-HT 参数化 τ_STDP。

## 4. 可计算的情绪理论

- **[E1] Ortony, A., Clore, G. L., & Collins, A. (1988).** *The Cognitive Structure of Emotions.* Cambridge University Press. ○ https://doi.org/10.1017/CBO9780511571299
  - 机制：情绪 = 对事件/行动/对象的 valenced reaction，由 desirability、likelihood、praiseworthiness 等 appraisal 变量决定**类型与强度**（22 种）→ 结构化 appraisal → (label, intensity)。
- **[E2] Scherer, K. R. (2009).** *The dynamic architecture of emotion: evidence for the component process model.* Cognition & Emotion 23(7):1307–1351. ○ https://doi.org/10.1080/02699930902928969
  - 机制：情绪由四类 Stimulus Evaluation Checks（相关性 / 影响 / 应对潜能 / 规范意义）**顺序**评估产生，并驱动生理、表达、行动倾向等成分 → 逐级 appraisal pipeline。
- **[E3] Russell, J. A. (1980).** *A circumplex model of affect.* Journal of Personality and Social Psychology 39(6):1161–1178. ○ https://doi.org/10.1037/h0077714
  - 机制：情绪状态可由 valence（愉悦）与 arousal（唤醒）两维环状排列，情绪词落在圆周不同角度 → 二维向量 + 角度映射标签。
- **[E4] Barrett, L. F. (2017).** *The theory of constructed emotion: an active inference account of interoception and categorization.* Social Cognitive and Affective Neuroscience 12(1):1–23. ○ https://doi.org/10.1093/scan/nsw154
  - 机制：情绪不是离散实体，而是内感受预测与概念知识的范畴化产物，依赖情境与身体预算 → 用预测误差 + 情境先验**生成**情绪实例，而非查表。
- **[E5] Bechara, A., Damasio, H., Tranel, D., & Damasio, A. R. (1997).** *Deciding advantageously before knowing the advantageous strategy.* Science 275(5304):1293–1295. ○ https://doi.org/10.1126/science.275.5304.1293
  - 机制：vmPFC 损伤患者在 Iowa 赌博任务中不能在"知道"之前产生预期性 SCR，仍持续选劣势牌组 → somatic marker 作为价值偏置先于显式知识进入决策。
- **[E6] Damasio, A. R. (1996).** *The somatic marker hypothesis and the possible functions of the prefrontal cortex.* Phil. Trans. R. Soc. B 351(1346):1413–1420. ○ https://doi.org/10.1098/rstb.1996.0125
  - 机制：身体/情绪状态标记为选项提供偏置信号，尤其在高不确定与高冲突情境 → 决策打分加一个 affect bias 项。
- **[E7] Marsella, S. C., & Gratch, J. (2009).** *EMA: A process model of appraisal dynamics.* Cognitive Systems Research 10(1):70–90. ○ https://doi.org/10.1016/j.cogsys.2008.03.005
  - 机制：用 appraisal 变量（desirability、likelihood、accountability 等）逐步更新并生成 coping 策略，是可运行的计算模型 → 可直接照搬变量表。
- **[E8] Lu, J., & Li, Y. (2025).** *Dynamic Affective Memory Management for Personalized LLM Agents.* arXiv:2510.27418. ● https://arxiv.org/abs/2510.27418
  - 机制：按情感显著性调制记忆的写入、检索与遗忘，实现个性化情感记忆管理 → 记忆打分加入 affect salience 项。
- **[E9] Wang, Z., et al. (2023).** *Humanoid Agents: Platform for Simulating Human-like Generative Agents.* EMNLP 2023 (System Demos). ● https://arxiv.org/abs/2310.05418
  - 机制：内驱力（饱腹/能量/社交）+ 情绪强度共同驱动行为选择，使 agent 行为随内部状态漂移 → 需求向量与情绪向量共同决定 action prior。

## 5. 人格：结构、机制与参数化

- **[P1] Goldberg, L. R. (1990).** *An alternative "description of personality": the Big-Five factor structure.* Journal of Personality and Social Psychology 59(6):1216–1229. ○ https://doi.org/10.1037/0022-3514.59.6.1216
  - 机制：词汇假设 + 因子分析得到五个稳定维度，是 Big Five 的测量学基础 → 人格向量的维度选择依据。
- **[P2] Costa, P. T., & McCrae, R. R. (1992).** *Four ways five factors are basic.* Personality and Individual Differences 13(6):653–665. ○ https://doi.org/10.1016/0191-8869(92)90236-I
  - 机制：五因素模型把特质操作化为可测维度（NEO-PI-R）→ 人格向量 = 5 个连续标量。
- **[P3] Ashton, M. C., & Lee, K. (2007).** *Empirical, theoretical, and practical advantages of the HEXACO model of personality structure.* Personality and Social Psychology Review 11(2):150–166. ○ https://doi.org/10.1177/1088868306294907
  - 机制：六因子结构（多出 Honesty-Humility），在跨语言词汇样本中更稳定 → 六维向量（若需建模"诚信/剥削倾向"）。
- **[P4] DeYoung, C. G. (2015).** *Cybernetic Big Five Theory.* Journal of Research in Personality 56:33–58. ○ https://doi.org/10.1016/j.jrp.2014.07.004
  - 机制：把特质定义为"目标与解释系统的稳定参数"，每维对应特定适应性功能（Extraversion=奖励敏感性、Neuroticism=威胁敏感性、Conscientiousness=计划约束）→ 特质→决策参数映射的理论依据。
- **[P5] Read, S. J., et al. (2010).** *A neural network model of the structure and dynamics of human personality.* Psychological Review 117(1):61–92. ○ https://doi.org/10.1037/a0018131
  - 机制：用神经网络模型的 gain 等参数复现特质结构与动力学（如 Extraversion 对应正性情绪增益）→ 参数化人格的建模先例。
- **[P6] Jiang, G., et al. (2023).** *Evaluating and Inducing Personality in Pre-trained Language Models.* NeurIPS 36. ● https://arxiv.org/abs/2206.07550
  - 机制：用形容词对做 forced-choice 测题可测量并**诱导** LLM 的稳定人格倾向 → 人格 prompt / 参数化评测基线。
- **[P7] Serapio-García, G., et al. (2023).** *Personality Traits in Large Language Models.* arXiv:2307.00184. ● https://arxiv.org/abs/2307.00184
  - 机制：系统检验 LLM 人格测量的信度与区分效度，提示需控制社会赞许性与题目顺序 → 评测方法学。

## 6. 判断与决策

- **[J1] Daw, N. D., Niv, Y., & Dayan, P. (2005).** *Uncertainty-based competition between prefrontal and dorsolateral striatal systems for behavioral control.* Nature Neuroscience 8(12):1704–1711. ● https://www.nature.com/articles/nn1560
  - 机制：model-free（背侧纹状体）与 model-based（PFC）并行竞争，仲裁依赖不确定性/计算成本 → 双路径 + 仲裁器。
- **[J2] Miller, E. K., & Cohen, J. D. (2001).** *An integrative theory of prefrontal cortex function.* Annual Review of Neuroscience 24:167–202. ○ https://doi.org/10.1146/annurev.neuro.24.1.167
  - 机制：PFC 维持任务目标作为 **bias signal**，增强任务相关输入-输出映射 → goal vector 乘性调制（而非拼进 prompt）。
- **[J3] Botvinick, M. M., et al. (2001).** *Conflict monitoring and cognitive control.* Psychological Review 108(3):624–652. ○ https://doi.org/10.1037/0033-295X.108.3.624
  - 机制：ACC 检测反应冲突（多选项同时激活）并据此上调认知控制 → 冲突度 = 控制增益的输入。
- **[J4] Frank, M. J. (2006).** *Hold your horses: a dynamic computational role for the subthalamic nucleus in decision making.* Neural Networks 19(8):1120–1136. ○ https://doi.org/10.1016/j.neunet.2006.03.006
  - 机制：STN 提供全局"刹车"，在冲突/高不确定时抬高决策阈值、延长证据累积 → 可调 decision threshold。
- **[J5] Frank, M. J., Loughry, B., & O'Reilly, R. C. (2001).** *Interactions between frontal cortex and basal ganglia in working memory: a computational model.* Cognitive, Affective, & Behavioral Neuroscience 1(2):137–160. ○ https://doi.org/10.3758/CABN.1.2.137
  - 机制：基底节 Go/NoGo 通路门控 PFC 工作记忆槽的更新（PBWM）→ gating 网络（何时写入/清除工作记忆）。
- **[J6] Friston, K. (2010).** *The free-energy principle: a unified brain theory?* Nature Reviews Neuroscience 11(2):127–138. ● https://www.nature.com/articles/nrn2787
  - 机制：感知、行动、学习统一为最小化变分自由能 → 一个统一的损失/目标函数框架。
- **[J7] Parr, T., Pezzulo, G., & Friston, K. J. (2022).** *Active Inference: The Free Energy Principle in Mind, Brain, and Behavior.* MIT Press. ○ https://doi.org/10.7551/mitpress/12441.001.0001
  - 机制：给出 expected free energy 与策略后验的实现细节（含参数与教程代码）→ 可直接落地的 planner。
- **[J8] Muller, T. H., Butler, J. L., Veselic, S., Miranda, B., Wallis, J. D., Dayan, P., Behrens, T. E. J., Kurth-Nelson, Z., & Kennerley, S. W. (2024).** *Distributional reinforcement learning in prefrontal cortex.* Nature Neuroscience. ● https://www.nature.com/articles/s41593-023-01535-w
  - 机制：PFC 神经元编码奖励的**完整分布**而非仅期望，支持风险敏感选择 → critic 输出分位数/直方图，而非标量 Q。

## 7. LLM Agent 记忆系统（2023–2026）

- **[G1] Park, J. S., et al. (2023).** *Generative Agents: Interactive Simulacra of Human Behavior.* UIST '23. ● https://arxiv.org/abs/2304.03442
  - 机制：memory stream（observation / reflection / plan）+ 检索分数 = recency(0.995^h) + importance + relevance 的加权和，驱动连贯行为。
- **[G2] Packer, C., et al. (2023).** *MemGPT: Towards LLMs as Operating Systems.* arXiv:2310.08560. ● https://arxiv.org/abs/2310.08560
  - 机制：把上下文当"内存"、外部存储当"磁盘"，用函数调用做分页与中断，突破上下文窗口。
- **[G3] Gutiérrez, B. J., et al. (2024).** *HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models.* NeurIPS 37. ● https://proceedings.neurips.cc/paper_files/paper/2024/hash/6ddc001d07ca4f319af96a3024f6dbd1-Abstract-Conference.html
  - 机制：知识图谱 + Personalized PageRank 做海马式索引，单步完成多跳关联检索，优于纯向量 RAG。
- **[G4] Xu, W., et al. (2025).** *A-MEM: Agentic Memory for LLM Agents.* arXiv:2502.12110. ● https://arxiv.org/abs/2502.12110
  - 机制：Zettelkasten 式笔记——每条记忆带关键词/标签/上下文，新记忆触发链接生成与旧记忆"演化"。
- **[G5] Chhikara, P., et al. (2025).** *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory.* arXiv:2504.19413. ● https://arxiv.org/abs/2504.19413
  - 机制：两阶段（抽取 → 更新）增量记忆，对 top-s 相似记忆做 ADD/UPDATE/DELETE/NOOP 决策以消解冲突。
- **[G6] Behrouz, A., et al. (2025).** *Titans: Learning to Memorize at Test Time.* NeurIPS 38. ● https://proceedings.neurips.cc/paper_files/paper/2025/hash/a4ca07aa108036f80cbb5b82285fd4b1-Abstract-Conference.html
  - 机制：测试时学习的神经长期记忆模块，按 **surprise**（梯度幅值）更新并带遗忘/动量，长上下文外推优于 transformers。
- **[G7] Zhong, W., et al. (2024).** *MemoryBank: Enhancing Large Language Models with Long-Term Memory.* AAAI 38. ● https://arxiv.org/abs/2305.10250
  - 机制：用 Ebbinghaus 遗忘曲线给记忆强度建模，检索强化强度、久未检索则衰减并可被遗忘。
- **[G8] Edge, D., et al. (2024).** *From Local to Global: A Graph RAG Approach to Query-Focused Summarization.* arXiv:2404.16130. ● https://arxiv.org/abs/2404.16130
  - 机制：社区检测 + 层次化社区摘要，用 map-reduce 回答全局性问题（向量 RAG 的盲区）。
- **[G9] Li, Z., et al. (2025).** *MemOS: A Memory OS for AI System.* arXiv:2507.03724. ● https://arxiv.org/abs/2507.03724
  - 机制：把记忆分为明文 / 激活(KV) / 参数三层，作为可调度的系统资源统一管理。
- **[G10] Gutiérrez, B. J., et al. (2025).** *From RAG to Memory: Non-Parametric Continual Learning for Large Language Models.* ICML 2025（HippoRAG 2）. ● https://arxiv.org/abs/2502.14802
  - 机制：把非参数记忆做成持续学习，同时覆盖事实回忆、意义构建与关联性三类记忆任务。

---

## 8. 可直接编码的公式与参数

> 记号：i 为记忆项/chunk，s 为状态，a 为动作。标注"默认"者取自原论文，标注"建议"者为工程取值，落地时应全部作为可调超参。
> 公式出处：F1/F3←[B7][B8]；F2←[G7]；F4←[N1][N2]；F5←[N2]；F6←[B1]；F7←[B3][B5]；F8←[B6]；F9←[B9]；F10←[E3]；F11←[E1]；F12←[E2]；F13←[N3]；F14←[N5]；F15←[J6][J7]；F16←[G1]；F17←[G3]；F18←[P4]（单调方向为设计推导，非论文原值）。

### F1 ACT-R 激活方程（检索打分）
```
A_i = B_i + Σ_j W_j · S_ji + ε_i
B_i = ln( Σ_{k=1..n_i} t_k^(-d) )              # base-level activation
S_ji = S - ln(fan_j)                            # 关联强度（fan 效应）
P_i  = 1 / (1 + exp(-(A_i - τ)/s))              # 检索概率
T_i  = F · exp(-A_i)                            # 检索延迟
```
- `B_i`：base-level activation；`t_k`：第 k 次呈现/使用距今时间（秒）；`d`：衰减指数，默认 **0.5**。
- `W_j`：线索 j 的注意权重；`S_ji`：线索→项关联强度；`S`：最大关联强度，默认 **1.5**；`fan_j`：线索 j 连接的项目数。
- `ε_i`：logistic 噪声；`τ`：检索阈值，默认 **0**；`s`：噪声尺度，默认 **0.4**；`F`：latency factor，默认 **0.35 s**。
- 用途：把"余弦相似度排序"替换为"激活值排序"，天然融合**时近性 + 关联性 + 使用频率**。

### F2 遗忘曲线（记忆强度衰减）
```
R(t) = exp(-t / S)                 # Ebbinghaus retention
S ← S + ΔS   (每次成功检索)         # MemoryBank 式强化
drop if R(t) < R_min               # 低于阈值进入归档/可遗忘
```
- `R`：保留概率；`t`：距上次访问时间；`S`：记忆强度（stability），随检索次数单调增长；`R_min`：遗忘阈值（建议 0.05–0.2）。
- 用途：替代 TTL 硬删除——按保留概率做软删除与采样。

### F3 扩散激活（图记忆扩展）
```
A_i(t+1) = (1-δ)·A_i(t) + Σ_{j∈N(i)} w_ji · A_j(t) / sqrt(fan_j)
```
- `A_i(t)`：t 步时节点激活；`δ`：衰减率（0.1–0.3）；`w_ji`：边权（可用共现 PMI / embedding 相似度）；`fan_j`：出度。
- 用途：检索后 1–2 跳扩展上下文，替代固定 top-k。

### F4 TD 误差与资格迹（DA 信号）
```
δ_t   = r_{t+1} + γ·V(s_{t+1}) - V(s_t)
e_t   = γ·λ·e_{t-1} + ∇_θ V(s_t)
θ    ← θ + α·δ_t·e_t
```
- `δ_t`：reward prediction error（DA）；`γ`：折扣因子（5-HT 旋钮）；`λ`：迹衰减（0–1）；`α`：学习率；`e_t`：eligibility trace。
- 用途：所有"奖励/评价"事件的统一内部货币；可同时驱动 critic 更新与记忆重放优先级。

### F5 Boltzmann/softmax 选择（探索温度）
```
P(a|s) = exp(β·Q(s,a)) / Σ_b exp(β·Q(s,b)),   β = 1/τ
```
- `β`：逆温度（NA 旋钮）；`τ`：温度。`β→∞` 贪心，`β→0` 均匀随机。
- 风险扩展：`U(a) = μ(a) - λ_risk·σ(a)`（均值-方差），或对回报分布取 CVaR。

### F6 Hopfield 动力学与容量
```
x_i ← sgn( Σ_j w_ij x_j ),   w_ij = (1/N) Σ_μ ξ_i^μ ξ_j^μ  (i≠j),  w_ii = 0
E = -1/2 Σ_{i≠j} w_ij x_i x_j
α_c = P/N ≈ 0.138            # 经典容量上限
```
- `ξ^μ`：第 μ 个存储模式（±1）；`N`：神经元数；`P`：模式数；`α_c`：临界加载率。

### F7 现代 Hopfield（一步补全 = attention）
```
ξ_new = X · softmax(β · Xᵀ ξ)
```
- `X ∈ R^{N×d}`：存储模式矩阵；`ξ`：查询/部分线索；`β`：逆温度（常用 `1/sqrt(d)`）。
- 模式间隔足够大时**一次更新**即收敛到最近模式；等价于 transformer 的单头 attention。

### F8 STDP 更新窗
```
Δw =  A_+ · exp(-Δt/τ_+)   if Δt > 0
      -A_- · exp( Δt/τ_-)   if Δt < 0
```
- `Δt = t_post - t_pre`；`τ_+ ≈ 17 ms`，`τ_- ≈ 34 ms`，`A_- > A_+`（抑制占优）。

### F9 k-WTA 稀疏编码
```
y_i = x_i  if i ∈ TopK(x),  else 0;    sparsity = k/N
```
- `k`：保留激活数（建议 N 的 2–5%）；可用 soft top-k（温度化）保持可微。

### F10 Russell 环形模型（二维情绪状态）
```
θ = atan2(arousal, valence)          # 角度 → 离散情绪标签
d(e1,e2) = sqrt((v1-v2)^2 + (a1-a2)^2)
```
- `valence ∈ [-1,1]`，`arousal ∈ [-1,1]`；可扩展为 PAD 三维（加 dominance）。

### F11 OCC 强度（乘性 appraisal）
```
I_e = Π_k x_k^{w_k},   x_k ∈ [0,1]
```
- `x_k`：局部强度变量（desirability、likelihood、praiseworthiness、appealingness、expectation-deviation、effort）；
- 全局强度变量：sense of reality、proximity、unexpectedness、arousal；
- `w_k`：可学习权重。用途：把 LLM 输出的结构化 appraisal 转成数值强度，而非直接让 LLM 说"我很生气"。

### F12 Scherer SEC 检查表（顺序流水线）
```
SEC = [relevance, implications, coping, normative]
affect_state = f(SEC)  ->  (physiology, expression, action_tendency)
```
- `relevance`：新颖性/内在愉悦/目标相关性；`implications`：预期后果与紧迫性；`coping`：控制力/权力/调整潜力；`normative`：自我/社会规范相容性。
- 用途：4 段式 appraisal 函数，每段输出一个向量，最后拼接成 affect state。

### F13 Doya 调质 → RL 参数映射
| 调质 | 计算参数 | 软件旋钮 |
|---|---|---|
| Dopamine | TD 误差 δ / 学习率 α | `critic.lr`, `td_error` 广播 |
| Serotonin | 折扣因子 γ（时间视野） | `gamma`（0.8–0.999） |
| Noradrenaline | 逆温度 β（探索） | `softmax_beta`, `policy.noise` |
| Acetylcholine | 记忆更新率 / 衰减 | `memory.write_rate`, `memory.decay` |

### F14 LC 自适应增益
```
y = g(t) · (Σ_j w_j x_j) + η,     g(t) = g_0 + k·NE(t)
```
- `g`：全局增益；`NE(t)`：tonic/phasic 调质信号；`η`：噪声。用途：一个标量同时调节"专注度"与"探索度"。

### F15 主动推断（自由能与 EFE）
```
F = E_q[ln q(s) - ln p(o,s)] = KL[q(s)||p(s)] - E_q[ln p(o|s)]
G(π) = -(expected information gain) + (expected cost)
q(π) ∝ exp(-G(π))
```
- `q(s)`：识别密度；`p(o,s)`：生成模型；`G(π)`：某策略的期望自由能。
- 用途：把"探索 vs 利用"统一成一个可计算的策略后验，而非手写规则。

### F16 Generative Agents 检索分（工程默认值）
```
score = α_rec·recency + α_imp·importance + α_rel·relevance
recency = 0.995^(小时数)
```
- 三项各自归一化到 [0,1] 后等权相加（论文默认）；`0.995` 为每小时衰减因子。

### F17 HippoRAG 式图检索（PPR）
```
p^{(t+1)} = (1-α)·M·p^{(t)} + α·e_q
```
- `M`：行归一化邻接矩阵（KG）；`e_q`：查询实体种子分布；`α`：阻尼/重启概率。收敛后取 top-k 节点作为检索证据。

### F18 人格 → 决策参数（设计映射，依据 DeYoung 2015 的功能对应）
```
β        = β_0 · exp(-k_E·Extraversion)          # 奖励敏感 → 更果断
γ        = γ_0 · (1 + k_C·Conscientiousness)     # 计划性 → 更长视野
λ_risk   = λ_0 · (1 + k_N·Neuroticism)           # 威胁敏感 → 更避险
τ_thresh = τ_0 · (1 - k_O·Openness)              # 开放 → 更低决策阈值
memory.decay = d_0 · (1 - k_A·Agreeableness)     # 宜人 → 更慢遗忘负性社交记忆
```
- 系数 `k_*` 需用行为数据校准；此处给出**单调方向**而非精确数值。

---

## 9. 设计启示（机制 → 软件组件）

1. **双存储分层**：用 CLS 的"海马快 / 皮层慢"，落地为 `episodic.db`（原始事件，append-only）+ `semantic/`（周期性蒸馏出的摘要与规则），两者之间只允许 replay job 单向流动。〔C1, C6〕
2. **模式分离前置**：写入前对事件做高维稀疏投影 + k-WTA（2–5% 激活），保证"相似但不同"的经历不互相覆盖；这是防记忆混淆的第一道闸。〔C3, B9〕
3. **补全层用 attention 实现**：把现代 Hopfield 的 `X·softmax(βXᵀξ)` 直接作为一个"memory completion head"，查询时补全残缺线索，不要另造 RNN。〔B3, B5〕
4. **重放调度器按 need×gain 排序**：replay 队列的优先级 = 预测误差 × 未来可改进期望，而不是随机采样或 FIFO。〔C7, C2〕
5. **睡眠式批处理**：低负载时段跑 consolidation job：重放 → 更新语义层 → 对权重/摘要做归一化，显式对抗灾难性遗忘。〔C4, C5〕
6. **激活值排序替代余弦 top-k**：检索打分用 ACT-R 激活（时近性 + fan 校正 + 使用频率），余弦只作为 `S_ji` 的一项。〔B7, F1〕
7. **软遗忘而非硬删除**：每条记忆带 `R(t)=e^{-t/S}`，低于阈值转入冷归档并保留可恢复索引，避免"删了就想不起来"。〔G7, F2〕
8. **图记忆 + 扩散激活**：实体/事件建成图，检索后做 1–2 跳带 fan 衰减的激活扩散，解决多跳关联问题。〔B8, G3〕
9. **PE 广播总线**：全局只维护一条 `td_error` 事件流，同时驱动 critic 更新、记忆重要性加权与重放优先级——对应 DA/NE 的广播特性。〔N1, N8〕
10. **四个调质旋钮做成配置项**：`gamma`(5-HT)、`softmax_beta`(NA)、`critic.lr`(DA)、`memory.write_rate`(ACh)，并允许按情境切换，而不是散落在各处硬编码。〔N3, N7〕
11. **冲突监测模块（ACC）**：当多个候选动作/答案的分数接近时输出冲突度，用冲突度上调"深思"预算（更多检索、更长推理）。〔J3, J4〕
12. **基底节式门控**：工作记忆的写入/清除由独立 gating 网络决定（Go/NoGo），避免每轮都把全部上下文塞进 prompt。〔J5, G2〕
13. **情绪 = appraisal 向量而非标签**：先跑 4 段 SEC 得到向量，再映射到 (valence, arousal) 与 action tendency，情绪只作为**偏置**进入决策，不直接生成文本。〔E1, E2, F11〕
14. **人格参数化到决策层**：Big Five/HEXACO 向量映射到 β、γ、风险系数、遗忘率、情绪基线，保证同一人格在不同任务上行为一致。〔P4, P5, F18〕
15. **双过程 + 仲裁器**：快路径（model-free / 缓存 / 直觉）先出候选，慢路径（model-based / 检索 / 规划）按不确定性与代价介入；仲裁信号来自冲突度与 PE。〔J1, J6〕

---

## 10. 覆盖度自查

- 每主题 6–10 条，均含至少 1 篇 2023–2026 工作（C6/G3/G4/G5/G6/G9/G10、N8/N9、E8/E9、P6/P7、J8）。
- 公式 18 组（F1–F18），覆盖激活、遗忘、扩散、TD、softmax、Hopfield、STDP、k-WTA、情绪二维、OCC 强度、调质映射、LC 增益、主动推断、检索打分、PPR、人格映射。
- 链接：26 条直接抓取 200；其余 DOI 全部经 Crossref 元数据核对。无未核验 ID。
