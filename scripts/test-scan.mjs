import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const only = process.argv[2]
const files = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).filter((f) => !only || f.includes(only))
for (const file of files) {
  const started = Date.now()
  const result = spawnSync(process.execPath, ['--test', `test/${file}`], { timeout: 25000, encoding: 'utf8' })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const failed = /fail [1-9]/.test(out)
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM' || (result.status === null && !result.signal)
  console.log(`${timedOut ? 'TIMEOUT' : failed ? 'FAIL' : 'ok     '}  ${file}  ${Math.round((Date.now() - started) / 1000)}s`)
  if (failed && !timedOut) {
    const line = out.split('\n').filter((l) => /✖|AssertionError|Error:/.test(l)).slice(0, 4).join(' | ')
    console.log(`   ${line.slice(0, 220)}`)
  }
}
