import { createRequire } from 'node:module'
import Schema from '@deepseek-ai/schemastery'
import { CompanionReducer } from './companion-reducer.js'
import { fetchDeepSeekBalance } from './deepseek-balance.js'
import { HelperProcess } from './helper-process.js'
import {
  CompanionMessageKind,
  CompanionState,
  createMessage,
} from './protocol.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

export const name = 'dsh-dafeiyu'
// The plugin's feature is built on session events, and mounting requires the
// settings service (used to read live config). Keep the declared inject in
// sync with those real hard dependencies instead of listing a service that
// is never consumed directly.
export const inject = ['sessions', 'settings']
export const CONFIG_ENDPOINT = '/plugins/dsh-dafeiyu/config'
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用桌面大肥鱼'),
  scale: Schema.number().min(0.55).max(1.4).step(0.05).default(1).role('slider').description('角色大小'),
  bubbleScale: Schema.number().min(0.8).max(1.2).step(0.05).default(1).role('slider').description('气泡大小'),
  activityLevel: Schema.union([
    Schema.const('quiet').description('安静'),
    Schema.const('normal').description('标准'),
    Schema.const('lively').description('活泼'),
  ]).default('normal').description('空闲微动作频率'),
  reducedMotion: Schema.boolean().default(false).description('减少走动、循环帧和程序化晃动'),
  soundEnabled: Schema.boolean().default(true).description('任务完成或出错时播放提示音'),
  bubbleMode: Schema.union([
    Schema.const('always').description('常驻显示'),
    Schema.const('hidden').description('完全隐藏'),
    Schema.const('custom').description('自定义显示状态'),
  ]).default('always').description('气泡显示模式'),
  bubbleStates: Schema.array(Schema.string()).default(['SUCCESS', 'ERROR', 'WAITING']).description('自定义模式下显示气泡的状态'),
  includeSubagents: Schema.boolean().default(false).description('允许子 Agent 抢占宠物状态'),
  balanceOnDoubleClick: Schema.boolean().default(true).description('双击大肥鱼查询 API 余额'),
  approvalSound: Schema.boolean().default(true).description('权限沙盒拦截时播放提示音'),
  approvalOnPet: Schema.boolean().default(true).description('通过大肥鱼对话框应答权限（是/否）'),
}).description('由 DeepSeek Harness 状态驱动的桌面大肥鱼伴侣')

const defaults = Object.freeze({
  enabled: true,
  scale: 1,
  bubbleScale: 1,
  activityLevel: 'normal',
  reducedMotion: false,
  soundEnabled: true,
  bubbleMode: 'always',
  bubbleStates: ['SUCCESS', 'ERROR', 'WAITING'],
  includeSubagents: false,
  balanceOnDoubleClick: true,
  approvalSound: true,
  approvalOnPet: true,
})

function publicConfig(config = {}) {
  return {
    enabled: config.enabled ?? defaults.enabled,
    scale: config.scale ?? defaults.scale,
    bubbleScale: config.bubbleScale ?? defaults.bubbleScale,
    activityLevel: config.activityLevel ?? defaults.activityLevel,
    reducedMotion: config.reducedMotion ?? defaults.reducedMotion,
    soundEnabled: config.soundEnabled ?? defaults.soundEnabled,
    bubbleMode: config.bubbleMode ?? defaults.bubbleMode,
    bubbleStates: Array.isArray(config.bubbleStates) ? config.bubbleStates : defaults.bubbleStates,
    includeSubagents: config.includeSubagents ?? defaults.includeSubagents,
    balanceOnDoubleClick: config.balanceOnDoubleClick ?? defaults.balanceOnDoubleClick,
    approvalSound: config.approvalSound ?? defaults.approvalSound,
    approvalOnPet: config.approvalOnPet ?? defaults.approvalOnPet,
  }
}

