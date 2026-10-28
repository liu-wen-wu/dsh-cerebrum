# 记忆的遗忘与持久性 · 文献与公式（v3）

> 目的：为 `lib/core/retention.js` 与 `memory.js` 的保持/复习模型提供可核验的依据。
> 核验：2026-10-28。DOI 均经 `api.crossref.org/works/{DOI}` 核对题名与年份；未核验的只写书名/卷期，不给 DOI。
> 记号：`t` 距上次复习天数，`S` 稳定性（天），`R` 保有率，`D` 难度（0..1）。

---

## 1. 遗忘曲线的形态：指数还是幂律

**Ebbinghaus (1885/1913)** *Über das Gedächtnis / Memory: A Contribution to Experimental Psychology.*
最早的保持曲线：机械音节学习后，20 分钟、1 小时、9 天、31 天的保持率依次下降，形状先陡后平。原文没有给出解析式，"指数衰减"是后人的拟合选择。

- **Wixted, J. P., & Ebbesen, E. B. (1991).** *On the Form of Forgetting.* Psychological Science 2(6):409–415. ● https://doi.org/10.1111/j.1467-9280.1991.tb00175.x
  - 机制：对多组数据做模型比较，**幂函数** `R = a(t+1)^−b` 优于指数；指数在长延迟端下降过快。
- **Anderson, J. R., & Schooler, L. J. (1991).** *Reflections of the Environment in Memory.* Psychological Science 2(6):396–408. ● https://doi.org/10.1111/j.1467-9280.1991.tb00174.x
  - 机制：环境事件的统计结构本身近似幂律，记忆的"理性"衰减应与之一致；ACT-R 的基线激活 `B = ln Σ t_j^−d` 就是这一族。
- **Rubin, D. C., & Wenzel, A. E. (1996).** *One Hundred Years of Forgetting: A Quantitative Description of Retention.* Psychological Review 103(4):734–760. ● https://doi.org/10.1037/0033-295X.103.4.734
  - 机制：比较 200+ 数据集，幂函数与指数-幂混合拟合最好；单一指数几乎总被拒绝。

**实现取值**：`R(t,S) = (1 + (19/81)·t/S)^(−0.5)`（FSRS 形式，见 §2）。在 `t=S` 时 `R≈0.9`，所以 `S` 可直接读作"90% 保持期"。

---

## 2. 现代间隔重复模型：S（稳定性）与 D（难度）

- **Settles, B., & Meeder, B. (2016).** *A Trainable Spaced Repetition Model for Language Learning.* ACL 2016. ● https://doi.org/10.18653/v1/P16-1174
  - 机制：Half-Life Regression `p = 2^(−Δ/h_θ)`，`h_θ = 2^(θ·x)` 由特征（历史正确率、词频等）学习；用 log-loss 训练。可编码为：对新记忆给 `h₀`，每次复习按 `h ← h·γ` 更新。
- **Mozer, M. C., & Lindsey, R. V. (2014).** *Improving Students' Long-Term Knowledge Retention Through Personalized Review.* Psychological Science 25(3):639–647. ● https://doi.org/10.1177/0956797613504302
  - 机制：DSTM（Differential Stability Model）用"记忆强度 + 时间"预测 recall，并按个体拟合复习间隔；强调**间隔应随掌握程度变化**而不是固定日程。
- **FSRS（Free Spaced Repetition Scheduler）** 的公开模型（开源实现，非单篇论文）：
  ```
  R(t,S) = (1 + F·t/S)^(−0.5),   F = 19/81
  S' = S · (1 + e^{w8}·(11−D)·S^(−w9)·(e^{w10·(1−R)}−1))
  ```
  其中 `(1−R)` 项表达"提取越费劲，收益越大"。本实现采用其简化形式：
  ```
  S' = S · (1 + 1.2·(1−R)) · (1 + 0.4·(1−D))
  ```
  失败：`S' = max(0.5, 0.4·S)`，`D' = D + 0.15`。

**为什么用 `S` 而不是半衰期**：半衰期只描述单条曲线；`S` 是可被复习改变的**状态变量**，能把"越用越牢"与"越久越淡"放进同一个模型，也才能表达持久记忆。

---

## 3. 间隔效应与测试效应

