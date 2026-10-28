/**
 * Compute forgetting-curve and spacing data for the docs figure.
 * Output: examples/.demo/retention.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { growStability, retrievability } from '../lib/core/retention.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '.demo')
fs.mkdirSync(outDir, { recursive: true })

// Log-spaced time axis from 0.1 day to 10 years.
const days = [0]
for (let i = 0; i <= 96; i++) days.push(Number((0.1 * Math.pow(36500, i / 96)).toFixed(3)))

const curves = [
  { key: 'weak', label: '弱记忆 S=1 天', stability: 1 },
  { key: 'medium', label: '中等 S=10 天', stability: 10 },
  { key: 'strong', label: '强记忆 S=90 天', stability: 90 },
  { key: 'permastore', label: '图式/永久候选 S=365 天', stability: 365 },
].map((entry) => ({
  ...entry,
  points: days.map((t) => Number(retrievability(t, entry.stability).toFixed(4))),
}))

// Exponential with the same value at t = S (R(S)=0.9) for a fair comparison.
const exponential = {
  label: '指数衰减（同样 90% 点）',
  points: days.map((t) => {
    if (t === 0) return 1
    const halfLife = 10 * Math.LN2 / Math.log(1 / 0.9)
    return Number(Math.exp(-t / halfLife).toFixed(4))
  }),
}

// Two review schedules with the same number of successful reviews.
const simulate = (reviews, horizon = 365) => {
  let stability = 5
  let last = 0
  const marks = []
  const series = []
  const schedule = new Set(reviews)
  for (let day = 0; day <= horizon; day++) {
    if (day > 0 && schedule.has(day)) {
      const r = retrievability(day - last, stability)
      marks.push({ day, r: Number(r.toFixed(3)), stabilityBefore: Number(stability.toFixed(1)) })
      stability = growStability(stability, 0.5, r)
      last = day
    }
    series.push({ day, r: Number(retrievability(day - last, stability).toFixed(4)) })
  }
  return {
    marks,
    stability: Number(stability.toFixed(1)),
    series,
    day90: series.find((point) => point.day === 90)?.r ?? 0,
    day365: series.at(-1)?.r ?? 0,
  }
}

const massed = simulate([1, 2, 3, 4, 5, 6])
const spaced = simulate([1, 3, 7, 16, 35, 75])

const payload = {
  generatedAt: new Date().toISOString(),
  days,
  curves,
  exponential,
  spacing: {
    massed: { ...massed, reviews: [1, 2, 3, 4, 5, 6] },
    spaced: { ...spaced, reviews: [1, 3, 7, 16, 35, 75] },
  },
}

fs.writeFileSync(path.join(outDir, 'retention.json'), JSON.stringify(payload, null, 2))

console.log('遗忘曲线（幂律 vs 指数，10 年）：')
for (const curve of [...curves.map((c) => ({ label: c.label, value: c.points.at(-1) })), { label: exponential.label, value: exponential.points.at(-1) }]) {
  console.log(`  ${curve.label.padEnd(28, ' ')} ${(curve.value * 100).toFixed(1)}%`)
}
console.log('\n间隔效应（同样 6 次成功复习，365 天后的保有率）：')
console.log(`  集中复习 S=${massed.stability} 天 → 第 90 天 ${(massed.day90 * 100).toFixed(0)}%，第 365 天 ${(massed.day365 * 100).toFixed(0)}%`)
console.log(`  间隔复习 S=${spaced.stability} 天 → 第 90 天 ${(spaced.day90 * 100).toFixed(0)}%，第 365 天 ${(spaced.day365 * 100).toFixed(0)}%`)
console.log(`\n数据写入 ${path.join(outDir, 'retention.json')}`)
