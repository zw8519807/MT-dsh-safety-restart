// 跑全部自检。只有一个套件也走这条路 —— 将来加了套件不用改 CI 或说明文档。
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(here).filter(f => /^verify-.*\.mjs$/.test(f)).sort()
let bad = 0
for (const f of suites) {
  console.log('\n===== ' + f + ' =====')
  try {
    execFileSync(process.execPath, [join(here, f)], { stdio: 'inherit' })
  } catch {
    bad++
    console.log('FAIL ' + f)
  }
}
console.log('\n' + (bad === 0 ? '全部套件通过（' + suites.length + ' 个）' : bad + ' 个套件失败'))
process.exit(bad === 0 ? 0 : 1)