function localSettingsScope(value) {
  return {
    get: () => value,
    watch: () => () => {},
  }
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

// How long the pet may hold an approval dialog before the ask lapses. The
// host's own WebUI approval card waits forever, but a desktop dialog that the
// user walked away from must not block the agent indefinitely.
const APPROVAL_WAIT_TIMEOUT_MS = 10 * 60 * 1000

// Find the newest undecided `approval/asked` event in a session log that this
// plugin has not claimed yet. The approval id is not part of the waterfall
// request object, so the claim must be reconciled against the durable log the
// same way the host's api-proxy does it.
function findUndecidedApprovalId(events, callId, pending) {
  if (!Array.isArray(events)) return undefined
  const decided = new Set()
  const expectedCallId = callId ?? null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'approval/decided') {
      decided.add(String(event.data?.id ?? ''))
    } else if (event?.type === 'approval/asked') {
      const id = String(event.data?.id ?? '')
      if (!id || decided.has(id) || pending.has(id)) continue
      if (expectedCallId !== (event.data?.callId ?? null)) continue
      return id
    }
  }
  return undefined
}

async function readPatch(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 8192) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('patch must be an object')
  const allowed = new Set(Object.keys(defaults))
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('patch contains an unknown setting')
  return value
}

export function createConfigHandler(settings) {
  return async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    const origin = req.headers?.origin
    if (origin) {
      let originHost
      try { originHost = new URL(origin).host } catch {}
      if (!originHost || originHost !== req.headers.host) {
        jsonResponse(res, 403, { error: 'origin mismatch' })
        return
      }
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, settings.get())
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      await settings.update(await readPatch(req))
      jsonResponse(res, 200, settings.get())
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function mount(ctx, config = {}, eventCtx = ctx) {
  const logger = ctx.logger ?? console
  const base = publicConfig(config)
  const settings = ctx.settings?.register?.('dsh-dafeiyu', Config, {
    base,
    applies: 'live',
  }) ?? localSettingsScope(base)

  let bridge
  let reducer
  let restartTimer

  // Approvals the pet has claimed through the `approval/request` waterfall.
  // Each entry resolves the claim promise when the pet answers, the ask is
  // aborted, or the claim lapses. `fallback` hands unclaimed asks back to the
  // host's own WebUI channel by resolving the waterfall promise closed.
  const pendingApprovals = new Map()

  const settleApproval = (entry, outcome) => {
    if (entry.settled) return
    entry.settled = true
    pendingApprovals.delete(entry.id)
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    entry.cleanup?.()
    entry.resolve(outcome)
  }

  const fallbackPendingApprovals = (reason) => {
    if (pendingApprovals.size === 0) return
    for (const entry of [...pendingApprovals.values()]) {
      settleApproval(entry, 'unavailable')
      logger.warn?.(`dsh-dafeiyu approval ${entry.id} fell back to unavailable (${reason})`)
    }
  }

  const stopRuntime = (reason = 'settings-change') => {
    // Pending asks the pet was holding must not hang the agent after the pet
    // goes away: fail them closed instead of waiting forever.
    fallbackPendingApprovals(reason)
    bridge?.stop(reason)
    bridge = undefined
    reducer = undefined
  }

  const restartRuntime = (next) => {
    stopRuntime('settings-change')
    startRuntime(next)
  }

  const applyLiveSettings = (next) => {
    for (const message of reducer.setIncludeSubagents(next.includeSubagents === true)) bridge.send(message)
    for (const message of reducer.setApprovalAnswerable(next.approvalOnPet === true)) bridge.send(message)
    if (next.approvalOnPet !== true) fallbackPendingApprovals('approval-on-pet-disabled')
    bridge.send(createMessage(CompanionMessageKind.CONFIG, {
      scale: next.scale ?? defaults.scale,
      bubbleScale: next.bubbleScale ?? defaults.bubbleScale,
      activityLevel: next.activityLevel ?? defaults.activityLevel,
      reducedMotion: next.reducedMotion === true,
      soundEnabled: next.soundEnabled !== false,
      bubbleMode: next.bubbleMode ?? defaults.bubbleMode,
      bubbleStates: Array.isArray(next.bubbleStates) ? next.bubbleStates : defaults.bubbleStates,
      balanceOnDoubleClick: next.balanceOnDoubleClick !== false,
      approvalSound: next.approvalSound !== false,
      approvalOnPet: next.approvalOnPet === true,
    }))
  }

  const scheduleRestart = (next) => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      restartRuntime(next)
    }, 400)
    restartTimer.unref?.()
  }

  const startRuntime = (resolved) => {
    if (resolved.enabled === false) {
      logger.info?.('dsh-dafeiyu is disabled')
      return
    }
    const helperConfig = config.helper ?? {}
    bridge = new HelperProcess({
      ...helperConfig,
      env: {
        ...helperConfig.env,
        DSH_DAFEIYU_SCALE: String(resolved.scale ?? defaults.scale),
        DSH_DAFEIYU_BUBBLE_SCALE: String(resolved.bubbleScale ?? defaults.bubbleScale),
        DSH_DAFEIYU_ACTIVITY_LEVEL: String(resolved.activityLevel ?? defaults.activityLevel),
        DSH_DAFEIYU_REDUCED_MOTION: resolved.reducedMotion === true ? '1' : '0',
        DSH_DAFEIYU_SOUND_ENABLED: resolved.soundEnabled !== false ? '1' : '0',
        DSH_DAFEIYU_BUBBLE_MODE: String(resolved.bubbleMode ?? defaults.bubbleMode),
        DSH_DAFEIYU_BUBBLE_STATES: (Array.isArray(resolved.bubbleStates) ? resolved.bubbleStates : defaults.bubbleStates).join(','),
        DSH_DAFEIYU_WEBUI_URL: String(config.webuiUrl ?? process.env.DSH_DAFEIYU_WEBUI_URL ?? 'http://127.0.0.1:3080/'),
        DSH_DAFEIYU_BALANCE_ON_DBLCLICK: resolved.balanceOnDoubleClick !== false ? '1' : '0',
        DSH_DAFEIYU_APPROVAL_SOUND: resolved.approvalSound !== false ? '1' : '0',
        DSH_DAFEIYU_APPROVAL_ON_PET: resolved.approvalOnPet === true ? '1' : '0',
      },
      onSettingsChange: (report) => {
        if (typeof settings.update !== 'function') return
        const patch = {}
        if (Number.isFinite(report.scale)) patch.scale = Math.min(1.4, Math.max(0.55, report.scale))
        if (Number.isFinite(report.bubbleScale)) patch.bubbleScale = Math.min(1.2, Math.max(0.8, report.bubbleScale))
        if (typeof report.reducedMotion === 'boolean') patch.reducedMotion = report.reducedMotion
        if (Object.keys(patch).length === 0) return
        void Promise.resolve(settings.update(patch)).catch((error) => {
          logger.warn?.(`dsh-dafeiyu failed to persist helper settings: ${error instanceof Error ? error.message : String(error)}`)
        })
      },
      onBalanceRequest: () => fetchDeepSeekBalance(ctx, logger),
      onApprovalDecision: (reply) => {
        const id = String(reply?.approvalId ?? '')
        const entry = id ? pendingApprovals.get(id) : undefined
        if (!entry || entry.settled) {
          if (id) logger.debug?.(`dsh-dafeiyu approval decision arrived for unknown id ${id}`)
          return
        }
        const outcome = reply?.decision === 'yes' ? 'allowed-once' : 'rejected'
        settleApproval(entry, outcome)
        logger.debug?.(`dsh-dafeiyu approval ${id} decided by the pet: ${outcome}`)
      },
      onDisconnect: (reason) => fallbackPendingApprovals(`pet-disconnect:${reason}`),
    }, logger)
    reducer = new CompanionReducer({
      includeSubagents: resolved.includeSubagents === true,
      approvalAnswerable: resolved.approvalOnPet === true,
    })
    bridge.start()
    bridge.send(createMessage(CompanionMessageKind.HELLO, {
      state: CompanionState.IDLE,
      host: 'deepseek-harness',
      pluginVersion: pkg.version,
      message: 'BigFish connected to DSH',
    }))
    bridge.send(createMessage(CompanionMessageKind.STATE, {
      state: CompanionState.IDLE,
      phase: 'plugin-start',
      stage: '等待任务',
      message: '我在这儿等新任务哦',
      detail: 'DSH · 等待下一次任务',
    }))
    logger.info?.('dsh-dafeiyu companion bridge started')
  }

  startRuntime(settings.get())

  // The companion intentionally observes every DSH session. Loader entries may
  // live inside a scoped composition, so use the unscoped root bus and dispose
  // the registrations explicitly with this plugin's lifecycle.
  // Never let an exception from this optional companion escape into the shared
  // session bus: a throw here could stop every other subscriber from seeing
  // the event, which would look exactly like "installing the pet broke other
  // plugins".
  const offEvent = eventCtx.on('session/event', (session, event) => {
    if (!bridge || !reducer) return
    try {
      for (const message of reducer.handle(session, event)) bridge.send(message)
    } catch (error) {
      logger.error?.('dsh-dafeiyu failed to handle session event', error)
    }
  }, { global: true })
  const offDisposed = eventCtx.on('session/disposed', (session) => {
    if (!bridge || !reducer) return
    try {
      for (const message of reducer.disposeSession(session)) bridge.send(message)
    } catch (error) {
      logger.error?.('dsh-dafeiyu failed to dispose session', error)
    }
  }, { global: true })

  // Answer sandbox escalation asks from the desktop pet. This listener runs
  // BEFORE the host's api-proxy listener (prepend), so when the pet feature is
  // enabled the pet's yes/no dialog is the approval channel; when it is
  // disabled (or the helper is down) the ask passes straight through to the
  // WebUI. The claim promise resolves with the pet's decision, an abort, a
  // lapse, or a fail-closed fallback when the pet disappears.
  const offApprovalRequest = eventCtx.on('approval/request', (req, next) => {
    // The pet must be alive to answer: `bridge.spawned` is false after the
    // user closes the window (本次关闭), after a crash, and before READY, so
    // those asks pass straight through to the WebUI channel.
    if (!bridge || !bridge.spawned || settings.get()?.approvalOnPet !== true) return next()
    let approvalId
    try {
      approvalId = findUndecidedApprovalId(req?.agent?.session?.events, req?.callId, pendingApprovals)
    } catch (error) {
      logger.error?.('dsh-dafeiyu failed to inspect approval request', error)
      return next()
    }
    if (!approvalId) return next()
    return new Promise((resolve) => {
      const entry = { id: approvalId, resolve, settled: false, timer: undefined, cleanup: undefined }
      pendingApprovals.set(approvalId, entry)
      const onAbort = () => settleApproval(entry, 'cancelled')
      if (req.signal?.aborted === true) {
        settleApproval(entry, 'cancelled')
        return
      }
      req.signal?.addEventListener('abort', onAbort, { once: true })
      entry.cleanup = () => req.signal?.removeEventListener('abort', onAbort)
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        settleApproval(entry, 'unavailable')
        logger.warn?.(`dsh-dafeiyu approval ${approvalId} timed out without an answer`)
      }, APPROVAL_WAIT_TIMEOUT_MS)
      entry.timer.unref?.()
    })
  }, { global: true, prepend: true })

  const unwatch = settings.watch((next) => {
    // Disabling is the only path that tears the helper down.  Every other
    // setting is applied live through a CONFIG message, so sliders never
    // restart the pet.  Starting a previously-disabled runtime is debounced
    // to avoid spawning repeatedly while settings settle.
    if (next.enabled === false) {
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = undefined
      }
      stopRuntime('settings-change')
      return
    }
    if (!bridge) {
      scheduleRestart(next)
      return
    }
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
    applyLiveSettings(next)
  })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: CONFIG_ENDPOINT, handler: createConfigHandler(settings) }),
        'dsh-dafeiyu: local settings endpoint',
      )
    })
  }
  ctx.effect(() => () => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = undefined
    offEvent?.()
    offDisposed?.()
    offApprovalRequest?.()
    unwatch()
    stopRuntime('dsh-host-stop')
  })
}

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => mount(settingsCtx, config, ctx))
    return
  }
  mount(ctx, config)
}

export {
  CompanionMessageKind,
  CompanionReducer,
  CompanionState,
  HelperProcess,
  findUndecidedApprovalId,
}
