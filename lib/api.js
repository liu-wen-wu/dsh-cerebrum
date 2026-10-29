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
 body{margin:0;background:#0d1420;color:#dbe4ee;font:13px/1.6 system-ui,sans-serif;padding:14px}
 @media (prefers-color-scheme: light){body{background:#f6f8fb;color:#1f2937}.card{background:#fff!important;border-color:#e3e8ef!important}.k,.muted{color:#6b7280!important}}
 h1{font-size:16px;margin:0 0 12px}
 .card{border:1px solid #1f2c3f;border-radius:10px;padding:12px 14px;margin-bottom:12px;background:#101a28}
 .k{color:#7d8ea3;display:inline-block;min-width:70px}
 .bar{display:inline-block;height:8px;border-radius:4px;background:#5ec8f2;vertical-align:middle;margin-left:8px}
 .v{color:#9ef0c0}
 .row{display:flex;justify-content:space-between;gap:12px}
 .muted{color:#7d8ea3;font-size:12px}
</style></head><body>
<h1>🧠 dsh-cerebrum 大脑面板</h1>
<div class="card" id="affect">读取中…</div>
<div class="card" id="memory"></div>
<div class="card" id="neuro"></div>
<div class="card" id="extra"></div>
<div class="muted">数据来自本机只读 API；修改请通过 cerebrum_* 工具。</div>
<script>
const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2)
const bar = (v) => '<span class="bar" style="width:' + Math.round(Math.max(0, Math.min(1, v)) * 120) + 'px"></span>'
async function tick() {
  try {
    const s = await (await fetch('/state')).json()
    const e = s.affect.emotion
    document.getElementById('affect').innerHTML =
      '<div class="row"><span><span class="k">人格</span>' + (s.personality?.label ?? '—') + '</span></div>' +
      '<div class="row"><span><span class="k">情绪</span>' + e.label + '（' + fmt(e.intensity) + '）</span><span class="muted">' + (e.cause || '') + '</span></div>' +
      '<div class="row"><span><span class="k">效价</span>' + bar((s.affect.valence + 1) / 2) + '</span><span class="v">' + fmt(s.affect.valence) + '</span></div>' +
      '<div class="row"><span><span class="k">唤醒</span>' + bar(s.affect.arousal) + '</span><span class="v">' + fmt(s.affect.arousal) + '</span></div>' +
      '<div class="row"><span><span class="k">支配</span>' + bar((s.affect.dominance + 1) / 2) + '</span><span class="v">' + fmt(s.affect.dominance) + '</span></div>'
    const m = s.memory
    document.getElementById('memory').innerHTML =
      '<div class="row"><span><span class="k">记忆</span>' + m.episodes + ' 情景 · ' + m.concepts + ' 概念</span><span class="muted">常驻 ' + (m.resident ?? 0) + '</span></div>' +
      '<div class="row"><span><span class="k">技能/意图</span>' + (s.skillCount ?? 0) + ' 条 · 待办 ' + (s.intentions?.active ?? 0) + '</span><span class="muted">好感 ' + (s.affinity?.level ?? '—') + '</span></div>' +
      '<div class="row"><span><span class="k">近期主题</span>' + (s.concepts || []).map(c => c.name).join('、') + '</span></div>'
    const n = s.neuromods
    document.getElementById('neuro').innerHTML =
      '<div class="row"><span><span class="k">DA / 5HT</span>' + bar(n.da) + ' ' + bar(n.ser) + '</span></div>' +
      '<div class="row"><span><span class="k">NE / ACh</span>' + bar(n.ne) + ' ' + bar(n.ach) + '</span></div>'
    document.getElementById('extra').innerHTML =
      '<div class="row"><span><span class="k">工作记忆</span>' + ((s.workingMemory || []).map(x => x.summary).join(' ｜ ') || '—') + '</span></div>' +
      '<div class="row"><span><span class="k">数据目录</span><span class="muted">' + (s.dataDir || '') + '</span></span></div>'
  } catch (err) {
    document.getElementById('affect').textContent = '读取失败：' + err.message
  }
}
tick(); setInterval(tick, 3000)
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
