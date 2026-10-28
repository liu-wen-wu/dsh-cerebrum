/**
 * Build a self-contained HTML dashboard from examples/.demo/timeline.json.
 * No build step, no dependencies: SVG is generated as strings.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = path.join(here, '.demo', 'timeline.json')
if (!fs.existsSync(input)) {
  console.error('timeline.json missing; run `npm run demo` first')
  process.exit(1)
}
const data = JSON.parse(fs.readFileSync(input, 'utf8'))
const timeline = data.timeline
const final = data.finalState

const esc = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

const W = 860
const H = 220
const PAD = { left: 42, right: 16, top: 18, bottom: 28 }

const scaleX = (i) => PAD.left + (i / Math.max(timeline.length - 1, 1)) * (W - PAD.left - PAD.right)
const scaleY = (v, min, max) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom)

const polyline = (values, min, max, color, width = 2) =>
  `<polyline fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" points="${values
    .map((v, i) => `${scaleX(i).toFixed(1)},${scaleY(v, min, max).toFixed(1)}`)
    .join(' ')}" />`

const axis = (min, max, unit = '') => {
  const rows = []
  for (let i = 0; i <= 4; i++) {
    const value = min + ((max - min) * i) / 4
    const y = scaleY(value, min, max)
    rows.push(`<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="#243244" stroke-width="1" />`)
    rows.push(`<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" fill="#7d8ea3" font-size="10">${value.toFixed(1)}${unit}</text>`)
  }
  return rows.join('')
}

const xLabels = () =>
  timeline
    .map((row, i) => `<text x="${scaleX(i)}" y="${H - 8}" text-anchor="middle" fill="#7d8ea3" font-size="10">T${row.turn}</text>`)
    .join('')

const valenceChart = `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="效价、唤醒与心境">
  ${axis(-1, 1)}
  ${polyline(timeline.map((r) => r.valence), -1, 1, '#5ec8f2', 2.4)}
  ${polyline(timeline.map((r) => r.mood), -1, 1, '#8f7bf0', 1.8)}
  ${polyline(timeline.map((r) => r.arousal * 2 - 1), -1, 1, '#f2a65e', 1.8)}
  ${xLabels()}
  <g font-size="11">
    <rect x="${W - 250}" y="8" width="10" height="3" fill="#5ec8f2" /><text x="${W - 234}" y="13" fill="#c7d3e0">效价</text>
    <rect x="${W - 178}" y="8" width="10" height="3" fill="#8f7bf0" /><text x="${W - 162}" y="13" fill="#c7d3e0">心境</text>
    <rect x="${W - 106}" y="8" width="10" height="3" fill="#f2a65e" /><text x="${W - 90}" y="13" fill="#c7d3e0">唤醒</text>
  </g>
</svg>`

const neuroChart = `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="神经调质">
  ${axis(0, 1)}
  ${polyline(timeline.map((r) => r.neuromods.da), 0, 1, '#f2d05e', 2.2)}
  ${polyline(timeline.map((r) => r.neuromods.ser), 0, 1, '#5ef2a6', 2.2)}
  ${polyline(timeline.map((r) => r.neuromods.ne), 0, 1, '#f25e6a', 2.2)}
  ${polyline(timeline.map((r) => r.neuromods.ach), 0, 1, '#5e9bf2', 2.2)}
  ${xLabels()}
  <g font-size="11">
    <rect x="${W - 268}" y="8" width="10" height="3" fill="#f2d05e" /><text x="${W - 252}" y="13" fill="#c7d3e0">DA</text>
    <rect x="${W - 214}" y="8" width="10" height="3" fill="#5ef2a6" /><text x="${W - 198}" y="13" fill="#c7d3e0">5-HT</text>
    <rect x="${W - 152}" y="8" width="10" height="3" fill="#f25e6a" /><text x="${W - 136}" y="13" fill="#c7d3e0">NE</text>
    <rect x="${W - 90}" y="8" width="10" height="3" fill="#5e9bf2" /><text x="${W - 74}" y="13" fill="#c7d3e0">ACh</text>
  </g>
</svg>`

const emotionColors = {
  joy: '#f2d05e', gratitude: '#f2a65e', pride: '#e08cf0', relief: '#7fd6c1', curiosity: '#5ec8f2',
  calm: '#7d8ea3', frustration: '#f25e6a', anxiety: '#f2a65e', fear: '#c94f7c', sadness: '#5e6b8f',
  anger: '#e05252', guilt: '#a06bd6', shame: '#8a6bb0', hope: '#a8d65e', contentment: '#8fd6a8',
}

const emotionStrip = timeline
  .map((row, i) => {
    const x = scaleX(i)
    const color = emotionColors[row.emotionKey] ?? '#7d8ea3'
    return `<g>
      <circle cx="${x}" cy="34" r="${8 + row.intensity * 10}" fill="${color}" opacity="0.85" />
      <text x="${x}" y="72" text-anchor="middle" fill="#c7d3e0" font-size="10">${esc(row.emotion)}</text>
    </g>`
  })
  .join('')

const rows = timeline
  .map(
    (row) => `<tr>
      <td>${row.turn}</td>
      <td>${esc(row.label)}</td>
      <td><span class="dot" style="background:${emotionColors[row.emotionKey] ?? '#7d8ea3'}"></span>${esc(row.emotion)}</td>
      <td>${row.valence.toFixed(2)}</td>
      <td>${row.arousal.toFixed(2)}</td>
      <td>${row.episodes}</td>
      <td>${row.segmentsOpen ? `进行中（${row.segmentTurns} 轮）` : '已关闭'}</td>
      <td>${row.recall.map((hit) => `${esc(hit.summary)} <span class="muted">保有 ${Math.round((hit.retention ?? 0) * 100)}%</span>`).join('<br/>')}</td>
    </tr>`,
  )
  .join('')

const verdict = data.verdict
const verdictHtml = `
<div class="card">
  <h3>决策：${esc(verdict.question)}</h3>
  <p class="muted">系统 <b>${esc(verdict.system)}</b> · 利害 ${esc(verdict.stakes)} · 置信 ${(verdict.confidence * 100).toFixed(0)}% · 冲突 ${verdict.conflict}</p>
  <p class="choice">建议：${esc(verdict.choice)}</p>
  <ul>${verdict.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>
  ${verdict.checklist.length > 0 ? `<details><summary>慢系统检查清单</summary><ul>${verdict.checklist.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}
</div>`

const concepts = final.concepts
  .map((concept) => `<li><b>${esc(concept.name)}</b> <span class="muted">强度 ${concept.strength} · ${concept.count} 次</span><br/><span class="muted">${esc(concept.gist)}</span></li>`)
  .join('')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>dsh-cerebrum · 认知状态面板</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0d1420; color: #dbe4ee; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .5px; }
  h2 { font-size: 15px; margin: 28px 0 10px; color: #9fb3c8; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
  .muted { color: #7d8ea3; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
  .stat { background: #131d2c; border: 1px solid #1f2c3f; border-radius: 10px; padding: 12px 14px; }
  .stat b { display: block; font-size: 20px; color: #eaf2fb; }
  .chart { background: #101a28; border: 1px solid #1f2c3f; border-radius: 12px; padding: 8px 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1c2839; vertical-align: top; }
  th { color: #8fa3b8; font-weight: 600; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .card { background: #131d2c; border: 1px solid #1f2c3f; border-radius: 12px; padding: 16px 20px; }
  .choice { font-size: 17px; color: #7fe0b0; margin: 6px 0 10px; }
  ul { margin: 8px 0 0 18px; padding: 0; }
  li { margin: 4px 0; }
  .cols { display: grid; grid-template-columns: 1.2fr .8fr; gap: 16px; }
  @media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
</style></head>
<body>
  <h1>dsh-cerebrum · 认知状态面板</h1>
  <div class="muted">生成于 ${esc(data.generatedAt)} · 数据目录 ${esc(final.dataDir)}</div>

  <div class="grid">
    <div class="stat"><span class="muted">人格</span><b>${esc(final.personality.label)}</b><span class="muted">O ${final.personality.traits.openness} · C ${final.personality.traits.conscientiousness} · E ${final.personality.traits.extraversion} · A ${final.personality.traits.agreeableness} · N ${final.personality.traits.neuroticism}</span></div>
    <div class="stat"><span class="muted">当前情绪</span><b>${esc(final.affect.emotion.label)}</b><span class="muted">强度 ${final.affect.emotion.intensity} · 效价 ${final.affect.valence} · 唤醒 ${final.affect.arousal}</span></div>
    <div class="stat"><span class="muted">情景记忆</span><b>${final.memory.episodes}</b><span class="muted">概念 ${final.memory.concepts} · 关联 ${final.memory.edges} · 已巩固 ${final.memory.consolidated} · 永久候选 ${final.memory.permastore ?? 0}</span></div>
    <div class="stat"><span class="muted">平均稳定性</span><b>${final.memory.avgStabilityDays ?? 0} 天</b><span class="muted">被捕获 ${final.memory.tagged ?? 0} · 干扰 ${final.memory.interferences ?? 0} · 再巩固 ${final.memory.reconsolidations ?? 0}</span></div>
    <div class="stat"><span class="muted">工作记忆 / 当前事件</span><b>${final.workingMemory?.length ?? 0} / 4</b><span class="muted">${final.segmentation?.open ? `事件进行中（${final.segmentation.turns.length} 轮）` : '无开启事件'} · 补全 ${final.memory.completions ?? 0} 次</span></div>
    <div class="stat"><span class="muted">自我计数</span><b>${final.self.counters.turns} 轮</b><span class="muted">工具 ${final.self.counters.tools} · 成功 ${final.self.counters.successes} · 失败 ${final.self.counters.failures}</span></div>
  </div>

  <h2>情绪与核心情感</h2>
  <div class="chart">${valenceChart}</div>
  <div class="chart" style="margin-top:12px"><svg viewBox="0 0 860 92" role="img" aria-label="情绪时间线">${emotionStrip}</svg></div>

  <h2>神经调质</h2>
  <div class="chart">${neuroChart}</div>

  <h2>决策与语义记忆</h2>
  <div class="cols">
    ${verdictHtml}
    <div class="card">
      <h3>巩固后的核心概念</h3>
      <ul>${concepts || '<li class="muted">（无）</li>'}</ul>
      <h3 style="margin-top:18px">工作记忆槽位</h3>
      <ul>${(final.workingMemory ?? []).map((slot) => `<li>${esc(slot.summary)}</li>`).join('') || '<li class="muted">（空）</li>'}</ul>
    </div>
  </div>

  <h2>逐轮时间线</h2>
  <table>
    <thead><tr><th>#</th><th>事件</th><th>情绪</th><th>效价</th><th>唤醒</th><th>记忆</th><th>事件状态</th><th>当时召回</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`

const out = path.join(here, '.demo', 'dashboard.html')
fs.writeFileSync(out, html, 'utf8')
console.log(`wrote ${out}`)
