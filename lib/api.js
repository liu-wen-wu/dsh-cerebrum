/**
 * Loopback HTTP API for the brain.
 *
 * The host owns the state; a client UI cannot reach host services directly, so
 * this module exposes a read-only JSON API on 127.0.0.1 only (the same pattern
 * dsh-pet uses with /dsh-pet-7340). Mutations stay in the model-facing tools —
 * keeping the surface read-only is a deliberate safety choice.
 *
 * Endpoints:
 *   GET /ping                { ok, version, uptimeMs }
 *   GET /state?session=<id>  full CerebrumService.state() snapshot
 *   GET /recall?q=<text>&session=<id>  top-3 episodic hits (summaries only)
 *   GET /render-hints?session=<id>     pet-shell vocabulary (expression/animation/line)
 *   GET /interact?kind=pet|feed|praise|scold&session=<id>
 *                          the ONLY mutation: affect-only appraisal of a pet interaction
 */

import fs from 'node:fs'
import http from 'node:http'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTERACTION_KINDS } from './core/petbrain.js'

const PACKAGE_ROOT = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '..')
const PUPPET_DIR = nodePath.join(PACKAGE_ROOT, 'assets', 'puppet')

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>dsh-cerebrum 大脑面板</title>
<style>
 *{box-sizing:border-box}
 html,body{max-width:100%;overflow-x:hidden}
 body{margin:0;background:#0b1220;color:#dbe4ee;font:13px/1.55 system-ui,'Segoe UI',sans-serif;padding:14px 14px 18px}
 @media (prefers-color-scheme: light){
   body{background:#f4f7fb;color:#1f2937}
   .card{background:#fff!important;border-color:#e3e8ef!important}
   .k,.muted,.sub{color:#6b7280!important}
   .big{color:#111827!important}
   .track{background:#e5e9f0!important}
   .chip{background:#eef2f7!important;color:#374151!important}
   .ep{border-color:#eef1f5!important}
 }
 h1{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
 .dot{width:8px;height:8px;border-radius:999px;background:#3ddc97}
 .dot.off{background:#ef4444}
 .grid{display:grid;grid-template-columns:1fr;gap:10px}

 .card{border:1px solid #1f2c3f;border-radius:12px;padding:11px 13px;background:#101a28;margin-bottom:10px;overflow-wrap:anywhere}
 .card h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7d8ea3;margin:0 0 8px;font-weight:600}
 .row{display:flex;justify-content:space-between;gap:10px;padding:2px 0;align-items:baseline;flex-wrap:wrap}
 .row>span{min-width:0;max-width:100%}
 .ep .s{overflow-wrap:anywhere}
 .k{color:#7d8ea3}.muted{color:#7d8ea3;font-size:11px;overflow-wrap:anywhere;word-break:break-word}
 .big{font-size:22px;font-weight:700;line-height:1.1}
 .track{height:6px;border-radius:4px;background:#1c2a3f;overflow:hidden;flex:1}
 .fill{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#38bdf8,#34d399)}
 .metric{display:flex;align-items:center;gap:8px}
 .metric .name{width:46px;color:#7d8ea3;font-size:11px}
 .val{font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
 .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
 .chip{background:#16233a;color:#a9c1da;border-radius:999px;padding:1px 8px;font-size:11px}
 .ep{border-top:1px solid #1a2537;padding:5px 0;display:flex;gap:8px;justify-content:space-between}
 .ep:first-of-type{border-top:none}
 .ep .s{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .ep .t{color:#7d8ea3;font-size:11px;white-space:nowrap}
 .skill{padding:3px 0;border-top:1px solid #1a2537}
 .skill:first-of-type{border-top:none}
 .when{color:#7dd3fc;font-size:11px}
 .do{color:#dbe4ee}
 .spark{width:100%;height:38px;display:block;margin-top:4px}
 .foot{color:#7d8ea3;font-size:11px;margin-top:6px;display:flex;justify-content:space-between;gap:10px}
</style></head><body>
<h1><span class="dot" id="dot"></span>dsh-cerebrum 大脑面板</h1>
<div class="card" id="head"></div>
<div class="grid">
  <div class="card" id="affect"></div>
  <div class="card" id="neuro"></div>
  <div class="card" id="memory"></div>
  <div class="card" id="self"></div>
</div>
<div class="card" id="recent"></div>
<div class="grid">
  <div class="card" id="skills"></div>
  <div class="card" id="intent"></div>
</div>
<div class="card" id="wm"></div>
<div class="card" id="concepts"></div>
<div class="foot"><span id="updated">—</span><span id="uptime"></span></div>
<script>
var valHistory = []
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] }) }
function fmt(x, n) { return (Math.round(Number(x) * 100) / 100).toFixed(n == null ? 2 : n) }
function bar(label, value, max) {
  var v = Math.max(0, Math.min(1, Number(value) || 0))
  var pct = Math.round(v * 100)
  return '<div class="metric"><span class="name">' + esc(label) + '</span><span class="track"><span class="fill" style="width:' + (max ? Math.round(v / max * 100) : pct) + '%"></span></span><span class="val">' + (max ? Math.round(v) : pct + '%') + '</span></div>'
}
function rows(list) { return list.join('') }
function age(ts) {
  if (!ts) return '—'
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}
function render(s) {
  var e = s.affect.emotion
  var mood = s.affect.mood || {}
  var val = Number(s.affect.valence) || 0
  valHistory.push(val); if (valHistory.length > 120) valHistory.shift()
  var a = s.affinity || {}
  document.getElementById('dot').className = 'dot'
  document.getElementById('head').innerHTML =
    '<div class="row"><span><span class="big">' + esc(e.label) + '</span> <span class="muted">强度 ' + fmt(e.intensity) + '</span></span><span class="muted">' + esc(s.personality ? s.personality.label : '') + ' · ' + esc(a.level || '初见') + '</span></div>' +
    '<div class="muted">' + (e.cause ? '起因：' + esc(e.cause) : '心境效价 ' + fmt(mood.valence) + ' · 唤醒 ' + fmt(mood.arousal)) + '</div>'

  var pad = rows([
    '<div class="metric"><span class="name">愉悦</span><span class="track"><span class="fill" style="width:' + Math.round((val + 1) / 2 * 100) + '%"></span></span><span class="val">' + fmt(val) + '</span></div>',
    bar('唤醒', s.affect.arousal),
    bar('支配', (s.affect.dominance + 1) / 2),
  ])
  var spark = ''
  if (valHistory.length > 1) {
    var pts = valHistory.map(function (v, i) { return (i / (valHistory.length - 1) * 200).toFixed(1) + ',' + (20 - Math.max(-1, Math.min(1, v)) * 18).toFixed(1) })
    spark = '<svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none"><polyline fill="none" stroke="#38bdf8" stroke-width="1.6" points="' + pts.join(' ') + '"/></svg>'
  }
  document.getElementById('affect').innerHTML = '<h2>情绪 PAD</h2>' + pad + spark

  var n = s.neuromods || {}
  document.getElementById('neuro').innerHTML = '<h2>神经调质</h2>' +
    rows([bar('DA', n.da), bar('5-HT', n.ser), bar('NE', n.ne), bar('ACh', n.ach)])

  var m = s.memory || {}
  document.getElementById('memory').innerHTML = '<h2>记忆</h2>' +
    '<div class="row"><span class="k">情景</span><span>' + (m.episodes || 0) + ' 条</span></div>' +
    '<div class="row"><span class="k">概念 / 边</span><span>' + (m.concepts || 0) + ' / ' + (m.edges || 0) + '</span></div>' +
    '<div class="row"><span class="k">已巩固 / schema</span><span>' + (m.consolidated || 0) + ' / ' + (m.schema || 0) + '</span></div>' +
    '<div class="row"><span class="k">常驻 / 永久</span><span>' + (m.resident || 0) + ' / ' + (m.permastore || 0) + '</span></div>' +
    '<div class="row"><span class="k">平均稳定度</span><span>' + fmt(m.avgStabilityDays, 1) + ' 天</span></div>'

  var self = s.self || {}
  document.getElementById('self').innerHTML = '<h2>自我</h2>' +
    '<div class="row"><span class="k">身份</span><span>' + esc(self.identity || '—') + '</span></div>' +
    '<div class="row"><span class="k">价值</span><span>' + esc((self.values || []).join('、')) + '</span></div>' +
    '<div class="row"><span class="k">目标</span><span>' + esc((self.goals || []).slice(0, 2).join('；')) + '</span></div>' +
    '<div class="muted">计数：对话 ' + ((self.counters && self.counters.turns) || 0) + ' · 巩固 ' + ((self.counters && self.counters.consolidations) || 0) + '</div>'

  var recent = (s.recent || [])
  document.getElementById('recent').innerHTML = '<h2>最近记忆</h2>' + (recent.length
    ? recent.map(function (r) {
        var tone = r.affect ? ' · 情绪 ' + fmt(r.affect.valence) : ''
        return '<div class="ep"><span class="s">' + esc(r.summary) + '</span><span class="t">' + age(r.at) + ' 前' + tone + '</span></div>'
      }).join('')
    : '<div class="muted">还没有情景记忆</div>')

  var skills = (s.skills || []).slice(-6).reverse()
  document.getElementById('skills').innerHTML = '<h2>技能（when → do）</h2>' + (skills.length
    ? skills.map(function (k) {
        return '<div class="skill"><div class="when">' + esc((k.when || []).join(' · ')) + '</div><div class="do">' + esc(k.do) + '</div><div class="muted">强度 ' + fmt(k.strength) + ' · 用 ' + (k.uses || 0) + ' 次</div></div>'
      }).join('')
    : '<div class="muted">还没有沉淀出技能</div>')

  var it = s.intentions || {}
  document.getElementById('intent').innerHTML = '<h2>意图</h2>' +
    '<div class="row"><span class="k">待办</span><span>' + (it.active || 0) + '</span></div>' +
    '<div class="row"><span class="k">本轮命中</span><span>' + ((it.matched || []).length || 0) + '</span></div>' +
    ((it.matched || []).length ? '<div class="muted">' + esc(it.matched.join('；')) + '</div>' : '')

  var wm = s.workingMemory || []
  document.getElementById('wm').innerHTML = '<h2>工作记忆（' + wm.length + '/4）</h2>' + (wm.length
    ? wm.map(function (w) { return '<div class="row"><span class="s">' + esc(w.summary) + '</span><span class="muted">' + age(w.at) + ' 前</span></div>' }).join('')
    : '<div class="muted">空</div>')

  var cs = s.concepts || []
  document.getElementById('concepts').innerHTML = '<h2>近期概念</h2>' + (cs.length
    ? '<div class="chips">' + cs.map(function (c) { return '<span class="chip">' + esc(c.name) + '</span>' }).join('') + '</div>'
    : '<div class="muted">—</div>')

  document.getElementById('updated').textContent = '更新 ' + new Date().toLocaleTimeString()
  document.getElementById('uptime').textContent = '运行 ' + Math.round((s.uptimeMs || 0) / 60000) + ' 分钟 · ' + esc(s.dataDir || '')
}
function tick() {
  fetch('/state').then(function (r) { return r.json() }).then(function (s) { render(s) }).catch(function (err) {
    document.getElementById('dot').className = 'dot off'
    document.getElementById('head').innerHTML = '<div class="muted">读取失败：' + esc(err && err.message) + '</div>'
  })
}
tick(); setInterval(tick, 2500)
</script></body></html>`

const CORS_METHODS = 'GET, OPTIONS'
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/**
 * Access control for the loopback API (review feedback on dshplugin-index#121):
 * - Host must be a loopback host (blocks DNS rebinding).
 * - If the request carries an Origin (cross-origin browser fetch), it must also
 *   be a loopback origin — an arbitrary website can no longer read the brain.
 * - Optional shared token (`config.api.token`) for users who want a second lock.
 */
const checkAccess = (req, token) => {
  const host = String(req.headers.host ?? '')
  if (!LOOPBACK.test(host)) return { ok: false, status: 403, reason: 'host-not-allowed' }
  const origin = req.headers.origin
  if (origin && !LOOPBACK_ORIGIN.test(String(origin))) return { ok: false, status: 403, reason: 'origin-not-allowed' }
  if (token && req.headers['x-cerebrum-token'] !== token) return { ok: false, status: 401, reason: 'token-required' }
  return { ok: true }
}

const send = (res, status, payload, origin) => {
  if (origin) res.setHeader('Access-Control-Allow-Origin', String(origin))
  res.setHeader('Access-Control-Allow-Methods', CORS_METHODS)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cerebrum-token')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = status
  res.end(JSON.stringify(payload))
}

export const startBrainApi = (service, { port = 18734, ui = { enabled: true }, token = '', logger = console } = {}) => {
  // Interaction rate limit: /interact is the only mutation; cap it to stop flooding.
  let interactWindow = { at: 0, count: 0 }
  // Global request budget: a runaway page/poll can never hammer the brain.
  let requestWindow = { at: 0, count: 0 }
  const withinBudget = (limit = 240) => {
    const now = Date.now()
    if (now - requestWindow.at > 60_000) requestWindow = { at: now, count: 0 }
    requestWindow.count += 1
    return requestWindow.count <= limit
  }
  const counts = { ui: 0, state: 0, hints: 0, petAssets: 0, ping: 0 }
  // Diagnostics: who talks to us (origin :: user-agent :: path). Helps tell a
  // stale/broken client from an unfetchable port without devtools.
  const callers = new Map()
  const handler = (req, res) => {
    try {
      const callerKey = `${req.headers.origin || '-'} :: ${String(req.headers['user-agent'] || '-').slice(0, 40)} :: ${String(req.url || '').split('?')[0]}`
      callers.set(callerKey, (callers.get(callerKey) || 0) + 1)
    } catch {}
    const origin = req.headers.origin
    const allowedOrigin = origin && LOOPBACK_ORIGIN.test(String(origin)) ? String(origin) : null
    const access = checkAccess(req, token)
    if (!access.ok) return send(res, access.status, { error: access.reason }, allowedOrigin)
    if (!withinBudget()) return send(res, 429, { error: 'rate-limited' }, allowedOrigin)
    if (req.method === 'OPTIONS') {
      if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      res.setHeader('Access-Control-Allow-Methods', CORS_METHODS)
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cerebrum-token')
      res.setHeader('Vary', 'Origin')
      res.statusCode = 204
      return res.end()
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, allowedOrigin)
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    let path = url.pathname
    if (path === '/dsh-cerebrum') path = '/'
    else if (path.startsWith('/dsh-cerebrum/')) path = path.slice('/dsh-cerebrum'.length)
    const reply = (status, payload) => send(res, status, payload, allowedOrigin)
    if (path === '/' || path === '/dashboard') {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? 'http://127.0.0.1')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.statusCode = 200
      return res.end(DASHBOARD_HTML)
    }
    // Parts puppet v1: a self-rendered character page (no dsh-pet required).
    if (path === '/puppet' || path.startsWith('/puppet/')) {
      try {
        // Real 大肥鱼 expression art streamed from the installed dsh-pet package
        // (local, read-only; we do not redistribute CC BY-NC-SA assets).
        if (path === '/puppet/memes') {
          const { dir, memes } = service.puppetMemes()
          return reply(200, { dir: dir ? 'dsh-pet/assets/memes' : null, memes })
        }
        if (path.startsWith('/puppet/meme/')) {
          const name = decodeURIComponent(path.slice('/puppet/meme/'.length))
          const file = service.puppetMemeFile(name)
          if (!file) return reply(404, { error: 'meme-not-found' })
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? 'http://127.0.0.1')
          res.setHeader('Content-Type', 'image/png')
          res.setHeader('Cache-Control', 'public, max-age=3600')
          res.statusCode = 200
          return res.end(fs.readFileSync(file))
        }
        const file = path === '/puppet' ? 'index.html' : path.slice('/puppet/'.length)
        const safe = nodePath.basename(file)
        const full = nodePath.join(PUPPET_DIR, safe)
        if (!full.startsWith(PUPPET_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return reply(404, { error: 'puppet-not-found' })
        }
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', json: 'application/json; charset=utf-8' }
        const ext = nodePath.extname(safe).slice(1).toLowerCase()
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? 'http://127.0.0.1')
        res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        res.statusCode = 200
        return res.end(fs.readFileSync(full))
      } catch (error) {
        return reply(500, { error: `puppet failed: ${error.message}` })
      }
    }
    try {
      switch (path) {
        case '/ping':
          counts.ping += 1
          return reply(200, { ok: true, name: 'dsh-cerebrum', uptimeMs: Date.now() - service.startedAt, counts, callers: Object.fromEntries([...callers].slice(0, 25)) })
        case '/ui':
          // The client respects this: ui.enabled=false removes the chip entirely.
          counts.ui += 1
          return reply(200, { enabled: ui.enabled !== false, drivePet: ui.drivePet !== false, autonomy: ui.autonomy !== false, petMenu: ui.petMenu !== false })
        case '/pet-assets': {
          counts.petAssets += 1
          const emotion = url.searchParams.get('emotion') || undefined
          const kind = url.searchParams.get('kind') || undefined
          return reply(200, { assets: service.listPetAssets({ emotion, kind }) })
        }
        case '/state': {
          counts.state += 1
          const sessionId = url.searchParams.get('session') || undefined
          return reply(200, service.state(sessionId))
        }
        case '/recall': {
          const query = url.searchParams.get('q') ?? ''
          const sessionId = url.searchParams.get('session') || undefined
          // A read endpoint must not rehearse memory (no stability/RIF side effects).
          const hits = service.recall(query, { k: 3, sessionId, reinforce: false })
          return reply(200, {
            query,
            memories: hits.map((hit) => ({
              summary: hit.episode.summary,
              at: hit.episode.at,
              probability: Number(hit.probability.toFixed(3)),
              retention: hit.parts.r ?? null,
            })),
          })
        }
        case '/render-hints': {
          counts.hints += 1
          const sessionId = url.searchParams.get('session') || undefined
          return reply(200, service.renderHintsFor(sessionId))
        }
        case '/interact': {
          // The only mutation the API allows: affect-only pet interactions.
          const now = Date.now()
          if (now - interactWindow.at > 60_000) interactWindow = { at: now, count: 0 }
          interactWindow.count++
          if (interactWindow.count > 30) return reply(429, { error: 'too-many-interactions' })
          const kind = url.searchParams.get('kind') ?? ''
          const sessionId = url.searchParams.get('session') || undefined
          const hints = service.interact(kind, sessionId)
          if (!hints) return reply(400, { error: `unknown interaction kind, use one of ${INTERACTION_KINDS.join(', ')}` })
          return reply(200, hints)
        }
        default:
          if (path.startsWith('/asset/')) {
            const name = decodeURIComponent(path.slice('/asset/'.length))
            const file = service.assetFile(name)
            if (!file) return reply(404, { error: 'asset-not-found' })
            const types = {
              webm: 'video/webm', mp4: 'video/mp4', gif: 'image/gif', png: 'image/png',
              jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
            }
            res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? 'http://127.0.0.1')
            res.setHeader('Content-Type', types[file.ext] ?? 'application/octet-stream')
            res.setHeader('Cache-Control', 'public, max-age=3600')
            res.statusCode = 200
            fs.createReadStream(file.path).pipe(res)
            return
          }
          return reply(404, { error: 'unknown endpoint' })
      }
    } catch (error) {
      return reply(500, { error: error?.message ?? 'internal error' })
    }
  }
  const server = http.createServer(handler)

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger?.warn?.(`[cerebrum] api port ${port} is in use; brain UI will be unavailable (set config.api.port)`)
    } else {
      logger?.error?.('[cerebrum] api server failed:', error?.message ?? error)
    }
  })

  server.listen(port, '127.0.0.1', () => {
    logger?.log?.(`[cerebrum] brain api listening on http://127.0.0.1:${port}`)
  })
  // The dashboard is a leaf service: it must never keep the host process alive.
  if (typeof server.unref === 'function') server.unref()

  return {
    port,
    /** Request handler, reusable for a same-origin route on the host web server. */
    handler,
    close() {
      server.close()
    },
  }
}
