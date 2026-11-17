// 重启前的体检。四道闸里的三道在这里。
//
// ── 为什么需要它们（每一条都对应一次真实的踩坑）──
//
// 1) bundle 能不能解析 —— pnpm 的一次 `-29` 级联裁剪就可能让 profile 处于
//    "装机不完整"的边缘状态。**重启进一个坏掉的 profile，得到的是一个起不来
//    的 app**，而"起不来"意味着连报错界面都没有，只能去翻日志。所以宁可不重启。
//
// 2) 有没有别的会话正在跑一轮 —— 盲着重启会把别人正在做的事**从中间切断**。
//    切断了还不算完：那一轮的工具调用结果未知，重试与否要靠模型判断，
//    而它已经不知道发生了什么。所以默认拒绝，要强行重启得显式 force。
//
// 3) 有没有可靠的拉起手段 —— 桌面端只有 app.relaunch() 一条正路。
//    拿不到它的时候**不能**退化成"杀进程"：那会把 app 关掉而不拉起来，
//    把一个可恢复的状态变成不可恢复的。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 检查 profile 的 bundle 表里每一条是否**解析得到、且入口文件存在**。
 *
 * ★ 这是**轻量**检查，不是完整可加载性扫描：它只证明"包在、入口文件在"，
 *   不证明它能被 import 成功、更不证明它的客户端半在 slot 契约上是对的
 *   （真实案例：某插件客户端半在 list 型 slot 上少传 id，模块能取到
 *   HTTP 200，但真正挂载时抛异常）。要那一层的检查得用完整的 bundle scan。
 *   这里的定位是"最低成本的、能挡住最常见的'重启进死状态'的闸"。
 *
 * @returns { ok, checked, total, bad: [{name, why}] , why? }
 */
export function checkBundles(profileRoot) {
  if (!profileRoot) {
    // 查不到 profile 就**如实说不确定**。返回 ok:true 会是假的安全感。
    return { ok: false, checked: false, total: 0, bad: [], why: '找不到 profile 根目录，无法检查 bundle 表' }
  }
  let manifest
  try { manifest = JSON.parse(readFileSync(join(profileRoot, 'package.json'), 'utf8')) } catch (e) {
    return { ok: false, checked: false, total: 0, bad: [], why: '读不到 profile 的 package.json：' + String(e?.message ?? e) }
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) {
    return { ok: false, checked: false, total: 0, bad: [], why: 'profile 的 dsh.profile.bundles 不是非空数组' }
  }
  const bad = []
  for (const name of bundles) {
    if (typeof name !== 'string' || !name) { bad.push({ name: String(name), why: '不是合法包名' }); continue }
    // 官方包由宿主自己提供，profile 的 node_modules 里通常没有 —— 它们不是"坏"。
    if (name.startsWith('@deepseek-ai/')) continue
    const pkgDir = join(profileRoot, 'node_modules', name)
    const pkgJson = join(pkgDir, 'package.json')
    if (!existsSync(pkgJson)) { bad.push({ name, why: 'node_modules 里没有这个包（装机不完整或被 prune 掉了）' }); continue }
    let entry = null
    try {
      const pj = JSON.parse(readFileSync(pkgJson, 'utf8'))
      entry = resolveEntry(pj)
    } catch (e) { bad.push({ name, why: 'package.json 读不了：' + String(e?.message ?? e) }); continue }
    if (entry && !existsSync(join(pkgDir, entry))) bad.push({ name, why: '入口文件不存在：' + entry })
  }
  return { ok: bad.length === 0, checked: true, total: bundles.length, bad }
}

/** 从 package.json 里挑出入口文件（exports['.'] 优先，其次 main）。 */
export function resolveEntry(pj) {
  try {
    const ex = pj?.exports
    if (typeof ex === 'string') return ex.replace(/^\.\//, '')
    const dot = ex && typeof ex === 'object' ? (ex['.'] ?? null) : null
    if (typeof dot === 'string') return dot.replace(/^\.\//, '')
    // 条件导出：按 Node 自己的解析顺序取第一个能用的字符串
    if (dot && typeof dot === 'object') {
      for (const k of ['import', 'module', 'default', 'require']) {
        const v = dot[k]
        if (typeof v === 'string') return v.replace(/^\.\//, '')
        if (v && typeof v === 'object') {
          for (const k2 of ['import', 'default', 'require']) {
            if (typeof v[k2] === 'string') return v[k2].replace(/^\.\//, '')
          }
        }
      }
    }
  } catch { /* 落到 main */ }
  if (typeof pj?.main === 'string' && pj.main) return pj.main.replace(/^\.\//, '')
  return null
}

/**
 * 谁在跑一轮？—— 用于"别切断别人的工作"。
 *
 * busy 是一个由 session/event 维护的集合（turn/start 进、turn/end 出）。
 * 这个集合**只覆盖本进程启动之后发生的轮次**：更早就在跑的会话不在里面。
 * 这一点必须说清楚 —— 它是"尽力而为"，不是权威快照。
 *
 * @param busy - Map<sessionId, {since:number}>
 * @param exceptSessionId - 调用方自己（它当然在跑一轮，不算"别人"）
 */
export function othersBusy(busy, exceptSessionId) {
  const out = []
  for (const [id, rec] of busy.entries()) {
    if (id === exceptSessionId) continue
    out.push({ sessionId: id, since: new Date(rec.since).toISOString() })
  }
  return out
}
