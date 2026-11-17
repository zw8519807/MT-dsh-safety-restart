// 重启机制。这个文件决定"安全"到底是不是一句空话。
//
// ── 桌面端（Electron 内嵌宿主）：先走 app.relaunch() 正路，够不到就走 helper 兜底 ──
//   0.2.2-rc.3 实测：宿主跑在 Electron utilityProcess 子进程里，插件
//   import('electron') 永远失败，app.relaunch() 在这个版本不可达（audit:
//   "electron.app.relaunch 不可达"）。
//   ★ 0.1.3 修正：桌面壳的关窗行为是 preventDefault+藏托盘（app.asar lib/main.js
//   21470-21482 实锤——托盘常驻整个运行期），所以"taskkill 不带 /F = 温和退出"
//   这条路被证死：消息会送达、窗口会藏、进程不死，helper 30s 后只能干瞪眼。
//   新阶梯（helper 内实现）：WM_CLOSE（万一未来版本恢复温和语义）→ 宽限 3s
//   → 仍活才 taskkill /F → 清理孤儿子进程（宿主 utilityProcess 硬死后会变
//   孤儿，留着=下次启动双宿主抢 profile）→ 按**真实命令行**（关闭前尽力读取，
//   读不到用嵌入值）拉起新实例。桌面壳无"脏退出"标记逻辑（DesktopFatalRecovery
//   只服务运行时 fatal error），硬杀不会导致下次启动弹恢复对话框。
//   桌面 webServer 端口每次启动会变，健康检查退化成"新进程活过 10 秒"。
//
// web / CLI 端：detached helper。
//   helper 必须在**父进程死掉之后**继续活着，所以 detached:true + stdio:'ignore'
//   + unref()，并且它自己是 node 脚本（不是 ps1 —— 实测 WMI/安全软件那条路上
//   PowerShell 会被拦）。helper 等旧 pid 退出 → 用**同一份 execPath/execArgv/argv**
//   拉起新进程 → 等它活着 → 若知道 web 端口再等端口恢复（健康检查，常见编排器
//   的"进程存活 + 端口探测"同类实践）→ 把结果写进审计日志。
//
// 关停哲学（0.1.3 定稿）：红线不是"绝不硬杀"，而是"绝不硬杀且不拉起"——
//   只要有续作标记在先、拉起命令在后，硬杀就是把"要重启"变成"重启完成"，
//   而不是把可恢复变成不可恢复。helper 全链条仍守住：
//   先温和（WM_CLOSE）→ 宽限 3s → 仍活才 /F → 清孤儿 → 按真实命令行拉起；
//   拉不起来（新进程秒退）就在审计里如实记失败，绝不假装成功。
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { auditFile, resumeFile, dshHome } from './paths.js'

/** 当前环境：desktop（Electron 内嵌宿主）还是 web/CLI。 */
export function detectMode() {
  return process.versions?.electron ? 'desktop' : 'web'
}

/** 追加一条审计。**只追加不覆盖**：重启这种事必须留痕，且要能在崩溃后读到。 */
export function recordAudit(entry) {
  const file = auditFile()
  try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 目录已存在 */ }
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })
  try { appendFileSync(file, line + '\n', 'utf8') } catch { /* 审计写不进去不该挡住重启 */ }
  return line
}

/** 读审计（最近 n 条，新的在最后）。读不到就当空 —— 但不假装没发生过。 */
export function readAudit(limit = 50) {
  try {
    const raw = readFileSync(auditFile(), 'utf8')
    const rows = raw.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    return rows.slice(-limit)
  } catch { return [] }
}

/**
 * 重启循环熔断：窗口内已经重启太多次就拒绝。
 *
 * 为什么必须有：一个"起不来"的配置会让每次启动都失败，而 agent 看到失败就想再重启
 * —— 于是变成重启风暴。DSH 桌面 app 每次重启动要 boot 整个 profile（几秒到几十秒），
 * 风暴的代价是机器一直在 boot、而且**永远看不到日志**。
 *
 * 只数**真正发起过**的重启（relaunch），不数被拒绝的尝试。
 */
