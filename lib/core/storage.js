/**
 * Local persistence for the cerebrum.
 *
 * The store is intentionally boring: JSON documents plus append-only JSONL.
 * Memory is the most valuable state in the system, so every write is atomic
 * (temp file + rename) and every load tolerates a truncated last line.
 *
 * Layout (per workspace):
 *   $DSH_HOME/cerebrum/<workspace-slug>/
 *     personality.json  affect.json  self.json  concepts.json  edges.json
 *     episodes.jsonl    meta.json
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const resolveHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

export const workspaceSlug = (cwd) => {
  const base = path.basename(cwd || process.cwd()).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'workspace'
  let hash = 0
  const input = String(cwd || '')
  for (let i = 0; i < input.length; i++) hash = (Math.imul(hash, 31) + input.charCodeAt(i)) >>> 0
  return `${base.slice(0, 48)}-${hash.toString(36).slice(0, 6)}`
}

export const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export const readJson = (file, fallback) => {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.trim().length === 0) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export const atomicWrite = (file, text) => {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export const writeJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2))

/** Read a JSONL file, skipping malformed lines (e.g. a torn final append). */
export const readJsonl = (file) => {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      skipped++
    }
  }
  if (skipped > 0) out.skipped = skipped
  return out
}

/**
 * Append-only log with an in-memory mirror. Appends are cheap; compaction
 * rewrites the whole file through an atomic rename.
 */
export class JsonlLog {
  constructor(file) {
    this.file = file
    this.items = readJsonl(file)
    this.skipped = this.items.skipped ?? 0
    delete this.items.skipped
  }

  append(item) {
    this.items.push(item)
    ensureDir(path.dirname(this.file))
    fs.appendFileSync(this.file, `${JSON.stringify(item)}\n`, 'utf8')
    return item
  }

  rewrite(items) {
    this.items = items.slice()
    atomicWrite(this.file, items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : ''))
  }
}

/**
 * Debounced writer. The host may be killed at any time, so callers also flush
 * on dispose; the debounce only protects against write amplification.
 */
export class DebouncedWriter {
  constructor({ delayMs = 400, label = 'cerebrum' } = {}) {
    this.delayMs = delayMs
    this.label = label
    this.timer = null
    this.pending = new Map()
    this.closed = false
  }

  schedule(key, write) {
    if (this.closed) return
    this.pending.set(key, write)
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [key, write] of this.pending) {
      try {
        write()
      } catch (error) {
        // Persistence failures must not take down the agent loop; they are logged once.
        console.error(`[${this.label}] failed to persist ${key}:`, error?.message ?? error)
      }
    }
    this.pending.clear()
  }

  close() {
    this.flush()
    this.closed = true
  }
}
