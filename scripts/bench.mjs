/**
 * Performance benchmark: encode / recall / consolidate / flush / cold load.
 *
 * Run: node scripts/bench.mjs [--json]
 *
 * Uses synthetic Chinese episodes from a domain vocabulary so the SDR, BM25 and
 * concept index see realistic repetition (a single random string would be
 * unrealistically easy for the candidate filters).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { MemoryStore } from '../lib/core/memory.js'
import { SdrEncoder } from '../lib/core/sdr.js'

const VOCAB = [
  '迁移', '备份', '演练', '灰度', '回滚', '日志', '队列', '索引', '缓存', '部署', '发布', '预算', '设计', '评审',
  '测试', '故障', '告警', '监控', '并发', '事务', '锁', '分片', '鉴权', '套餐', '账单', '发票', '客户', '合同',
  '审批', '风控', '报表', '看板', '埋点', '漏斗', '留存', '转化', '推荐', '画像', '召回', '排序', '特征', '模型',
  '训练', '推理', '标注', '清洗', '口径', '指标', '复盘', '排期', '里程碑', '验收', '上线', '值班', '扩容', '限流',
  '熔断', '降级', '超时', '重试', '幂等', '唯一约束', '慢查询', '锁等待', '主从', '复制', '快照', '归档',
]

let seed = 42
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const pick = () => VOCAB[Math.floor(rnd() * VOCAB.length)]

const makeText = (i) => {
  const outcome = rnd() < 0.75 ? '成功' : '失败'
  return `第 ${i} 次${pick()}与${pick()}：${pick()}${pick()}时先${pick()}再${pick()}，观察${pick()}，结果${outcome}`
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[index]
}

const stats = (values) => ({
  avg: Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3)),
  p50: Number(percentile(values, 50).toFixed(3)),
  p95: Number(percentile(values, 95).toFixed(3)),
  max: Number(Math.max(...values).toFixed(3)),
})

const QUERIES = [
  '迁移 备份 演练',
  '灰度 回滚 告警',
  '账单 发票 套餐',
  '模型 训练 推理',
  '值班 扩容 限流',
  '完全无关的天气与咖啡豆烘焙曲线',
]

const run = (n) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cerebrum-bench-${n}-`))
  const encoder = new SdrEncoder({ dim: 2048, k: 32 })
  const store = new MemoryStore({ dir, encoder, maxEpisodes: 4000 }).load()
  const now = Date.now()

  const encodeTimes = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    store.encodeEpisode({
      text: makeText(i),
      at: now - (n - i) * 60e3,
      importance: 0.3 + rnd() * 0.5,
      salience: 0.2 + rnd() * 0.6,
      outcome: { success: rnd() < 0.75, errors: rnd() < 0.2 ? 1 : 0 },
    })
    encodeTimes.push(performance.now() - t0)
  }

  const recallTimes = []
  const recallHits = []
  for (let round = 0; round < 3; round++) {
    for (const query of QUERIES) {
      const t0 = performance.now()
      const hits = store.recall(query, { k: 5 })
      recallTimes.push(performance.now() - t0)
      recallHits.push(hits.length)
    }
  }

  const tConsolidate = performance.now()
  store.consolidate({ stage: 'nrem', minCluster: 3 })
  const consolidateMs = performance.now() - tConsolidate

  const tFlush = performance.now()
  store.dirty = true
  store.flush()
  const flushMs = performance.now() - tFlush

  const tLoad = performance.now()
  new MemoryStore({ dir, encoder }).load()
  const loadMs = performance.now() - tLoad

  const size = {
    episodesFileBytes: fs.statSync(path.join(dir, 'episodes.jsonl')).size,
    dirBytes: fs.readdirSync(dir).reduce((sum, file) => sum + (fs.statSync(path.join(dir, file)).isFile() ? fs.statSync(path.join(dir, file)).size : 0), 0),
  }

  return {
    episodes: store.episodes.length,
    concepts: store.concepts.size,
    edges: store.edges.size,
    skills: store.skills.length,
    encode: stats(encodeTimes),
    recall: stats(recallTimes),
    recallHits: Number((recallHits.reduce((a, b) => a + b, 0) / recallHits.length).toFixed(2)),
    consolidateMs: Number(consolidateMs.toFixed(1)),
    flushMs: Number(flushMs.toFixed(1)),
    coldLoadMs: Number(loadMs.toFixed(1)),
    sizeKB: { episodes: Math.round(size.episodesFileBytes / 1024), dir: Math.round(size.dirBytes / 1024) },
    dir,
  }
}

const main = () => {
  const jsonMode = process.argv.includes('--json')
  const results = []
  for (const n of [1000, 3000, 4000]) {
    const result = run(n)
    results.push(result)
    if (!jsonMode) {
      console.log(`\n=== ${n} episodes ===`)
      console.log(`encode  ms  avg ${result.encode.avg}  p95 ${result.encode.p95}  max ${result.encode.max}`)
      console.log(`recall  ms  avg ${result.recall.avg}  p95 ${result.recall.p95}  max ${result.recall.max}  (平均命中 ${result.recallHits})`)
      console.log(`consolidate ${result.consolidateMs} ms · flush ${result.flushMs} ms · cold load ${result.coldLoadMs} ms`)
      console.log(`graph: ${result.concepts} concepts · ${result.edges} edges · ${result.skills} skills`)
      console.log(`disk: episodes.jsonl ${result.sizeKB.episodes} KB · dir ${result.sizeKB.dir} KB`)
    }
  }
  if (jsonMode) console.log(JSON.stringify(results, null, 2))
  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'examples', '.demo')
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify(results, null, 2))
    if (!jsonMode) console.log(`\nwritten ${path.join(outDir, 'bench.json')}`)
  } catch (error) {
    if (!jsonMode) console.log(`(json not written: ${error.message})`)
  }
}

main()
