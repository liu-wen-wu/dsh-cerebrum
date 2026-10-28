/**
 * dsh-cerebrum — a brain-inspired cognitive architecture for DeepSeek Harness.
 *
 * Wiring (host side only; no client bundle, no runtime import from the harness):
 *   - CerebrumService owns memory/affect/personality/self state for this workspace;
 *   - session/event observation turns finished turns into episodes automatically;
 *   - six model-facing tools expose deliberate recall, writing, judgment, appraisal,
 *     consolidation and personality control;
 *   - a static prompt section plus a dynamic runtime-context snapshot keep the model
 *     aware of its own state without rewriting the cached prompt prefix.
 */

import { spawn } from 'node:child_process'

import { resolveConfig, configSnapshot } from './config.js'
import { startBrainApi } from './api.js'
import { registerPrompt } from './prompt.js'
import { CerebrumService } from './service.js'
import { buildTools } from './tools.js'

export const name = 'cerebrum'

/** Hard dependency: the tool registry. The prompt registry is optional. */
export const inject = ['tools']

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  let service
  try {
    service = new CerebrumService(config)
  } catch (error) {
    console.error('[cerebrum] failed to initialize; the plugin will stay inactive:', error?.message ?? error)
    return
  }

  ctx.effect(() => () => service.dispose(), 'cerebrum:dispose')

  const disposeEvents = ctx.on('session/event', (session, event) => service.onSessionEvent(session, event))
  ctx.effect(() => disposeEvents, 'cerebrum:session-events')

  for (const tool of buildTools(service)) {
    ctx.effect(() => ctx.tools.register(tool), `cerebrum:tool:${tool.name}`)
  }

  registerPrompt(ctx, service, config)

  // Idle replay: a light "sleep" pass that consolidates without a model call.
  const timer = setInterval(() => {
    try {
      service.consolidateIdle()
    } catch (error) {
      console.error('[cerebrum] idle consolidation failed:', error?.message ?? error)
    }
  }, Math.min(config.consolidation.intervalMs, 10 * 60 * 1000))
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'cerebrum:idle-timer')

  // Read-only loopback API powering the optional client UI (dock + dashboard).
  const webServerOf = () => {
    try {
      return ctx.get?.('webServer') ?? ctx.webServer ?? null
    } catch {
      return null
    }
  }
  if (config.api.enabled) {
    const api = startBrainApi(service, { port: config.api.port, ui: config.ui, token: config.api.token })
    ctx.effect(() => () => api.close(), 'cerebrum:brain-api')
    // Same-origin mount: the in-app client can use relative /dsh-cerebrum/* URLs,
    // dodging CORS, CSP connect-src and loopback-proxy traps of a cross-origin port.
    const registerRoute = () => {
      try {
        const ws = webServerOf()
        if (!ws || typeof ws.register !== 'function') return false
        const dispose = ws.register({ kind: 'prefix', path: '/dsh-cerebrum', handler: api.handler })
        ctx.effect(() => dispose, 'cerebrum:web-route')
        return true
      } catch {
        return false
      }
    }
    if (!registerRoute() && typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], () => registerRoute())
      } catch {
        /* no web server in this runtime (e.g. headless) */
      }
    }
  }

  // Host-side pet menu: dsh-pet keeps third-party menu items in process memory,
  // so the plugin must re-register after every DSH restart. Doing this on the
  // host (using the webServer origin) works even when the browser bundle is
  // stale — the menu click is consumed by a poller here, not in the page.
  if (config.ui.petMenu) {
    // Resolve the web server lazily: it may register after this plugin applies.
    const webServerOf = () => {
      try {
        return ctx.get?.('webServer') ?? ctx.webServer ?? null
      } catch {
        return null
      }
    }
    const originOf = () => {
      try {
        return webServerOf()?.getOrigin?.() ?? null
      } catch {
        return null
      }
    }
    const menuLabels = ['🧠 大脑面板', '💗 摸摸头', '🍙 喂食', '✨ 夸夸', '😤 批评', '📊 播报状态', '🧠 整理记忆']
    const petBase = () => {
      const origin = originOf()
      return origin ? `${origin.replace(/\/$/, '')}/dsh-pet-7340` : null
    }
    const petJson = async (path, init) => {
      const base = petBase()
      if (!base) return null
      try {
        const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) })
        return res.ok ? await res.json() : null
      } catch {
        return null
      }
    }
    const say = async (text) => {
      const state = await petJson('/state')
      // Desktop-only pets are absent from /state.pets; the configured id is "main".
      const petId = (state?.pets && Object.keys(state.pets)[0]) || 'main'
      const q = `?pet=${encodeURIComponent(petId)}&surface=desktop`
      const lock = await petJson(`/lock${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 8000, surface: 'desktop' }) })
      if (!lock?.lockId) return
      await petJson(`/broadcast${q}&lock=${encodeURIComponent(lock.lockId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 120), duration: 6000 }),
      })
      await petJson(`/lock/release${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lockId: lock.lockId }) })
    }
    // Register exactly once per plugin load, with bounded retries while dsh-pet
    // finishes mounting. No periodic re-registration: the menu lives as long as
    // this DSH process, and a restart reloads this plugin anyway.
    const registerMenu = async (attempts = 10, delayMs = 3000) => {
      for (let i = 0; i < attempts; i++) {
        const result = await petJson('/menu/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: 'cerebrum', labels: menuLabels, target: 'both' }),
        })
        if (result?.ok) return true
        await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
      }
      return false
    }
    const handleMenu = async (events) => {
      if (!events) return
      if (events['🧠 大脑面板']) {
        // Open the standalone dashboard; works even when the in-page client is stale.
        const url = `http://127.0.0.1:${config.api.port}/`
        try {
          const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
          spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
        } catch {
          /* the dashboard URL is also shown in tool output */
        }
      }
      if (events['💗 摸摸头']) service.interact('pet')
      if (events['🍙 喂食']) service.interact('feed')
      if (events['✨ 夸夸']) service.interact('praise')
      if (events['😤 批评']) service.interact('scold')
      if (events['📊 播报状态']) {
        const state = service.state()
        await say(`情绪 ${state.affect.emotion.label} · 记忆 ${state.memory.episodes} 条 · 技能 ${state.skillCount ?? 0} · 好感 ${state.affinity?.level ?? '—'}`)
      }
      if (events['🧠 整理记忆']) {
        const report = service.consolidate({ stage: 'both' })
        await say(`整理完成：${report.semanticNodes} 条语义 · ${report.schemaEpisodes} 条 schema`)
      }
    }
    // Register once, as soon as the web server is available (Cordis inject),
    // falling back to the bounded retry loop on older runtimes.
    const startRegistration = () => {
      registerMenu().catch(() => {})
    }
    if (typeof ctx.inject === 'function' && webServerOf() === null) {
      try {
        ctx.inject(['webServer'], () => startRegistration())
      } catch {
        startRegistration()
      }
    } else {
      startRegistration()
    }
    // Event polling is inherent to dsh-pet's menu API (clicks are read-and-consume).
    const menuTimer = setInterval(() => {
      petJson('/menu/events?owner=cerebrum&wait=0').then((payload) => handleMenu(payload?.events)).catch(() => {})
    }, 6000)
    if (typeof menuTimer.unref === 'function') menuTimer.unref()
    ctx.effect(() => () => clearInterval(menuTimer), 'cerebrum:pet-menu')
    ctx.effect(() => () => {
      petJson('/menu/item?owner=cerebrum', { method: 'DELETE' }).catch(() => {})
    }, 'cerebrum:pet-menu-cleanup')
  }

  // A sibling plugin or a UI can read the live service without importing internals.
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('cerebrum', service)
    } catch {
      /* Already provided by another instance; tools and the prompt still work. */
    }
  } else if (typeof ctx.set === 'function') {
    try {
      ctx.set('cerebrum', service)
    } catch {
      /* Older Cordis reserves ctx.set; tools and the prompt still work. */
    }
  }

  if (config.debug) console.log('[cerebrum] active', configSnapshot(config))
}