- **Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006).** *Distributed Practice in Verbal Recall Tasks: A Review and Quantitative Synthesis.* Psychological Bulletin 132(3):354–380. ● https://doi.org/10.1037/0033-2909.132.3.354
  - 机制：间隔复习优于集中复习；最优间隔随保持期增长（约保持期的 10–20%）。可编码：`S` 增益随 `1−R` 增大。
- **Roediger, H. L., & Karpicke, J. D. (2006).** *Test-Enhanced Learning.* Psychological Science 17(3):249–255. ● https://doi.org/10.1111/j.1467-9280.2006.01693.x
  - 机制：**提取练习**（测试）比重复阅读更能带来长期保持，即使短期感觉更差。可编码：只有"成功检索"才大幅提升 `S`，被动重读（prompt 注入）不强化。
- **Bjork, R. A., & Bjork, E. L. (2011).** *Making Things Hard on Yourself, But in a Good Way: Creating Desirable Difficulties to Enhance Learning.* 书中章节（无 DOI）。
  - 机制：合意困难（间隔、交错、提取）提高长期保持；流畅感≠学习。

**本实现**：`prompt` 注入的记忆以 `reinforce:false` 读取（重读不强化）；工具检索才触发 `_rehearse`，且 `(1−R)` 决定增益。

---

## 4. 持久记忆：permastore、系统巩固、突触标记

- **Bahrick, H. P. (1984).** *Semantic Memory Content in Permastore: Fifty Years of Memory for Spanish Learned in School.* Journal of Experimental Psychology: General 113(1):1–29. ● https://doi.org/10.1037/0096-3445.113.1.1
  - 机制：50 年后仍保留可观的西班牙语知识；保持曲线存在**长期渐近线**（permastore），不是归零。可编码：高 `S` 的幂律长尾 + `S` 下限。
- **Squire, L. R., & Alvarez, P. (1995).** *Retrograde amnesia and memory consolidation: A neurobiological perspective.* Current Opinion in Neurobiology 5(2):169–177. ● https://doi.org/10.1016/0959-4388(95)80023-9
  - 机制：海马依赖的记忆随时间转为皮层依赖；系统巩固的时间尺度是周–年。可编码：`consolidate` 后 `S×2`、schema 记忆进入 permastore。
- **Frey, U., & Morris, R. G. M. (1997).** *Synaptic tagging and long-term potentiation.* Nature 385:533–536. ● https://doi.org/10.1038/385533a0
- **Redondo, R. L., & Morris, R. G. M. (2010).** *Making memories last: the synaptic tagging and capture hypothesis.* Nature Reviews Neuroscience 11:17–30. ● https://doi.org/10.1038/nrn2963
  - 机制：弱刺激只能产生短时程可塑性，但若在同一时间窗内出现强刺激（"标记"），弱记忆可被"捕获"进长时程存储。可编码：强事件 `salience ≥ 0.7` 对 ±90 min 内弱记忆 `S` 加成。
- **Nader, K., Schafe, G. E., & LeDoux, J. E. (2000).** *Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval.* Nature 406:722–726. ● https://doi.org/10.1038/35021052
  - 机制：提取会让记忆进入不稳定状态，需要重新巩固；这给了"再巩固更新"以生物学依据。
- **Dudai, Y. (2004).** *The Neurobiology of Consolidations, Or, How Stable is the Engram?* Annual Review of Psychology 55:51–86. ● https://doi.org/10.1146/annurev.psych.55.090902.142050
  - 机制：巩固不是一次性事件，而是持续的、系统与突触多层次的稳定化过程。

---

## 5. 干扰：遗忘的另一个主因

- **Wixted, J. T. (2004).** *The Psychology and Neuroscience of Forgetting.* Annual Review of Psychology 55:235–269. ● https://doi.org/10.1146/annurev.psych.55.090902.141555
  - 机制：大量证据支持**干扰**而非被动衰退：相似的新学习会覆盖旧提取线索（倒摄干扰），旧学习也会妨碍新学习（前摄干扰）。可编码：新记忆与旧记忆相似时降低旧 `S`；schema 记忆受保护。

**本实现**：`cos > 0.55` 时旧记忆 `S ×= 1 − 0.15·cos`；`schema` 免疫。这是"为什么旧细节会消失"的直接机制，而不是时间到了。

---

## 6. 情绪、生动度与"记得很清楚"的错觉

