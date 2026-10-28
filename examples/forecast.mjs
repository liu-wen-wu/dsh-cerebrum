/**
 * Forecast: long-horizon retention and daily token cost.
 *
 * Retention uses the v3 power-law model R(t,S) = (1 + (19/81)·t/S)^(−0.5).
 * Token cost uses the actual prompt budget caps (resident / single-winner recall /
 * working memory / fixed state card). Everything here is derived from lib/core/*
 * constants, so the numbers track the code; the *behavioural* inputs (turns/day,
 * how many preferences the user keeps) are exposed as parameters.
 *
 * Output: examples/.demo/forecast.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { growStability, intervalFor, retrievability } from '../lib/core/retention.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '.demo')
fs.mkdirSync(outDir, { recursive: true })

const YEAR = 365
const F = 19 / 81

const pct = (r) => `${(r * 100).toFixed(1)}%`

// ---- 1. Retention at 1 / 10 / 20 years for a range of stability ----
const stabilities = [1, 3, 10, 30, 90, 180, 365, 730, 3650, 7300]
const horizons = [1 * YEAR, 10 * YEAR, 20 * YEAR]
const retentionRows = stabilities.map((S) => ({
  stabilityDays: S,
  label: labelOf(S),
  ...Object.fromEntries(horizons.map((t) => [`y${t / YEAR}`, Number(retrievability(t, S).toFixed(3))])),
}))

function labelOf(S) {
  if (S < 3) return '一次性/弱记忆'
  if (S < 30) return '普通情景'
  if (S < 180) return '强记忆/反复复习'
  if (S < 730) return 'schema（permastore 起点）'
  if (S < 3650) return '多年间隔复习'
  return '十年以上长期复习'
}

// ---- 2. Reviews needed to keep 90% at a horizon ----
// By construction R(S,S)=0.9, so keeping 90% at horizon H requires S = H days.
const keep90 = horizons.map((H) => ({
  horizonYears: H / YEAR,
  requiredStabilityDays: H,
  note: `R(H,S=H)=0.9（幂律定义），需把稳定性维持到 ${H / YEAR} 年的量级`,
}))

// Simulate spaced reviews from a typical strong trace (importance .8, salience .6).
const S0 = 0.5 + 20 * 0.8 * 0.8 + 8 * 0.6
const simulateTo = (targetS, reviewAt, difficulty = 0.3) => {
  let S = S0
  let day = 0
  let reviews = 0
  const marks = []
  while (S < targetS && reviews < 40) {
    const interval = Math.max(1, Math.round(intervalFor(S, reviewAt)))
    day += interval
    const r = retrievability(interval, S)
    S = growStability(S, difficulty, r)
    reviews++
    marks.push({ review: reviews, day, S: Number(S.toFixed(1)), r: Number(r.toFixed(2)) })
  }
  return { reviews, years: day / YEAR, days: day, finalS: Number(S.toFixed(1)), marks }
}

const schedules = [
  { target: 3650, label: '保持 90% @ 10 年', reviewAt: 0.9 },
  { target: 3650, label: '保持 90% @ 10 年（费劲复习）', reviewAt: 0.7 },
  { target: 7300, label: '保持 90% @ 20 年', reviewAt: 0.9 },
].map((spec) => ({ ...spec, result: simulateTo(spec.target, spec.reviewAt) }))

// ---- 3. Daily token cost model ----
// Chinese-heavy text: ~1.5 chars per token is a conservative middle estimate.
const CHARS_PER_TOKEN = 1.5
const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN)

const fixedCard = {
  identity: { chars: 30, what: '人格一句话' },
  emotion: { chars: 55, what: '情绪 + 效价/唤醒/支配 + 心境' },
  neuromods: { chars: 60, what: 'DA/5-HT/NE/ACh' },
  values: { chars: 40, what: '价值排序（4 条）' },
  goals: { chars: 40, what: '长期目标（3 条）' },
  workingMemory: { chars: 4 * 40, what: '工作记忆 4 槽' },
  bias: { chars: 44, what: '决策倾向（谨慎/探索/抑制/损失厌恶）' },
}
const fixedChars = Object.values(fixedCard).reduce((sum, item) => sum + item.chars, 0)

// Resident layer: preferences / agreements / schemas, capped by residentMaxChars.
const residentChars = (residentCount) => Math.min(residentCount, 6) * 48
const residentCap = 360

// Episodic: single-winner line only when the best hit clears the threshold.
const episodicChars = 200

// Static system section (cache-stable, counted once per turn too for honesty).
const staticSectionChars = 220

const perTurn = ({ residentCount, episodicFired }) => {
  const resident = Math.min(residentChars(residentCount), residentCap)
  const episodic = episodicFired ? episodicChars : 0
  const dynamic = fixedChars + resident + episodic
  const total = staticSectionChars + dynamic
  return {
    fixedChars,
    residentChars: resident,
    episodicChars: episodic,
    staticSectionChars,
    dynamicChars: dynamic,
    totalChars: total,
    totalTokens: tokens(total),
  }
}

const turnRates = [5, 20, 50, 100, 200]
const scenarios = [
  { name: '轻量日（偏好少，情节 20% 轮命中）', residentCount: 2, episodicRate: 0.2 },
  { name: '典型日（偏好多，情节 50% 轮命中）', residentCount: 5, episodicRate: 0.5 },
  { name: '密集日（常驻拉满，情节 90% 轮命中）', residentCount: 6, episodicRate: 0.9 },
].map((scenario) => {
  const resident = Math.min(residentChars(scenario.residentCount), residentCap)
  const fixedTokens = tokens(staticSectionChars + fixedChars + resident)
  const episodicTokens = tokens(episodicChars)
  const expectedPerTurn = Math.round(fixedTokens + episodicTokens * scenario.episodicRate)
  return {
    ...scenario,
    perTurnTokens: expectedPerTurn,
    fixedTokens,
    episodicTokens,
    dailyTokens: Object.fromEntries(turnRates.map((n) => [n, Math.round(expectedPerTurn * n)])),
  }
})

const payload = {
  generatedAt: new Date().toISOString(),
  assumptions: {
    charsPerToken: CHARS_PER_TOKEN,
    powerLaw: `R(t,S) = (1 + ${F.toFixed(6)}·t/S)^(−0.5)`,
    fixedCard,
    fixedChars,
    residentCap,
    episodicChars,
    staticSectionChars,
    initialStabilityForSchedule: Number(S0.toFixed(1)),
  },
  retention: { stabilities, horizonsYears: horizons.map((h) => h / YEAR), rows: retentionRows },
  keep90,
  reviewSchedules: schedules.map(({ target, label, reviewAt, result }) => ({ target, label, reviewAt, ...result })),
  tokenCost: {
    turnRates,
    perTurnBreakdown: perTurn({ residentCount: 5, episodicFired: true }),
    scenarios,
  },
}

fs.writeFileSync(path.join(outDir, 'forecast.json'), JSON.stringify(payload, null, 2))

// ---- console summary ----
console.log('=== 20 年保持率（幂律 R=(1+19/81·t/S)^−0.5） ===')
console.log('稳定性 S'.padEnd(22), '1年'.padStart(8), '10年'.padStart(8), '20年'.padStart(8))
for (const row of retentionRows) {
  console.log(`${row.label}（S=${row.stabilityDays} 天）`.padEnd(22), pct(row.y1).padStart(8), pct(row.y10).padStart(8), pct(row.y20).padStart(8))
}

console.log('\n=== 保持 90% 需要的稳定性 ===')
for (const item of keep90) console.log(`  ${item.horizonYears} 年 → S ≥ ${item.requiredStabilityDays} 天`)

console.log('\n=== 从 S0=' + S0.toFixed(1) + ' 天做间隔复习达到目标 ===')
for (const { label, result } of schedules) {
  console.log(`  ${label}：${result.reviews} 次复习，历时 ${result.years.toFixed(1)} 年（末次 S=${result.finalS}）`)
}

console.log('\n=== 每轮 token 成本（1 token ≈ ' + CHARS_PER_TOKEN + ' 汉字） ===')
console.log(`  固定状态卡 ${fixedChars} 字符 + 常驻(≤${residentCap}) + 情节(触发时 ${episodicChars}) + 静态段 ${staticSectionChars}`)
for (const scenario of scenarios) {
  console.log(`  ${scenario.name}：每轮 ~${scenario.perTurnTokens} tokens`)
  console.log(`    每日：${turnRates.map((n) => `${n}轮→${scenario.dailyTokens[n]}t`).join(' · ')}`)
}
console.log(`\n数据写入 ${path.join(outDir, 'forecast.json')}`)
