// dsh-safety-restart —— DSH 的安全无感重启。
//
// ── 这个插件解决什么 ──
//
// 改完**宿主半**（index.js / lib/*.js）必须整 app 重启才生效。渲染器重载不够：
// 实测回收渲染器会让插件重新 apply、日志也照打，但**服务请求的路由表仍然是
// 更早那次 apply 的** —— 新加的路由一律 404，看起来像"路由写错了"。
//
// 而在此之前，agent 自己没有重启的手段，只能让用户去点。这个插件把这件事
// 变成一次工具调用，并且把"安全"落成四道闸。
//
// ── 四道闸（每一条都对应一次真实踩坑）──
//
//   1. 重启循环熔断：窗口内重启太多次就拒绝。一个起不来的配置会让每次启动都失败，
//      而 agent 看到失败只会想再重启一次 —— 那是重启风暴，代价是机器一直在 boot。
//   2. 有别的会话正在跑一轮就拒绝（除非 force）：盲着重启会把别人正在做的事从中间
//      切断，而且切断后那一轮的工具调用结果未知。
//   3. profile 的 bundle 表解析不了就拒绝：重启进一个坏掉的 profile，得到的是
//      **起不来的 app** —— 连报错界面都没有。
//   4. 安排不出可靠的拉起手段就拒绝：桌面端优先 Electron `app.relaunch()` 正路；
//      在宿主跑于 utilityProcess 子进程的版本上它不可达，此时退而写一个一次性
//      detached helper 阶梯关停（温和关窗 → 宽限 → 必要时强杀 → 清孤儿）并按
//      同一命令行拉起新实例。连 helper 都安排不了（如取不到主进程 pid）才拒绝
//      —— 红线是"绝不硬杀且不拉起"。
//
// ── 无感 ──
//
// 重启前写续作标记，重启后把"你已经重启过、请继续"投回**原来那个会话**。
// 标记先写、再拉起 —— 反过来会在进程先退出时丢掉标记。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage as hostCreateUserMessage } from '@deepseek-ai/dsh-llm'
import { findProfileRoot, readJsonSafe, configFile } from './lib/paths.js'
import { checkBundles, othersBusy } from './lib/preflight.js'
import {
  detectMode, relaunch, readAudit, recordAudit,
  restartLoopTripped, readResume, writeResume, clearResume,
} from './lib/restart.js'

export const name = 'dsh-safety-restart'
// agents 刻意**不**注入：这个插件不需要 agent 注册表（轮次状态自己按事件维护），
// 少一个注入就少一种"宿主没这个服务就整个 apply 失败"的可能。
export const inject = ['tools', 'llm', 'webServer']

/** 工具名。刻意不叫 restart_harness —— 那是 dsh-restart 用的名字，同名会在注册表里撞。 */
export const TOOL_NAME = 'safety_restart'
/** HTTP 前缀。桌面端不开端口，这条路由是给 web 端的界面按钮用的。 */
export const ROUTE_PREFIX = '/safety-restart'

/** 重启后投回原会话的话。要说清"怎么恢复"而不只是"你重启了"。 */
export const CONTINUE_MESSAGE = [
  '（这个进程刚刚按你的要求重启完成，你上一轮被中断了。）',
  '请接着做没做完的事。注意两点：',
  '1) 重启前**结果未知**的工具调用不要盲目重试 —— 先核查它的实际影响（只读或幂等的可以直接重试）。',
  '2) 宿主半的代码改动现在才真正生效；如果重启就是为了让某个改动生效，先确认它生效了再继续。',
].join('\n')

/**
 * 构造投递用的 user 消息。
 * 优先用宿主自己的 createUserMessage（形状随宿主走），失败退化成最小可用形状 ——
 * 重启后投递失败等于"无感"没了，不能让它因为一个 import 失败而静默不发生。
 */
export function buildUserMessage(text, source) {
  // ★ source.kind 不能写 'plugin' —— session format v4 校验器原文拒绝
  //   （"format v4 message requires a producer-owned source kind"，retired
  //   wrapper）。官方 V3→V4 迁移把 { kind:'plugin', plugin:P } 升格为
  //   { kind:'plugin:P' }，新消息必须直接用这个形状（0.1.4 实测：
  //   followup 唤醒成功、轮次开了，但落盘时被这个校验拒收，本轮直接失败）。
  const payload = { content: [{ type: 'text', text }], source: source ?? { kind: `plugin:${name}` } }
  try {
    if (typeof hostCreateUserMessage === 'function') return hostCreateUserMessage(payload)
  } catch { /* 落到最小形状 */ }
  return { role: 'user', ...payload }
}

