/**
 * Judgment: a dual-process decision layer over memory and affect.
 *
 * System 1 (fast) reads the somatic marker: the valence of the memories a cue
 * evokes (Damasio 1994). System 2 (slow) is recruited by the anterior
 * cingulate-style conflict monitor when the gut and the expected value disagree,
 * when the stakes are high, or when the evidence is thin. Option evaluation uses
 * a prospect-theory value function whose loss aversion is modulated by
 * serotonin, neuroticism and current arousal; basal-ganglia-style gating then
 * applies a NoGo veto when an impulse conflicts with values or risk.
 *
 * This is a scaffold, not an oracle: its job is to make the trade-offs explicit
 * and to give the model a defensible prior, not to replace reasoning.
 */

import { clamp, prospectValue, sigmoid, softmax } from './math.js'

const HIGH_STAKES = /(删除|删掉|覆盖|格式化|上线|发布|生产|数据库|密码|密钥|转账|支付|合同|法律|医疗|诊断| irreversible|delete|drop table|force push|rm -rf|production|deploy|password|secret|payment)/i
const IRREVERSIBLE = /(删除|覆盖|格式化|清空|永久|drop|delete|truncate|rm -rf|force|覆写)/i
const IMPULSE = /(立刻|马上|现在就要|直接|赶紧|冲动|先斩后奏|right now|immediately|just do it)/i
const NORM_RISK = /(欺骗|撒谎|隐瞒|绕过|规避|作弊|侵权|隐私|越权|deceive|lie|bypass|cheat|privacy|unauthorized)/i
const CAUTION = /(小心|谨慎|风险|回滚|备份|确认|double.?check|backup|rollback|verify)/i

const STAKES_VALUE = { low: 0.25, medium: 0.55, high: 0.85 }

const clampText = (text, limit = 300) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)

export class Judge {
  constructor({ memory, affect, personality } = {}) {
    this.memory = memory
    this.affect = affect
    this.personality = personality
  }

