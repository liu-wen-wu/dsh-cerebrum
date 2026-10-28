/**
 * Market status: is dsh-cerebrum listed in the community index yet?
 *
 * Checks:
 *   1. dshopen.org/index.json  → is our package name present (listed = approved)?
 *   2. the inclusion issue      → open (pending review) / closed (decided)
 *
 * Run: node scripts/check-market.mjs [--json]
 */

const INDEX = 'https://dshopen.org/index.json'
const ISSUE = 'https://api.github.com/repos/polang233/dsh-plugin-index/issues/121'
const NAME = 'dsh-cerebrum'

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-cerebrum-market-check', Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

const proxyHint = () =>
  'index 抓取失败：如果本机走代理，请用 NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... 运行本脚本，或直接用浏览器打开 https://dshopen.org/zh/plugins/dsh-cerebrum/'

const main = async () => {
  const jsonMode = process.argv.includes('--json')
  const report = { listed: false, entry: null, issue: null, badgeUrl: `https://dshopen.org/badge/${NAME}.json` }

  try {
    const index = await fetchJson(INDEX)
    const plugins = Array.isArray(index.plugins) ? index.plugins : []
    const entry = plugins.find((plugin) => plugin.name === NAME || plugin.name === `@liu-wen-wu/${NAME}`)
    report.listed = Boolean(entry)
    if (entry) {
      report.entry = {
        name: entry.name,
        description: entry.description?.zh ?? entry.description?.en ?? '',
        rank: entry.metadata?.sortKeys?.rank ?? null,
        stars: entry.metadata?.sortKeys?.stars ?? null,
        page: `https://dshopen.org/zh/plugins/${entry.name}/`,
      }
    }
  } catch (error) {
    report.indexError = error.message
    report.indexHint = proxyHint()
  }

  try {
    const issue = await fetchJson(ISSUE)
    report.issue = { state: issue.state, title: issue.title, comments: issue.comments, url: issue.html_url }
  } catch (error) {
    report.issueError = error.message
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`市场收录状态：${NAME}`)
  console.log(report.listed ? '✓ 已收录（dshopen 索引里能找到）' : '· 尚未收录（审核中或未申请）')
  if (report.entry) {
    console.log(`  索引条目：${report.entry.name}｜rank ${report.entry.rank ?? '-'}｜★ ${report.entry.stars ?? '-'}`)
    console.log(`  页面：${report.entry.page}`)
    console.log(`  徽章：${report.badgeUrl}`)
  }
  if (report.issue) {
    const stateText = report.issue.state === 'closed' ? '已关闭（通常意味着已处理）' : '仍开启（等待审核）'
    console.log(`收录 issue #121：${stateText}｜评论 ${report.issue.comments} 条`)
    console.log(`  ${report.issue.url}`)
  }
  for (const [key, value] of Object.entries(report)) {
    if (key.endsWith('Error') && value) console.log(`  (${key}: ${value})`)
  }
  if (report.indexHint) console.log(`  ${report.indexHint}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
