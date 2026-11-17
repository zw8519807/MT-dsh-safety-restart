// 路径与 home 解析。单独一个文件是因为**每一处都必须能失败而不抛**：
// 这个插件的工作是"让 DSH 重新起来"，它自己绝不能因为读不到一个文件就把
// 重启这件事整个搞砸。
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

/** DSH_HOME：与宿主其它部分同一套规则（环境变量优先，否则 ~/.dsh）。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

/** 审计日志：只追加，不覆盖。重启这种事必须留痕。 */
export const auditFile = () => join(dshHome(), 'safety-restart-audit.jsonl')
/** 续作标记：重启前写，重启后消费。 */
export const resumeFile = () => join(dshHome(), 'safety-restart-resume.json')
/** 配置：与宿主 settings 并存的一个小 JSON，人手可改。 */
export const configFile = () => join(dshHome(), 'safety-restart.json')

/**
 * 找出本插件被装进的那个 profile 根目录。
 *
 * ★ 为什么不能用 import.meta.url 往上走：profile 里通常是 `link:` 安装，
 *   而 Node 默认解析符号链接，`import.meta.url` 给的是**仓库真实路径**
 *   （D:/Harness/dsh-safety-restart），往上走是 D:/Harness，不是 profile。
 *   所以改成"在 $DSH_HOME/profiles/<每个 profile>/node_modules/<包名> 里找自己" ——
 *   这条路对 link: 安装和普通安装**都成立**，因为两种情况下 profile 里
 *   都留下一个指向/包含本包的条目。
 *
 * 找不到就返回 null，调用方必须如实说"没查到"，而不是假装查过了。
 */
export function findProfileRoot(pkgName = 'dsh-safety-restart') {
  const profiles = join(dshHome(), 'profiles')
  let dirs = []
  try { dirs = readdirSync(profiles, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return null }
  const hits = []
  for (const name of dirs) {
    const candidate = join(profiles, name)
    if (existsSync(join(candidate, 'node_modules', pkgName))) hits.push(candidate)
  }
  // 装了多个 profile 时无法判断"当前这个"，宁可返回 null 让调用方如实降级 ——
  // 猜错的后果是拿**别人的** bundle 表去决定要不要重启，比不检查更糟。
  return hits.length === 1 ? hits[0] : null
}

/** 读一个 JSON 文件，任何失败都退化成 fallback（不抛）。 */
export function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export { dirname }