  /**
   * @param {object} input
   * @param {string} input.question the decision to make
   * @param {string[]} [input.options] candidate actions; free-form decision when empty
   * @param {'low'|'medium'|'high'} [input.stakes]
   * @param {number} [input.now]
   * @param {import('./sdr.js').Code} [input.contextCode]
   */
  judge({ question, options = [], stakes = 'medium', now = Date.now(), contextCode } = {}) {
    const P = this.personality?.params() ?? { lossAversion: 2.25, conformity: 0.5, impulseInhibition: 0.5, exploration: 0.5, planningDepth: 2 }
    const A = this.affect
    const q = String(question ?? '').trim()
    if (q.length === 0) throw new Error('judge requires a question')

    const highStakes = HIGH_STAKES.test(q)
    const stakesLevel = highStakes ? 'high' : stakes
    const magnitude = STAKES_VALUE[stakesLevel] ?? 0.55
    const baseLoss = P.lossAversion * (1 + 0.25 * magnitude)
    const lossAversion = A ? A.lossAversion(baseLoss) : baseLoss

    const evidence = this.memory?.recall(`${q} ${options.join(' ')}`, {
      k: 8,
      now,
      moodValence: A?.valence ?? 0,
      moodBias: A?.moodCongruence ?? 0.2,
      reinforce: false,
      contextCode,
    }) ?? []

    const evidenceStrength = clamp(evidence.reduce((sum, hit) => sum + hit.probability, 0) / 4)

    const optionsIn = options.filter((o) => typeof o === 'string' && o.trim().length > 0).slice(0, 6)
    const evaluated = optionsIn.map((option) => this._evaluateOption(option, { evidence, magnitude, lossAversion, P, q }))

    // System 1: somatic marker over the whole cue (not per option).
    let gutValence = 0
    let gutWeight = 0
    for (const hit of evidence) {
      gutWeight += hit.probability
      gutValence += hit.probability * hit.episode.affect.v
    }
    const gut = gutWeight > 0 ? clamp(gutValence / gutWeight, -1, 1) : 0

    if (evaluated.length === 0) {
      // No explicit options: turn the evidence into a recommendation stance.
      const stance = this._stance({ gut, evidence, P, magnitude, q })
      return {
        question: q,
        system: 'S1',
        stakes: stakesLevel,
        choice: stance.choice,
        confidence: stance.confidence,
        gut: { value: Number(gut.toFixed(3)), leaning: gut > 0.15 ? '接近' : gut < -0.15 ? '回避' : '中立' },
        options: [],
        conflict: 0,
        reasons: stance.reasons,
        evidence: this._evidenceView(evidence),
        checklist: this._checklist(q, stakesLevel),
        affect: A ? { valence: A.valence, arousal: A.arousal, emotion: A.emotion.label } : null,
      }
    }

    evaluated.sort((a, b) => b.score - a.score)
    const best = evaluated[0]
    const second = evaluated[1]
    const margin = second ? best.score - second.score : Math.abs(best.score)

    // Conflict monitoring: gut vs. deliberation, or a near-tie between options.
    const gutOption = this._gutOption(evaluated, evidence, gut)
    const conflict = clamp(
      0.55 * (second ? 1 - Math.tanh(margin / 0.35) : 0) +
        0.45 * (gutOption && gutOption.option !== best.option ? 1 : 0),
    )

    let system = 'S1'
    if (stakesLevel === 'high' || conflict > 0.45 || evidenceStrength < 0.18 || P.planningDepth >= 3) system = 'S2'

    // NoGo gate: an impulse-shaped option loses to values, risk and low serotonin.
    const vetoedOptions = new Map()
    for (const candidate of evaluated) {
      if (!IMPULSE.test(candidate.option)) continue
      const inhibition = A ? A.inhibition(P.impulseInhibition) : P.impulseInhibition
      const pressure = clamp(0.55 * inhibition + 0.45 * (1 - magnitude))
      const hardRisk = !candidate.reversible || NORM_RISK.test(candidate.option)
      if ((pressure > 0.45 || hardRisk) && inhibition > 0.4) {
        vetoedOptions.set(candidate.option, { option: candidate.option, pressure: Number(pressure.toFixed(3)), reason: '短时收益与长期价值/可逆性冲突，前额叶抑制占优' })
      }
    }
    const allowed = evaluated.filter((candidate) => !vetoedOptions.has(candidate.option))
    const chosen = allowed[0] ?? evaluated[0]
    const vetoed = vetoedOptions.get(best.option) ?? null
    const choice = chosen.option
    const confidence = clamp(
      sigmoid((chosen.score - (evaluated.find((c) => c.option !== choice)?.score ?? chosen.score - 0.3)) / 0.28) *
        (0.55 + 0.45 * evidenceStrength) *
        (system === 'S2' ? 0.92 : 0.78),
      0.05,
      0.97,
    )

    const reasons = []
    if (vetoed) reasons.push(`抑制冲动：${vetoed.reason}`)
    reasons.push(...chosen.rationale)
    if (gutOption && Math.abs(gut) > 0.15) {
      reasons.push(`躯体标记：同类经历整体偏${gut > 0 ? '积极' : '消极'}（${gut.toFixed(2)}），直觉倾向“${gutOption.option}”`)
    }
    if (system === 'S2') reasons.push('冲突/风险监控触发慢系统：已展开期望值、风险、可逆性与规范检查')
    if (evidence.length === 0) reasons.push('没有可用记忆证据，置信度按先验下调')

    return {
      question: q,
      system: vetoed ? 'S1-vetoed' : system,
      stakes: stakesLevel,
      choice,
      confidence: Number(confidence.toFixed(3)),
      gut: { value: Number(gut.toFixed(3)), option: gutOption?.option ?? null, leaning: gut > 0.15 ? '接近' : gut < -0.15 ? '回避' : '中立' },
      conflict: Number(conflict.toFixed(3)),
      options: evaluated.map((c) => ({
        option: c.option,
        score: Number(c.score.toFixed(3)),
        expectedValue: Number(c.expectedValue.toFixed(3)),
        risk: Number(c.risk.toFixed(3)),
        effort: Number(c.effort.toFixed(3)),
        reversible: c.reversible,
        probability: Number(c.probability.toFixed(3)),
      })),
      reasons: reasons.slice(0, 6),
      evidence: this._evidenceView(evidence),
      checklist: system === 'S2' ? this._checklist(q, stakesLevel) : [],
      affect: A ? { valence: A.valence, arousal: A.arousal, emotion: A.emotion.label } : null,
    }
  }