export function restartLoopTripped({ windowMs = 10 * 60 * 1000, max = 3 } = {}) {
  const now = Date.now()
  // ★ 只数 kind==='restart' 且 phase==='scheduled' 的那一条 ——
  //   一次重启会在审计里留下多条（begin / scheduled / helper / quit），
  //   全数进来会让"一次重启动"算成两次：实测第三次重启就直接熔断了，
  //   而配置写的是 3。计数的口径必须**一次重启算一次**。
  const recent = readAudit(200)
    .filter(e => e?.kind === 'restart' && e?.phase === 'scheduled' && Number.isFinite(Date.parse(e.at)))
    .filter(e => now - Date.parse(e.at) < windowMs)
  return { tripped: recent.length >= max, count: recent.length, windowMs, max, since: recent[0]?.at ?? null }
}

/** 写续作标记：重启后要叫醒哪些会话。 */
export function writeResume(sessions) {
  try {
    writeFileSync(resumeFile(), JSON.stringify({ at: new Date().toISOString(), sessions }, null, 2), 'utf8')
    return true
  } catch { return false }
}

export function readResume() {
  try {
    const j = JSON.parse(readFileSync(resumeFile(), 'utf8'))
    return Array.isArray(j?.sessions) ? j.sessions : []
  } catch { return [] }
}

export function clearResume() {
  try { if (existsSync(resumeFile())) unlinkSync(resumeFile()) } catch { /* 删不掉就下次再删 */ }
}

/** 桌面端兜底：从进程外关停主进程（阶梯：温和→强杀）并按同一 exe 拉起新实例。
 * 为什么存在：0.2.2-rc.3 实测宿主跑在 Electron utilityProcess 子进程里，
 * 插件 import('electron') 永远失败，app.relaunch() 在该版本不可达。
 * 关停走阶梯：WM_CLOSE（点 × 语义，实测=藏托盘不死）→ 宽限 3s → 仍活才 /F
 * → 清孤儿子进程（防止双宿主抢 profile）→ 拉起。唯一红线：绝不硬杀且不拉起。 */
function relaunchDesktopHelper() {
  const mainPid = process.ppid
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    return { ok: false, why: '取不到主进程 pid（ppid=' + mainPid + '）—— 拒绝盲重启' }
  }
  try { process.kill(mainPid, 0) } catch {
    return { ok: false, why: '主进程 pid ' + mainPid + ' 已不在 —— 拒绝盲重启' }
  }
  const helperPath = join(dshHome(), 'safety-restart-helper.mjs')
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(helperPath, buildHelperSource({
      pid: mainPid,
      execPath: process.execPath,
      execArgv: [],
      argv: [],
      logFile: auditFile(),
      healthPort: null, // 桌面端口每次启动都变，探测不到 → 退化成"活过 10s"
      closePid: mainPid,
      closeGraceMs: 3000,
      cwd: dirname(process.execPath),
    }), 'utf8')
  } catch (e) { return { ok: false, why: '写 helper 失败：' + String(e?.message ?? e) } }
  let h
  try { h = spawn(process.execPath, [helperPath], { detached: true, stdio: 'ignore' }); h.unref() }
  catch (e) { return { ok: false, why: '起 helper 失败：' + String(e?.message ?? e) } }
  recordAudit({ kind: 'helper', mode: 'desktop', note: 'helper pid ' + h.pid + '：阶梯关停主进程 ' + mainPid + '（WM_CLOSE→3s→必要时 /F→清孤儿）并按同一 exe 拉起新实例' })
  return { ok: true, mode: 'desktop', note: 'helper 已启动（pid ' + h.pid + '）：它将关停主进程 ' + mainPid + '（先温和后强杀，保证拉起新实例）' }
}

/** 桌面端：优先 Electron 正路；够不到就 helper 兜底（而不是拒绝）。 */
async function relaunchDesktop() {
  try {
    const electron = await import('electron')
    const app = electron?.default?.app ?? electron?.app
    if (app && typeof app.relaunch === 'function') {
      app.relaunch()
      // 给当前这一轮的答复留出回传时间，再退出。300ms 不够 SSE/HTTP 把最后一个
      // chunk 刷出去（实测：太早 quit 会让工具结果丢在半路）。
      const quitAfterMs = 800
      setTimeout(() => {
        recordAudit({ kind: 'quit', mode: 'desktop', note: 'app.relaunch() 已排队，即将 quit' })
        try { app.quit() } catch { try { app.exit(0) } catch { /* 都失败就只能等外面 */ } }
      }, quitAfterMs)
      return { ok: true, mode: 'desktop', note: 'app.relaunch() 已排队，' + quitAfterMs + 'ms 后 quit；启动器会拉起新实例' }
    }
  } catch { /* 取不到 electron 模块 —— 走 helper 兜底 */ }
  return relaunchDesktopHelper()
}