/** 从哪条记录里读出会话 id。字段名随宿主版本可能漂，所以三种都试。 */
export function sessionIdOf(agent) {
  const v = agent?.session?.id ?? agent?.sessionId ?? agent?.id
  return typeof v === 'string' && v ? v : null
}

export function apply(ctx, pluginConfig = {}) {
  const cfg = { ...readJsonSafe(configFile(), null) ?? {}, ...(pluginConfig || {}) }
  const loopWindowMs = Number(cfg.loopWindowMs) > 0 ? Number(cfg.loopWindowMs) : 10 * 60 * 1000
  const loopMax = Number(cfg.loopMax) > 0 ? Number(cfg.loopMax) : 3
  const delayMs = Number.isFinite(Number(cfg.delayMs)) ? Math.max(0, Number(cfg.delayMs)) : 1500
  const busyStaleMs = Number(cfg.busyStaleMs) > 0 ? Number(cfg.busyStaleMs) : 30 * 60 * 1000

  // ── 轮次状态 ──
  //
  // ★ 轮次边界是**持久 session/event**，不是可 ctx.on 的 live 事件。
  //   写成 ctx.on('turn/end', ...) 不会报错、也永远不触发（订阅静默失效，
  //   代价是整条状态跟踪路径一直是死的）。正确签名是 (session, event)。
  //
  // 这个集合只覆盖**本进程启动之后**的轮次。更早就在跑的会话不在里面 ——
  // 所以它是"尽力而为"，不是权威快照，这一点在返回里如实说明。
  const busy = new Map()
  try {
    ctx.on('session/event', (session, event) => {
      const id = sessionIdOf({ session })
      if (!id || !event) return
      if (event.type === 'turn/start') busy.set(id, { since: Date.now() })
      else if (event.type === 'turn/end') busy.delete(id)
    })
  } catch (e) { recordAudit({ kind: 'hook', note: 'session/event 订阅失败：' + String(e?.message ?? e) }) }

  const liveBusy = () => {
    const now = Date.now()
    for (const [id, rec] of [...busy.entries()]) if (now - rec.since > busyStaleMs) busy.delete(id)
    return busy
  }

  // ── 重启后的接续 ──
  //
  // 标记里存的是**会话 id**。开机时它可能还没活：宿主恢复会话有先后。
  // 所以既扫一遍当前活着的，也订 agent/created —— 谁先到都接得住。
  let resumePending = readResume()
  const tryDeliver = (agent) => {
    if (!resumePending.length) return false
    const id = sessionIdOf(agent)
    if (!id || !resumePending.includes(id)) return false
    if (typeof agent?.followup !== 'function' && typeof agent?.inject !== 'function') return false
    try {
      // ★ followup = 普通下轮提示词 + **唤醒驱动器**（宿主文档原文：
      //   “followup() … wakes the driver; inject() adds model-facing context
      //   without waking”）。inject 只把消息塞收件箱不唤醒 —— 0.1.3 实测续作
      //   永远趴在 inbox 里等「别的输入」，会话里什么都看不见。必须 followup。
      if (typeof agent?.followup === 'function') agent.followup(buildUserMessage(CONTINUE_MESSAGE))
      else agent.inject(buildUserMessage(CONTINUE_MESSAGE))
      resumePending = resumePending.filter(x => x !== id)
      if (resumePending.length === 0) clearResume()
      recordAudit({ kind: 'resume', session: id, note: '已投递续作提示' })
      return true
    } catch (e) {
      recordAudit({ kind: 'resume', session: id, note: '投递失败：' + String(e?.message ?? e) })
      return false
    }
  }
  if (resumePending.length) {
    recordAudit({ kind: 'resume', note: '开机发现续作标记，等目标会话出现：' + resumePending.join(',') })
    try { ctx.on('agent/created', ({ agent }) => { tryDeliver(agent) }) } catch { /* 拿不到就只靠下面那次扫描 */ }
    try { for (const a of (ctx.agents?.list?.() ?? [])) tryDeliver(a) } catch { /* 注册表不可达 */ }
  }

  // ── 闸门 ──
  const preflight = (force, callerSessionId) => {
    const loop = restartLoopTripped({ windowMs: loopWindowMs, max: loopMax })
    if (loop.tripped) {
      return { ok: false, gate: 'loop', why: '重启循环熔断：最近 ' + Math.round(loopWindowMs / 60000) + ' 分钟内已经重启 ' + loop.count + ' 次（上限 ' + loopMax + '）。先把起不来的原因修掉 —— 继续重启只会让它一直在 boot。', loop }
    }
    const profileRoot = findProfileRoot()
    const bundles = checkBundles(profileRoot)
    // ★ 查不到 profile 根目录也拒绝，不允许把"没检查"当成"检查通过"。
    //   之前这里只拦 checked=true 且 bad 的情况，profile 不明确时会放行——
    //   这和安全插件的语义相反：未知状态应当是拒绝，不是绿灯。
    if (!bundles.checked) {
      return { ok: false, gate: 'bundles-unverified', why: bundles.why || '无法验证 profile bundle 表，拒绝重启。', bundles, profileRoot }
    }
    if (!bundles.ok) {
      return { ok: false, gate: 'bundles', why: 'profile 里有 ' + bundles.bad.length + ' 个 bundle 解析不了，重启进去会起不来。先修好或隔离它们。', bundles, profileRoot }
    }
    const others = othersBusy(liveBusy(), callerSessionId)
    if (others.length && !force) {
      return { ok: false, gate: 'busy', why: '还有 ' + others.length + ' 个会话正在跑一轮，重启会把它们从中间切断。确认要打断就加 force: true。', others }
    }
    return { ok: true, profileRoot, bundles }
  }

  /**
   * 发起重启：**先写续作标记，再拉起**。
   *
   * 顺序是刻意的：反过来的话，进程可能在被拉起前就先退出了，标记没落下 ——
   * 于是"无感"变成"重启完什么都不知道，模型还得靠用户告诉它"。
   *
   * 返回回执，**不 await 进程退出**（它马上就不在了）。真正退出交给 delayMs 之后
   * 的那次调用：留这段时间是为了让这次工具结果先回传给模型。
   */
  const fire = (reason, callerSessionId, waitMs = delayMs) => {
    if (callerSessionId) {
      const wrote = writeResume([callerSessionId])
      recordAudit({ kind: 'resume-marker', session: callerSessionId, note: wrote ? '已写续作标记' : '★ 续作标记写失败（重启后不会自动接续）' })
    }
    const scheduled = () => {
      relaunch({ reason })
        .then(r => { if (!r.ok) recordAudit({ kind: 'relaunch', reason, phase: 'failed', why: r.why }) })
        .catch(e => recordAudit({ kind: 'relaunch', reason, phase: 'threw', why: String(e?.message ?? e) }))
    }
    if (waitMs <= 0) scheduled()
    else setTimeout(scheduled, waitMs)
    return { delayMs: waitMs, mode: detectMode() }
  }

  const refusal = (g) => ({
    ok: false, restarted: false, refused: true, gate: g.gate, why: g.why,
    ...(g.loop ? { loop: g.loop } : {}),
    ...(g.bundles ? { bundles: { total: g.bundles.total, bad: g.bundles.bad } } : {}),
    ...(g.others ? { others: g.others } : {}),
    note: '这是**拒绝重启**，不是失败：这道闸就是为了不让你把环境弄成不好收拾的样子。',
  })

  // ── 工具 ──
  ctx.effect(() => {
    const dispose = ctx.tools.register(defineTool({
      name: TOOL_NAME,
      description: '安全重启 DSH 宿主进程。**改完宿主半的代码（index.js / lib/*.js）必须整进程重启才生效** —— 只重载界面不够。'
        + '重启前会过四道闸：重启循环熔断、有别的会话正在跑一轮（可 force 强行）、profile 的 bundle 表解析不了（**查不到 profile 根目录也算没过**）、安排不出可靠的拉起手段。'
        + '任一不过就**拒绝并说明原因**，不会硬来。桌面端优先 Electron app.relaunch 正路，不可达时由一次性 helper 阶梯关停（温和关窗→宽限→必要时强杀→清孤儿）并按同一命令行拉起新实例；'
        + 'web 端由 helper 用同一命令行拉起并等 web 端口恢复（健康检查）才算成功。重启后原会话会被自动叫醒继续。'
        + '注意：重启会结束当前这一轮，所以调用后不要再依赖本轮后续的工具结果 —— 直接等你被叫醒。',
      parameters: {
        reason: { type: 'string', description: '为什么重启（写进审计日志，也用于熔断判断）。例如"改了宿主半的 index.js，让新路由生效"。' },
        force: { type: 'boolean', description: '即使有其他会话正在跑一轮也强行重启。默认 false —— 盲着重启会切断别人的工作。' },
        delayMs: { type: 'number', description: '延迟多少毫秒再真正重启（默认 1500）。留出时间把这次工具结果回传给模型。' },
      },
      // render 必须**返回内容段**而不是 null：返回 null 的话模型看不到结果，
      // 于是"被拒绝"这件事对它等于没发生，它会继续以为重启成功了。
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const caller = sessionIdOf(exec?.agent)
        const force = args?.force === true
        const g = preflight(force, caller)
        if (!g.ok) return refusal(g)
        const waitMs = Number.isFinite(Number(args?.delayMs)) ? Math.max(0, Number(args.delayMs)) : delayMs
        const info = fire(String(args?.reason ?? 'agent'), caller, waitMs)
        return {
          ok: true,
          restarted: true,
          mode: info.mode,
          delayMs: info.delayMs,
          resumeFor: caller ?? null,
          profileChecked: g.bundles?.checked === true ? { total: g.bundles.total, bad: 0 } : '未检查（找不到 profile 根目录）',
          note: '重启已排队。这个进程会在约 ' + info.delayMs + 'ms 后退出，'
            + (info.mode === 'desktop' ? '由 Electron 启动器拉起新实例' : '由一个 detached helper 用同一命令行拉起新实例，并等 web 端口恢复（健康检查）')
            + '。新实例起来后你会收到一条续作提示 —— 现在这一轮就到这里，不要等本轮的结果。',
        }
      },
    }))
    return () => { try { dispose() } catch { /* noop */ } }
  }, 'dsh-safety-restart: tool')

  // ── HTTP（给 web 端的界面按钮；桌面端不开端口，这条路由到不了）──
  ctx.effect(() => {
    const handler = async (req, res) => {
      const send = (code, obj) => {
        try {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        } catch { /* 连接已断 */ }
      }
      try {
        let url
        try { url = new URL(req.url, 'http://127.0.0.1') } catch { return send(400, { ok: false, error: 'bad url' }) }
        const isLocal = () => {
          // 桌面端载体是 IPC 垫片，**没有 socket** —— 没有网络就谈不上"远端"。
          const addr = req.socket?.remoteAddress
          if (addr === undefined) return true
          return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
        }
        if (url.pathname === ROUTE_PREFIX + '/status' && req.method === 'GET') {
          return send(200, {
            ok: true, mode: detectMode(),
            loop: restartLoopTripped({ windowMs: loopWindowMs, max: loopMax }),
            busy: [...liveBusy().keys()],
            audit: readAudit(10),
            resumePending,
          })
        }
        if (url.pathname === ROUTE_PREFIX + '/restart' && req.method === 'POST') {
          // 重启是特权操作：只接受本机来的请求。web 端可能被反代/远程访问，
          // 那个场景下这条路由必须拒绝（403），不能让人从外面重启你的机器上的 app。
          if (!isLocal()) return send(403, { ok: false, error: '重启只接受本机请求' })
          let reason = 'ui'
          let sessionId = null
          try {
            const chunks = []
            if (typeof req[Symbol.asyncIterator] === 'function') { for await (const c of req) chunks.push(c) }
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (parsed && typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason.slice(0, 200)
            // 可选 sessionId：带上了就写续作标记，重启后该会话会被 followup 自动唤醒——
            // 外部调用方（模型后台脚本、自动化）由此获得与工具路径相同的完整回环。
            if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) sessionId = parsed.sessionId.trim().slice(0, 80)
          } catch { /* 没有 body 就用默认原因 */ }
          const g = preflight(false, null)
          if (!g.ok) return send(409, refusal(g))
          const info = fire('ui:' + reason, sessionId)
          return send(200, {
            ok: true, restarted: true, mode: info.mode, delayMs: info.delayMs,
            resumeFor: sessionId,
            note: sessionId ? '重启已排队（续作标记已写，开机后自动接续该会话）' : '重启已排队（未带 sessionId，不写续作标记）',
          })
        }
        return send(404, { ok: false, error: 'not found', saw: { method: String(req.method ?? ''), pathname: String(url.pathname ?? '') } })
      } catch (e) {
        return send(500, { ok: false, error: String(e?.message ?? e) })
      }
    }
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    return () => { try { dispose() } catch { /* noop */ } }
  }, 'dsh-safety-restart: routes')
}