  _evaluateOption(option, { evidence, magnitude, lossAversion, P, q }) {
    const relevant = evidence
      .map((hit) => ({ hit, sim: simTokens(option, hit.episode.text) }))
      .filter(({ sim }) => sim > 0.05)
    const weight = relevant.reduce((sum, { sim }) => sum + sim, 0)

    let valence = 0
    let successes = 0
    let failures = 0
    for (const { hit, sim } of relevant) {
      valence += sim * hit.episode.affect.v
      if (hit.episode.outcome?.success === true) successes += sim
      if (hit.episode.outcome?.success === false) failures += sim
    }
    const evidenceValence = weight > 0 ? clamp(valence / weight, -1, 1) : 0
    const outcomeRate = successes + failures > 0 ? successes / (successes + failures) : 0.5

    const probability = clamp(0.5 + 0.32 * evidenceValence + 0.18 * (outcomeRate - 0.5) * 2, 0.05, 0.95)
    const gradual = /(灰度|小步|试点|分阶段|先.{0,6}再|观察|逐步|canary|gradual|staged)/i.test(option)
    const delayed = /(等|暂缓|再等|明天|观察|later|wait)/i.test(option)
    const fullSend = /(直接|全量|全部|立即|马上|一次性|full|all at once)/i.test(option)
    const riskScale = gradual ? 0.62 : fullSend ? 1.22 : delayed ? 0.92 : 1
    const magnitudeScale = fullSend ? 1.12 : 1

    const gain = magnitude * magnitudeScale * (0.75 + 0.25 * Math.abs(evidenceValence))
    const loss = magnitude * magnitudeScale
    const vGain = prospectValue(gain, { lossAversion })
    const vLoss = prospectValue(-loss, { lossAversion })
    const expectedValue = probability * vGain + (1 - probability) * vLoss
    const risk = probability * (1 - probability) * (Math.abs(vGain) + Math.abs(vLoss)) * riskScale

    const irreversible = IRREVERSIBLE.test(option) || (q.length < 40 && IRREVERSIBLE.test(q))
    const reversible = !irreversible
    const effort = clamp(
      0.12 + 0.06 * option.length / 8 + (CAUTION.test(option) ? 0.12 : 0) + (delayed ? 0.16 : 0) + (gradual ? 0.1 : 0) + (option.includes('调查') || option.includes('研究') ? 0.15 : 0),
    )
    const normPenalty = NORM_RISK.test(option) ? 1 : 0
    const shortTermGain = IMPULSE.test(option)

    const score =
      expectedValue -
      (A_of(this)?.riskAversionMultiplier ?? 1) * 0.55 * risk -
      0.22 * effort -
      normPenalty * (0.55 + 0.45 * P.conformity) -
      (reversible ? 0 : 0.12)

    const rationale = []
    rationale.push(`“${option}”成功概率约 ${(probability * 100).toFixed(0)}%，期望值 ${expectedValue.toFixed(2)}，风险 ${risk.toFixed(2)}${reversible ? '，可逆' : '，不可逆'}`)
    if (normPenalty > 0) rationale.push('触及规范/价值观红线，已从评分中扣除')
    if (relevant.length > 0) {
      const top = relevant.sort((a, b) => b.sim - a.sim)[0].hit.episode
      rationale.push(`依据记忆：“${clampText(top.summary, 60)}”`)
    }

    return { option, probability, expectedValue, risk, effort, reversible, shortTermGain, score, rationale }
  }