/** helper 源码：在**父进程之外**等旧进程退出并用同一命令行拉起新进程。
 * closePid 为 null（web/CLI）：旧进程自己退出，helper 只等 + 拉起（原行为）。
 * closePid 为数字（桌面兜底）：helper 走阶梯关停——先发关窗消息（点 × 语义，
 * 实测=藏托盘不死）→ 宽限 3s → 仍活才 /F 硬杀；杀父前先抓子进程快照，死后
 * 清理同 exe 的孤儿（防双宿主抢 profile）；拉起前尽力读一次真实命令行
 * （防参数漂移），读不到就用生成时嵌入的值，并剥掉 ELECTRON_RUN_AS_NODE。 */
export function buildHelperSource({ pid, execPath, execArgv, argv, logFile, healthPort = null, closePid = null, closeGraceMs = 1200, cwd = null }) {
  return `// generated by dsh-safety-restart — detached relaunch helper
import { spawn, execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const PID = ${JSON.stringify(pid)}
const CLOSE = ${JSON.stringify(closePid)}
const CLOSE_DELAY = ${JSON.stringify(closeGraceMs)}
const EXEC = ${JSON.stringify(execPath)}
const ARGS = ${JSON.stringify([...(execArgv ?? []), ...(argv ?? [])])}
const CWD = ${JSON.stringify(cwd)}
const LOG = ${JSON.stringify(logFile)}
const HEALTH_PORT = ${JSON.stringify(healthPort)}
const say = (m) => { try { appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: 'helper', note: m }) + '\\n') } catch {} }
const alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const run = (file, args) => new Promise(resolve => { try { execFile(file, args, { timeout: 15000 }, () => resolve()) } catch { resolve() } })
const portUp = (port) => new Promise(resolve => {
  if (!port) return resolve(false)
  import('node:net').then(({ createConnection }) => {
    const s = createConnection({ host: '127.0.0.1', port })
    const done = (v) => { try { s.destroy() } catch {} ; resolve(v) }
    s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(800, () => done(false))
  }).catch(() => resolve(false))
})
// 尽力读旧进程真实命令行（读不到就用嵌入值——主进程通常就是裸 exe）。
const readCmdline = (p) => new Promise(resolve => {
  try { execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_Process -Filter "ProcessId=' + p + '").CommandLine'],
    { timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '').trim())) } catch { resolve('') }
})
// Windows 命令行拆 argv（引号 + 空白；不处理转义引号这种罕见边角）。
const splitArgs = (line) => {
  const out = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { q = !q; continue }
    if (!q && (c === ' ' || c === '\\t')) { if (cur) { out.push(cur); cur = '' } continue }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}
let USE_EXEC = EXEC, USE_ARGS = ARGS
let CHILDCACHE = []
const APP_NAME = EXEC.split(/[\\/]/).pop().toLowerCase()
// 枚举旧主进程的直属子进程（"pid|name" 行）。必须在杀父进程**之前**查：
// 父一死，父子关系就查不到了。硬杀主进程后 Electron utilityProcess 宿主会变
// 孤儿继续跑——不清掉它，新实例起来就是双宿主抢同一个 profile。
const listChildren = (p) => new Promise(resolve => {
  try { execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "ParentProcessId=' + p + '" | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }'],
    { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([])
      resolve(String(stdout ?? '').split(/\\r?\\n/).filter(Boolean).map(l => {
        const i = l.indexOf('|')
        if (i <= 0) return null
        const cpid = Number(l.slice(0, i))
        return Number.isInteger(cpid) && cpid > 0 ? { pid: cpid, name: l.slice(i + 1).trim() } : null
      }).filter(Boolean))
    }) } catch { resolve([]) }
})
say('helper up, watching pid ' + PID + (CLOSE ? ' (ladder close after ' + CLOSE_DELAY + 'ms: WM_CLOSE -> grace 3s -> force if still alive)' : ''))
if (CLOSE) {
  await sleep(CLOSE_DELAY)
  const line = await readCmdline(PID)
  const parts = line ? splitArgs(line) : []
  if (parts.length) { USE_EXEC = parts[0]; USE_ARGS = parts.slice(1); say('cmdline captured: ' + line.slice(0, 300)) }
  else say('cmdline read failed — using embedded exe/args')
  CHILDCACHE = await listChildren(PID)
  say('children snapshot: ' + (CHILDCACHE.length ? CHILDCACHE.map(c => c.pid + '(' + c.name + ')').join(', ') : 'none'))
  await run('taskkill', ['/PID', String(PID)])
  say('WM_CLOSE sent to ' + PID + ' (same message as clicking x); grace 3s')
  await sleep(3000)
  if (alive(PID)) {
    // 桌面壳实测：关窗处理器 preventDefault+藏托盘（app.asar lib/main.js:21470），
    // 进程不死——这就是阶梯的最后一级。续作标记早已落盘，硬杀只是执行已宣布的重启。
    await run('taskkill', ['/F', '/PID', String(PID)])
    say('still alive after grace — force kill sent to ' + PID)
  } else say('exited on WM_CLOSE — no force needed')
}
for (let i = 0; i < 120; i++) { if (!alive(PID)) break; await sleep(250) }
if (alive(PID)) { say('old pid still alive after 30s — giving up (force kill failed; 绝不硬杀且不拉起 → 如实报失败)'); process.exit(1) }
if (CLOSE) {
  for (const c of CHILDCACHE) {
    if ((c.name || '').toLowerCase() !== APP_NAME) continue
    if (!alive(c.pid)) continue
    await run('taskkill', ['/F', '/PID', String(c.pid)])
    say('orphan child killed: ' + c.name + ' pid ' + c.pid)
  }
}
say('old pid gone, spawning: ' + USE_EXEC + (USE_ARGS.length ? ' ' + USE_ARGS.join(' ') : ''))
// ★ 拉起前剥掉 ELECTRON_RUN_AS_NODE：宿主环境带着 =1（utilityProcess 特性），
// 原样继承会让新实例以纯 node 模式启动——进程活着但 app 根本没跑（假成功）。
const CHILD_ENV = { ...process.env }; delete CHILD_ENV.ELECTRON_RUN_AS_NODE
let child
try { child = spawn(USE_EXEC, USE_ARGS, { detached: true, stdio: 'ignore', env: CHILD_ENV, ...(CWD ? { cwd: CWD } : {}) }); child.unref() }
catch (e) { say('spawn failed: ' + String(e && e.message || e)); process.exit(1) }
say('spawned pid ' + child.pid)
// 等它活过 10 秒：起不来时进程通常会立刻退，等一会儿才分得清
for (let i = 0; i < 40; i++) { await sleep(250); if (!alive(child.pid)) { say('new pid ' + child.pid + ' died early — 新实例没起来'); process.exit(1) } }
if (HEALTH_PORT) {
  let healthy = false
  for (let i = 0; i < 80; i++) { if (await portUp(HEALTH_PORT)) { healthy = true; break }; await sleep(250) }
  if (!healthy) { say('new pid ' + child.pid + ' alive but port ' + HEALTH_PORT + ' never recovered — 健康检查失败'); process.exit(1) }
  say('new pid ' + child.pid + ' alive and port ' + HEALTH_PORT + ' recovered — restart ok')
} else say('new pid ' + child.pid + ' alive after 10s — restart ok')
process.exit(0)
`
}

