// 核心逻辑自检。
//
// 这个插件的价值全在**判断**上：什么时候可以重启、什么时候必须拒绝。
// 所以测的不是"能不能跑通"，而是每道闸在边界上的行为 ——
// 闸门放行错误一次，代价是把用户的 app 重启进一个起不来的状态。
//
// 用临时 DSH_HOME，绝不碰真实的 ~/.dsh 审计与标记文件。
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = join(process.cwd(), '.tmp-verify-home')
process.env.DSH_HOME = HOME
await rm(HOME, { recursive: true, force: true })
await mkdir(join(HOME, 'profiles', 'testprof', 'node_modules'), { recursive: true })

// 必须在设置 DSH_HOME 之后 import（paths.js 在调用时读它，这里只是保证顺序清楚）
const { findProfileRoot, dshHome, auditFile, resumeFile } = await import('../lib/paths.js')
const { checkBundles, resolveEntry, othersBusy } = await import('../lib/preflight.js')
const { detectMode, restartLoopTripped, recordAudit, readAudit, writeResume, readResume, clearResume, buildHelperSource, webPortFromArgv } = await import('../lib/restart.js')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

console.log('=== 1. profile 定位 ===')
{
  check('DSH_HOME 生效（审计/标记都落在临时目录）', dshHome() === HOME, dshHome())
  check('★ 只有一个 profile 装着本包时才认它', findProfileRoot('dsh-safety-restart') === null,
    String(findProfileRoot('dsh-safety-restart')))
  await mkdir(join(HOME, 'profiles', 'testprof', 'node_modules', 'dsh-safety-restart'), { recursive: true })
  check('装进一个 profile 之后能定位到',
    findProfileRoot('dsh-safety-restart') === join(HOME, 'profiles', 'testprof'),
    String(findProfileRoot('dsh-safety-restart')))
  await mkdir(join(HOME, 'profiles', 'other', 'node_modules', 'dsh-safety-restart'), { recursive: true })
  check('★ 装了多个 profile 时返回 null —— 宁可如实说"查不到"，也不拿别人的 bundle 表做决定',
    findProfileRoot('dsh-safety-restart') === null, String(findProfileRoot('dsh-safety-restart')))
  await rm(join(HOME, 'profiles', 'other'), { recursive: true, force: true })
}

console.log('')
console.log('=== 2. bundle 体检（第三道闸）===')
{
  const P = join(HOME, 'profiles', 'testprof')
  const nm = join(P, 'node_modules')
  const mkPkg = async (name, pj, entryFile) => {
    await mkdir(join(nm, name), { recursive: true })
    await writeFile(join(nm, name, 'package.json'), JSON.stringify(pj), 'utf8')
    if (entryFile) {
      // 入口文件可能在子目录里（lib/index.js）—— 夹具必须先建父目录。
      // 第一版漏了这一步，于是测试挂在自家 fixture 上，与被测逻辑无关。
      const target = join(nm, name, entryFile)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, '// x', 'utf8')
    }
  }
  await writeFile(join(P, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['good', 'noentry', 'missing', '@deepseek-ai/dsh-base'] } },
  }), 'utf8')
  await mkPkg('good', { name: 'good', main: 'lib/index.js' }, 'lib/index.js')
  await mkPkg('noentry', { name: 'noentry', main: 'lib/gone.js' }, null)

  const r = checkBundles(P)
  const names = r.bad.map(b => b.name)
  check('★ 入口文件缺失被抓住', names.includes('noentry'), JSON.stringify(r.bad))
  check('★ node_modules 里没有这个包被抓住', names.includes('missing'), JSON.stringify(r.bad))
  check('★ 官方 @deepseek-ai/* 不算坏（它们由宿主提供，profile 里本来就没有）',
    !names.includes('@deepseek-ai/dsh-base'), JSON.stringify(names))
  check('坏的一条就让整体不 ok', r.ok === false && r.checked === true, JSON.stringify({ ok: r.ok, total: r.total }))
  check('★ 查不到 profile 时返回 checked:false —— 不假装检查过',
    checkBundles(null).checked === false && checkBundles(null).ok === false,
    JSON.stringify(checkBundles(null)))

  check('exports["."] 优先于 main',
    resolveEntry({ exports: { '.': './lib/e.js' }, main: 'lib/index.js' }) === 'lib/e.js',
    resolveEntry({ exports: { '.': './lib/e.js' }, main: 'lib/index.js' }))
  check('条件导出里取 import',
    resolveEntry({ exports: { '.': { import: './lib/i.js', require: './lib/c.js' } } }) === 'lib/i.js',
    resolveEntry({ exports: { '.': { import: './lib/i.js', require: './lib/c.js' } } }))
  check('什么都没有 -> null', resolveEntry({}) === null)
}

