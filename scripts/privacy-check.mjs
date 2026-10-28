/**
 * Privacy self-check: scans the shipped source and docs for machine-local
 * secrets or absolute paths that must never enter a published package
 * (patterned after dsh-persona-dafeiyu's scripts/privacy-check).
 *
 * Run with: npm run privacy
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const scanDirs = ['lib', 'scripts', 'test', 'examples', 'docs', 'python']
const scanFiles = ['package.json', 'README.md', 'cordis.patch.yml', '.gitignore']

const patterns = [
  { name: 'Windows 绝对用户路径', re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i },
  { name: '类 Unix 家目录绝对路径', re: /\/home\/[A-Za-z0-9._-]+\// },
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: '私钥块', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: '类密钥串', re: /\b(sk-[A-Za-z0-9]{16,}|AKID[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{16,})\b/ },
  { name: '硬编码 D 盘绝对路径', re: /D:\\deepseek-harness/i },
]

const findings = []
const files = []
for (const dir of scanDirs) {
  const full = path.join(root, dir)
  if (!fs.existsSync(full)) continue
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(js|mjs|json|yml|md|py|txt)$/i.test(entry.name)) files.push(p)
    }
  }
  walk(full)
}
files.push(...scanFiles.map((f) => path.join(root, f)))

for (const file of files) {
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const { name, re } of patterns) {
    for (const match of text.matchAll(new RegExp(re.source, 'gi'))) {
      findings.push(`${path.relative(root, file)}: ${name} -> ${match[0].slice(0, 60)}`)
    }
  }
}

if (findings.length > 0) {
  console.error(`隐私自查失败，${findings.length} 处可疑内容：`)
  for (const finding of findings) console.error('  ' + finding)
  process.exit(1)
}
console.log(`隐私自查通过：扫描 ${files.length} 个文件，无可疑内容。`)
