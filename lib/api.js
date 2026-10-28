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
import { INTERACTION_KINDS } from './core/petbrain.js'

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
  const server = http.createServer((req, res) => {
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
    const reply = (status, payload) => send(res, status, payload, allowedOrigin)
    try {
      switch (url.pathname) {
        case '/ping':
          return reply(200, { ok: true, name: 'dsh-cerebrum', uptimeMs: Date.now() - service.startedAt })
        case '/ui':
          // The client respects this: ui.enabled=false removes the chip entirely.
          return reply(200, { enabled: ui.enabled !== false, drivePet: ui.drivePet !== false, autonomy: ui.autonomy !== false, petMenu: ui.petMenu !== false })
        case '/pet-assets': {
          const emotion = url.searchParams.get('emotion') || undefined
          const kind = url.searchParams.get('kind') || undefined
          return reply(200, { assets: service.listPetAssets({ emotion, kind }) })
        }
        case '/state': {
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
          if (url.pathname.startsWith('/asset/')) {
            const name = decodeURIComponent(url.pathname.slice('/asset/'.length))
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
  })

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
    close() {
      server.close()
    },
  }
}