console.log('')
console.log('=== 3. 重启循环熔断（第一道闸）===')
{
  await rm(auditFile(), { force: true })
  check('没有记录时不通', restartLoopTripped().tripped === false)
  recordAudit({ kind: 'restart', phase: 'refused', reason: 'x' })
  recordAudit({ kind: 'restart', phase: 'refused', reason: 'y' })
  check('★ 被拒绝的尝试**不算**重启（否则拒绝本身会把熔断喂饱）',
    restartLoopTripped().tripped === false, JSON.stringify(restartLoopTripped()))
  // ★ 回归：一次重启会留下多条审计（helper / quit / exit），只有
  //   kind='restart' + phase='scheduled' 那一条算数。全数进来的话
  //   一次重启动会算成两次 —— 端到端实测时就是它让 count 变成 2。
  recordAudit({ kind: 'restart', phase: 'scheduled', reason: 'a' })
  recordAudit({ kind: 'helper', note: 'helper up' })
  recordAudit({ kind: 'exit', note: 'exiting' })
  recordAudit({ kind: 'quit', note: 'app.relaunch queued' })
  check('★ 一次真重启动只算一次（同一次留下的 helper/exit/quit 都不计数）',
    restartLoopTripped().count === 1, JSON.stringify(restartLoopTripped()))
  recordAudit({ kind: 'restart', phase: 'scheduled', reason: 'b' })
  check('两次真重启还不通', restartLoopTripped().tripped === false, JSON.stringify(restartLoopTripped()))
  recordAudit({ kind: 'restart', phase: 'scheduled', reason: 'c' })
  const t = restartLoopTripped()
  check('★ 第三次真重启 -> 熔断', t.tripped === true && t.count === 3, JSON.stringify(t))
  check('窗口外的旧记录不计入', restartLoopTripped({ windowMs: 1 }).tripped === false,
    JSON.stringify(restartLoopTripped({ windowMs: 1 })))
  check('阈值可配', restartLoopTripped({ max: 99 }).tripped === false)
}

console.log('')
console.log('=== 4. 续作标记 ===')
{
  clearResume()
  check('没有标记时读回空数组', readResume().length === 0, JSON.stringify(readResume()))
  check('写得进去', writeResume(['sess-a']) === true)
  check('读得回来', JSON.stringify(readResume()) === '["sess-a"]', JSON.stringify(readResume()))
  writeResume(['a', 'b'])
  check('多条也读得回来', readResume().length === 2)
  clearResume()
  check('清得掉', readResume().length === 0)
  await writeFile(resumeFile(), '{ 这不是 JSON', 'utf8')
  check('★ 标记文件损坏时返回空数组而不是抛（重启后不能因为读标记把启动搞挂）',
    readResume().length === 0)
  clearResume()
}

