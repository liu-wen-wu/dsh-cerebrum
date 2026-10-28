/**
 * One-command release: test → load-check → privacy → pack → publish → verify → tag.
 *
 * Auth: npm token via NPM_CONFIG_USERCONFIG/.npmrc (or ~/.npmrc). Never pass a
 * token as a CLI argument — it would end up in shell history and process lists.
 *
 * Usage:
 *   node scripts/release.mjs            # full release
 *   node scripts/release.mjs --dry-run  # checks + pack only
 *   node scripts/release.mjs --no-push  # publish but do not push the tag
 *   OTP=123456 node scripts/release.mjs # 2FA-protected publish
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const name = pkg.name
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const confirmed = args.has('--yes')
const noPush = args.has('--no-push')
const otp = process.env.OTP || ''
const gateway = `https://registry.npmjs.org/${name.replace('/', '%2F')}`

const run = (label, argv, opts = {}) => {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, stdio: 'inherit', env: { ...process.env }, ...opts })
  if (result.status !== 0) {
    console.error(`\n✖ ${label} failed (exit ${result.status})`)
    process.exit(result.status ?? 1)
  }
}

/** Find pnpm: explicit env → PATH → DSH bundled runtime. */
const resolvePnpm = () => {
  if (process.env.PNPM_BIN && fs.existsSync(process.env.PNPM_BIN)) return process.env.PNPM_BIN
  const direct = spawnSync('pnpm', ['--version'])
  if (direct.status === 0) return 'pnpm'
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const runtimes = path.join(home, 'dsh-runtimes')
  if (fs.existsSync(runtimes)) {
    for (const entry of fs.readdirSync(runtimes)) {
      const candidate = path.join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
      if (fs.existsSync(candidate)) return `node:${candidate}`
    }
  }
  console.error('✖ pnpm not found. Set PNPM_BIN or install pnpm.')
  process.exit(1)
}

const pnpmCommand = (argsList) => {
  const pnpm = resolvePnpm()
  if (pnpm.startsWith('node:')) return [process.execPath, pnpm.slice(5), ...argsList]
  return [pnpm, ...argsList]
}

const registryVersion = async () => {
  try {
    const res = await fetch(gateway)
    if (!res.ok) return null
    const doc = await res.json()
    return doc['dist-tags']?.latest ?? null
  } catch {
    return null
  }
}

const main = async () => {
  console.log(`dsh-cerebrum release → ${name}@${version}${dryRun ? ' (dry-run)' : ''}`)
  if (pkg.private === true) {
    console.error('✖ package.json is still private')
    process.exit(1)
  }

  run('tests (node --test)', [process.execPath, '--test'])
  run('load-check (real Cordis)', [process.execPath, 'scripts/load-check.mjs'])
  run('privacy-check', [process.execPath, 'scripts/privacy-check.mjs'])

  const published = await registryVersion()
  if (!dryRun && published === version) {
    console.error(`✖ ${name}@${version} is already published`)
    process.exit(1)
  }

  run('pack (verify tarball)', pnpmCommand(['pack']))
  const tarball = `${name.replace('/', '-')}-${version}.tgz`
  for (const file of fs.readdirSync(root)) {
    if (file === tarball || file.endsWith(`-${version}.tgz`)) fs.rmSync(path.join(root, file), { force: true })
  }

  if (dryRun) {
    console.log('\n✓ dry-run complete (tests + checks + pack). Nothing published.')
    return
  }

  // Releases are approval-gated: the maintainer must explicitly confirm.
  if (!confirmed) {
    console.log('\n✋ 发布需要脚本参数 --yes（用户明确同意后才可发布）。')
    console.log('   已完成的检查 + 打包已通过；确认发版后运行：node scripts/release.mjs --yes')
    return
  }

  const publishArgs = pnpmCommand(['publish', '--access', 'public', '--no-git-checks'])
  if (otp) publishArgs.push(`--otp=${otp}`)
  run(`publish ${name}@${version}`, publishArgs)

  console.log('\n▶ waiting for registry to settle (staged publishes need approval)…')
  let live = null
  for (let i = 0; i < 36; i++) {
    live = await registryVersion()
    if (live === version) break
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  if (live === version) {
    console.log(`✓ ${name}@${version} is live (latest)`)
  } else {
    console.log(`⚠ registry still reports latest=${live ?? 'unknown'} — if this is npm staged publishing, approve it at https://www.npmjs.com/package/${name}`)
  }

  if (!noPush) {
    try {
      execFileSync('git', ['tag', '-f', `v${version}`], { cwd: root, stdio: 'inherit' })
      execFileSync('git', ['push', 'origin', `v${version}`], { cwd: root, stdio: 'inherit' })
      console.log(`✓ tag v${version} pushed`)
    } catch (error) {
      console.log(`⚠ git tag/push skipped: ${error.message}`)
    }
  }
  console.log('\nDone.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
