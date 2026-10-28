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
  if (config.api.enabled) {
    const api = startBrainApi(service, { port: config.api.port, ui: config.ui, token: config.api.token })
    ctx.effect(() => () => api.close(), 'cerebrum:brain-api')
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