console.log('')
console.log('=== 5. helper 生成物必须是**能跑的** ESM ===')
{
  const src = buildHelperSource({
    pid: 12345, execPath: 'C:/node/node.exe', execArgv: ['--x'],
    argv: ['bin.js', 'web'], logFile: join(HOME, 'audit.jsonl'),
  })
  const f = join(HOME, 'helper-check.mjs')
  await writeFile(f, src, 'utf8')
  let syntaxOk = true, why = ''
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) { syntaxOk = false; why = String(e.stderr ?? e.message).slice(0, 200) }
  check('★ 生成的 helper 是合法 ESM（语法错的话重启后没人拉得起进程）', syntaxOk, why)
  check('helper 里带上了旧 pid', src.includes('12345'))
  check('helper 不会去杀旧进程（只是等它退出）', !/process\.kill\(\s*PID\s*,\s*['"]SIGKILL/.test(src))
  check('helper 用 execPath + argv 原样拉起', src.includes('C:/node/node.exe') && src.includes('bin.js'))
}

console.log('')
console.log('=== 5b. web 健康检查端口 ===')
{
  // webPortFromArgv 的解析规则：--port 显式优先；否则看有没有 'web' 子命令 → 默认 3080；
  // 纯 CLI / 拿不准 → null（退化成只等进程活，不探测错误端口）。
  check('--port 4000 显式端口', webPortFromArgv(['x', 'web', '--port', '4000']) === 4000,
    String(webPortFromArgv(['x', 'web', '--port', '4000'])))
  check('--port=4000 等号形式', webPortFromArgv(['x', '--port=4000']) === 4000,
    String(webPortFromArgv(['x', '--port=4000'])))
  check('★ web 子命令无显式端口 → 默认 3080（与 start-harness.ps1 一致）',
    webPortFromArgv(['bin.js', 'web', '--no-open']) === 3080,
    String(webPortFromArgv(['bin.js', 'web', '--no-open'])))
  check('★ 非法端口值 → null（不探测，宁退化成存活检查）',
    webPortFromArgv(['--port', 'abc']) === null && webPortFromArgv(['--port', '0']) === null,
    String(webPortFromArgv(['--port', 'abc'])))
  check('★ 纯 CLI（没有 web 子命令、没有 --port）→ null',
    webPortFromArgv(['bin.js', 'run']) === null, String(webPortFromArgv(['bin.js', 'run'])))
  check('★ 空 argv → null', webPortFromArgv([]) === null)

  // buildHelperSource 收到 healthPort 时，helper 里必须真的带上端口并做端口健康检查。
  const hp = buildHelperSource({
    pid: 12345, execPath: 'C:/node/node.exe', execArgv: [], argv: ['bin.js', 'web'],
    logFile: join(HOME, 'audit.jsonl'), healthPort: 3080,
  })
  check('★ helper 里带上了健康检查端口', hp.includes('3080') && hp.includes('portUp'))
  check('★ 有端口时走健康检查分支（不再只等 10 秒）',
    hp.includes('never recovered — 健康检查失败') && hp.includes('recovered — restart ok'))
  check('★ 端口探测是 TCP 连接（127.0.0.1），不是 HTTP 请求',
    hp.includes("createConnection({ host: '127.0.0.1', port })"))
  const f2 = join(HOME, 'helper-hp-check.mjs')
  await writeFile(f2, hp, 'utf8')
  let syntaxOk2 = true
  try { execFileSync(process.execPath, ['--check', f2], { stdio: 'pipe' }) } catch { syntaxOk2 = false }
  check('★ 带健康检查的 helper 仍是合法 ESM', syntaxOk2)

  // 没有端口时保持原有行为：只有 10 秒存活检查，不生成端口探测代码。
  const plain = buildHelperSource({
    pid: 12345, execPath: 'C:/node/node.exe', execArgv: [], argv: ['bin.js'],
    logFile: join(HOME, 'audit.jsonl'),
  })
  check('★ 无端口时 HEALTH_PORT 是 null', plain.includes('HEALTH_PORT = null'))
  check('★ 无端口时仍是"等它活过 10 秒"的旧行为', plain.includes('alive after 10s — restart ok'))
}

console.log('')
console.log('=== 6. 环境判定与会话 id 取值 ===')
{
  check('纯 node 下判定为 web（桌面端才有 process.versions.electron）',
    detectMode() === 'web', detectMode())
  const { sessionIdOf, buildUserMessage } = await import('../index.js').catch(() => ({}))
  if (sessionIdOf) {
    check('session.id 优先', sessionIdOf({ session: { id: 'a' }, id: 'b' }) === 'a')
    check('退到 sessionId', sessionIdOf({ sessionId: 'c', id: 'b' }) === 'c')
    check('再退到 agent.id', sessionIdOf({ id: 'b' }) === 'b')
    check('都取不到 -> null', sessionIdOf({}) === null && sessionIdOf(null) === null)
    const m = buildUserMessage('hello')
    check('★ 投递消息有最小可用形状（host createUserMessage 不可用时也不能没有 role/content）',
      m && m.role === 'user' && Array.isArray(m.content) && m.content[0].text === 'hello',
      JSON.stringify(m).slice(0, 140))
  } else {
    console.log('  SKIP  index.js 依赖 @deepseek-ai/dsh-tools，本机没装时跳过这一组')
  }
}

console.log('')
console.log('=== 7. 「谁在跑一轮」的排除 ===')
{
  const busy = new Map([['me', { since: 1 }], ['other', { since: 2 }]])
  const o = othersBusy(busy, 'me')
  check('★ 排除调用方自己（它当然在跑一轮）', o.length === 1 && o[0].sessionId === 'other', JSON.stringify(o))
  check('调用方不在 busy 里也不受影响', othersBusy(busy, 'nobody').length === 2)
  check('没人跑就是空', othersBusy(new Map(), 'me').length === 0)
}

await rm(HOME, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? 'ALL PASS — 四道闸的判定边界都有断言' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