- **McGaugh, J. L. (2004).** *The Amygdala Modulates the Consolidation of Memories of Emotionally Arousing Experiences.* Annual Review of Neuroscience 27:1–28. ● https://doi.org/10.1146/annurev.neuro.27.070203.144157
  - 机制：杏仁核在编码后调节海马与皮层的巩固，情绪唤醒提高记忆强度（倒 U 形）。
- **Brown, R., & Kulik, J. (1977).** *Flashbulb memories.* Cognition 5(1):73–99. ● https://doi.org/10.1016/0010-0277(77)90018-X
  - 机制：高惊讶、高后果的事件留下"闪光灯"式记忆，主观生动度极高。
- **Talarico, J. M., & Rubin, D. C. (2003).** *Confidence, Not Consistency, Characterizes Flashbulb Memories.* Psychological Science 14(5):455–461. ● https://doi.org/10.1111/1467-9280.02453
  - 机制：闪光灯记忆的**自信**很稳定，但**准确性**会随时间下降。可编码：`vividness` 影响置信展示，但要提示"主观生动 ≠ 客观准确"。

---

## 7. 编码特异性与加工深度

- **Tulving, E., & Thomson, D. M. (1973).** *Encoding specificity and retrieval processes in episodic memory.* Psychological Review 80(5):352–373. ● https://doi.org/10.1037/h0020071
  - 机制：提取效果取决于线索与编码时情境的匹配；弱线索取不回旧记忆，强线索可以。可编码：`R` 低时提高线索门槛（`sim/spread` 要求）。
- **Craik, F. I. M., & Lockhart, R. S. (1972).** *Levels of processing: A framework for memory research.* Journal of Verbal Learning and Verbal Behavior 11(6):671–684. ● https://doi.org/10.1016/S0022-5371(72)80001-X
  - 机制：语义深加工比浅层加工留下更持久的痕迹。可编码：编码时的重要性/概念化程度影响 `S₀`。

---

## 8. 知道感（Feeling of Knowing）

- **Koriat, A. (1993).** *How do we know that we know? The accessibility model of the feeling of knowing.* Psychological Review 100(4):609–639. ● https://doi.org/10.1037/0033-295X.100.4.609
  - 机制：FOK 不是"摸到一个遗忘痕迹"，而是对当前可及信息量（部分线索、熟悉度）的推断。可编码：检索为空时，用部分相似度给出 0–0.45 的 `feelingOfKnowing`，而不是二元"不知道"。

---

## 9. 前瞻记忆（尚未实现）

- **McDaniel, M. A., & Einstein, G. O. (2007).** *Prospective Memory: An Overview and Synthesis of an Emerging Field.* Sage.（书，无 DOI）
  - 机制：事件型线索（看到 X 时做 Y）与时间型线索（到 T 时做 Y）是两类触发；线索显著性、进行中任务的负荷决定成败。
  - 路线：`intentions.jsonl` 存 `{trigger, action, dueAt}`，每轮对用户输入做关键词/时间匹配，命中则作为待办注入 prompt。

---

## 10. v3 实现清单（与代码对应）

| 机制 | 代码 | 参数 |
|---|---|---|
| 幂律保持 | `retention.js: retrievability` | `F=19/81`, `d=0.5`, `S` 天 |
| 90% 间隔 | `intervalFor` | `target=0.9` → `t≈S` |
| 初始稳定性 | `initialStability` | `0.5+20·I²+8·salience+4·|v|`，schema ×3 |
| 复习增益 | `growStability` | `(1+1.2(1−R))·(1+0.4(1−D))` |
| 失效 | `lapseStability` | `max(0.5, 0.4S)`，`D+0.15` |
| 标记捕获 | `captureBoost` / `_captureTagged` | 强 `salience≥0.7`，±90 min，`+0.9·s·(1−|Δt|/90)` |
| 倒摄干扰 | `interferenceFactor` / `_applyInterference` | `sim>0.55`，`×(1−0.15·sim)`，schema 免疫 |
| 图式 permastore | `consolidate` | `S≥180`，`×2` |
| 知道感 | `MemoryStore.probe` | 部分相似度 → 0–0.45 |
| 生动度 | `vividnessOf` | `0.25+0.45·salience+0.3·arousal+0.2·surprise` |
| 复习事件日志 | `reviews.jsonl` | `{id,S,D,last,n,lapses}`，重启重放 |

**尚未做**：前瞻记忆；按真实 Agent 日志拟合 `S₀`/增益（FSRS 的 w 参数）；时间型提醒。