/**
 * 从命令行里找出 web 服务监听端口，供 helper 做重启后的健康检查。
 *
 * 规则（与 start-harness.ps1 / dsh-cmdline 的默认一致）：
 *   1. 显式 --port <n> 或 --port=<n> 优先（web 服务可被 --port 覆盖默认 3080）；
 *   2. 否则看 argv 里有没有 'web' 子命令 —— 有则默认 3080（DSH web 的默认端口）；
 *   3. 都不是（纯 CLI / 桌面外进程）返回 null —— helper 退化成只等进程活 10 秒。
 *
 * 拿不准时返回 null 而不是猜一个端口：健康检查探测**错误的端口**比不探测更糟
 * （新实例其实活着，却因为探测另一个端口而误报失败）。
 */
export function webPortFromArgv(argv = []) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { const n = Number(argv[i + 1]); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null }
    if (typeof argv[i] === 'string' && argv[i].startsWith('--port=')) { const n = Number(argv[i].slice(7)); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null }
  }
  return argv.includes('web') ? 3080 : null
}

/** web / CLI 端：写 helper 并 detached 起它。 */
function relaunchWeb() {
  const helperPath = join(dshHome(), 'safety-restart-helper.mjs')
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(helperPath, buildHelperSource({
      pid: process.pid,
      execPath: process.execPath,
      execArgv: process.execArgv ?? [],
      // argv.slice(1)：argv[0] 是解释器，helper 要用 execPath 自己拼，不能重复。
      argv: process.argv.slice(1),
      // 健康检查端口：从同一份命令行里推出来（--port 显式优先，否则 web 默认 3080）。
      // 这是常见编排器的"进程存活 + 端口探测"同类实践：光等"进程活着"
      // 不够 —— 起不来的 web 往往进程在但端口没监听。拿不到端口就 null，
      // helper 自动退化成原有的 10 秒存活检查。
      healthPort: webPortFromArgv(process.argv.slice(1)),
      logFile: auditFile(),
    }), 'utf8')
  } catch (e) {
    return { ok: false, why: '写 helper 失败：' + String(e?.message ?? e) }
  }
  let h
  try {
    h = spawn(process.execPath, [helperPath], { detached: true, stdio: 'ignore' })
    h.unref()
  } catch (e) {
    return { ok: false, why: '起 helper 失败：' + String(e?.message ?? e) }
  }
  // ★ 老进程必须**自己退出** —— 这一步第一版漏了，端到端实测的结论是：
  //   helper 起来、等了 30 秒、然后报 "old pid still alive — giving up"。
  //   因为 helper 等的是"老进程死掉"，而没有任何人让它死：它就那样继续服务着。
  //   dsh-restart 的做法也是这一条（老进程 delayMs 之后 process.exit(0)）。
  //
  //   为什么敢硬退：会话日志是**只追加**的 jsonl，写到哪算哪；而工具结果在
  //   delayMs 之前就已经回传（fire() 先等 waitMs 才走到这里）；即使尾巴被截，
  //   续作提示里明确要求"结果未知的调用先核查再重试"。反过来——不退，就永远
  //   重启不成，那才是真的坏。
  const exitDelayMs = 250
  const t = setTimeout(() => {
    recordAudit({ kind: 'exit', mode: 'web', note: 'helper 已起，本进程 ' + exitDelayMs + 'ms 后退出' })
    process.exit(0)
  }, exitDelayMs)
  // 不让这个定时器把进程钉住（它本来就要退出，这里只是让语义明确）
  try { t.unref?.() } catch { /* 老 Node 没有 unref 也无所谓 */ }
  return { ok: true, mode: 'web', note: 'detached helper 已起（pid ' + h.pid + '），本进程即将退出，由它用同一命令行拉起新实例' }
}

/**
 * 真正发起一次重启。
 *
 * ★ 顺序是刻意的：**先写续作标记，再拉起**。反过来的话，进程可能在被拉起前
 *   就先退出了，标记没落下 —— 于是"无感"变成"重启完什么都不知道"。
 */
export async function relaunch({ reason = 'manual', mode = detectMode() } = {}) {
  const r = mode === 'desktop' ? await relaunchDesktop() : relaunchWeb()
  // 这是**唯一**会被熔断计数的一条：kind='restart' + phase='scheduled'。
  // 每次真正发起重启只写一条，别的（helper / quit / exit / refused）都是诊断信息。
  recordAudit({ kind: 'restart', mode, reason, phase: r.ok ? 'scheduled' : 'refused', why: r.ok ? undefined : r.why })
  return { ...r, mode }
}