  _gutOption(evaluated, evidence, gut) {
    if (evaluated.length === 0) return null
    // Gut leans toward the option sharing the most concepts with positively/negatively valenced memories.
    let best = null
    for (const candidate of evaluated) {
      let score = 0
      for (const hit of evidence) score += simTokens(candidate.option, hit.episode.text) * hit.episode.affect.v
      if (!best || Math.abs(score) > Math.abs(best.value)) best = { option: candidate.option, value: score }
    }
    if (!best) return null
    // Only report a gut preference when it actually has a sign.
    return Math.sign(best.value) === Math.sign(gut) && Math.abs(best.value) > 0.01 ? best : best
  }

  _stance({ gut, evidence, P, magnitude, q }) {
    const strength = clamp(evidence.reduce((sum, hit) => sum + hit.probability, 0) / 5)
    let choice
    if (gut > 0.15 && strength > 0.3) choice = '按既有成功路径推进，同时设置检查点'
    else if (gut < -0.15) choice = '先降低不确定性，再决定是否行动'
    else if (strength < 0.25) choice = '信息不足：先澄清目标与约束'
    else choice = '小步试探，保留回滚选项'
    if (HIGH_STAKES.test(q) && P.planningDepth >= 3) choice = '高风险决策：先做最坏情况分析与可逆性评估'
    const reasons = []
    if (evidence.length > 0) {
      const top = evidence[0].episode
      reasons.push(`最相关记忆：“${clampText(top.summary, 80)}”（${top.affect.v > 0 ? '正' : '负'}向体验）`)
    } else reasons.push('长期记忆中没有同类经历，按保守先验处理')
    reasons.push(`当前风险偏好：损失厌恶 ${P.lossAversion.toFixed(2)}，探索率 ${P.exploration.toFixed(2)}`)
    return { choice, confidence: Number(clamp(0.35 + 0.4 * strength + 0.2 * Math.abs(gut), 0.1, 0.9).toFixed(3)), reasons }
  }

  _checklist(question, stakes) {
    const items = [
      '基准率：同类任务历史上成功的比例是多少？',
      '可逆性：如果判断错了，回滚代价多大？',
      '最坏情况：最差结果是否可承受，是否需要先设护栏？',
      '二阶效应：对用户、后续会话与长期记忆的影响是什么？',
      '价值一致性：这个选择是否符合我的价值观与用户授权？',
    ]
    if (stakes === 'high') items.unshift('是否应当先向用户确认？这是一个不可轻易回滚的高风险动作。')
    if (HIGH_STAKES.test(question)) items.push('是否有更小、更可逆的等价步骤？')
    return items
  }

  _evidenceView(evidence) {
    return evidence.slice(0, 5).map((hit) => ({
      summary: clampText(hit.episode.summary, 120),
      at: hit.episode.at,
      similarity: hit.parts.similarity,
      activation: Number(hit.activation.toFixed(3)),
      valence: hit.episode.affect.v,
      probability: Number(hit.probability.toFixed(3)),
    }))
  }
}

/** Cheap lexical overlap similarity in [0, 1] (no encoder dependency). */
const simTokens = (a, b) => {
  const tokensA = new Set(String(a).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0))
  const tokensB = new Set(String(b).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let inter = 0
  for (const t of tokensA) if (tokensB.has(t)) inter++
  return inter / Math.sqrt(tokensA.size * tokensB.size)
}

const A_of = (judge) => {
  const A = judge.affect
  if (!A) return { riskAversionMultiplier: 1 }
  return { riskAversionMultiplier: 1 + 0.6 * A.arousal + 0.4 * (1 - A.neuromods.ser) }
}

export { softmax }
