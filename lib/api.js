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

import http from 'node:http'
import { INTERACTION_KINDS } from './core/petbrain.js'

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
}

const send = (res, status, payload) => {
  cors(res)
  res.statusCode = status
  res.end(JSON.stringify(payload))
}

export const startBrainApi = (service, { port = 18734, logger = console } = {}) => {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    try {
      switch (url.pathname) {
        case '/ping':
          return send(res, 200, { ok: true, name: 'dsh-cerebrum', uptimeMs: Date.now() - service.startedAt })
        case '/state': {
          const sessionId = url.searchParams.get('session') || undefined
          return send(res, 200, service.state(sessionId))
        }
        case '/recall': {
          const query = url.searchParams.get('q') ?? ''
          const sessionId = url.searchParams.get('session') || undefined
          const hits = service.recall(query, { k: 3, sessionId })
          return send(res, 200, {
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
          return send(res, 200, service.renderHintsFor(sessionId))
        }
        case '/interact': {
          // The only mutation the API allows: affect-only pet interactions.
          const kind = url.searchParams.get('kind') ?? ''
          const sessionId = url.searchParams.get('session') || undefined
          const hints = service.interact(kind, sessionId)
          if (!hints) return send(res, 400, { error: `unknown interaction kind, use one of ${INTERACTION_KINDS.join(', ')}` })
          return send(res, 200, hints)
        }
        default:
          return send(res, 404, { error: 'unknown endpoint' })
      }
    } catch (error) {
      return send(res, 500, { error: error?.message ?? 'internal error' })
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
