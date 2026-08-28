import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply, findUndecidedApprovalId, inject } from '../src/index.js'

test('plugin declares the service dependencies it actually consumes', () => {
  assert.ok(inject.includes('settings'), 'settings is a real hard dependency for live config')
  assert.ok(inject.includes('sessions'), 'sessions events drive the whole companion feature')
})

test('package metadata exposes the DSH web client bundle', () => {
  const require = createRequire(import.meta.url)
  const metadata = require('dsh-dafeiyu/package.json')
  assert.equal(metadata.exports['./client'], './lib/client.js')
  assert.equal(metadata.dsh.client.platform, 'web')
  assert.deepEqual(metadata.bundleDependencies, [
    '@deepseek-ai/cosmokit',
    '@deepseek-ai/schemastery',
    '@standard-schema/spec',
  ])
})

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for plugin integration condition')
}

test('plugin forwards DSH-shaped session events and owns helper shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dafeiyu-plugin-'))
  const eventLog = join(directory, 'events.jsonl')
  const listeners = new Map()
  let dispose
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, callback) {
      listeners.set(name, callback)
    },
    effect(setup) {
      dispose = setup()
    },
  }

  apply(ctx, { helper: { headless: true, eventLog } })
  const session = { header: { id: 'phase0-real-shape' } }
  listeners.get('session/event')(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  listeners.get('session/event')(session, {
    type: 'tool/call',
    seq: 2,
    data: { callId: 'call-1', name: 'web_search' },
  })
  listeners.get('session/event')(session, {
    type: 'turn/end',
    seq: 3,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  dispose()

  await waitFor(async () => {
    try {
      return (await readFile(eventLog, 'utf8')).includes('"kind": "shutdown"')
    } catch {
      return false
    }
  })

  const messages = (await readFile(eventLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  assert.deepEqual(messages.map((message) => message.kind), [
    'hello',
    'state',
    'state',
    'state',
    'pulse',
    'shutdown',
  ])
  assert.deepEqual(messages.map((message) => message.state).filter(Boolean), [
    'IDLE',
    'IDLE',
    'THINKING',
    'WORKING',
    'SUCCESS',
  ])
  await rm(directory, { recursive: true, force: true })
})

test('live settings keep the active project state without restarting the helper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dafeiyu-live-settings-'))
  const eventLog = join(directory, 'events.jsonl')
  const listeners = new Map()
  let dispose
  let settingsListener
  let settingsValue = {
    enabled: true,
    scale: 1,
    bubbleScale: 1,
    activityLevel: 'normal',
    reducedMotion: false,
    soundEnabled: true,
    includeSubagents: false,
    balanceOnDoubleClick: true,
    approvalSound: true,
    approvalOnPet: true,
  }
  const settings = {
    get: () => ({ ...settingsValue }),
    watch(callback) {
      settingsListener = callback
      return () => { settingsListener = undefined }
    },
  }
  const ctx = {
    settings: { register: () => settings },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, callback) {
      listeners.set(name, callback)
    },
    effect(setup) {
      dispose = setup()
    },
  }

  apply(ctx, { helper: { headless: true, eventLog } })
  const activeSession = { header: { id: 'live-settings', cwd: 'D:\\work\\active-project' } }
  listeners.get('session/event')(activeSession, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  listeners.get('session/event')(activeSession, {
    type: 'todo/write',
    seq: 2,
    data: { todos: [{ content: '继续保留这个任务', status: 'in_progress' }] },
  })
  settingsValue = { ...settingsValue, scale: 0.9, bubbleScale: 0.8, soundEnabled: false, approvalOnPet: false }
  settingsListener(settingsValue)
  listeners.get('session/event')(activeSession, {
    type: 'tool/call',
    seq: 3,
    data: { callId: 'edit-after-settings', name: 'apply_patch' },
  })
  dispose()

  await waitFor(async () => {
    try {
      return (await readFile(eventLog, 'utf8')).includes('"kind": "shutdown"')
    } catch {
      return false
    }
  })

  const messages = (await readFile(eventLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(messages.filter((message) => message.kind === 'hello').length, 1)
  assert.equal(messages.filter((message) => message.kind === 'config').length, 1)
  const config = messages.find((message) => message.kind === 'config')
  assert.equal(config.soundEnabled, false)
  assert.equal(config.approvalOnPet, false)
  assert.equal(config.balanceOnDoubleClick, true)
  const working = messages.findLast((message) => message.state === 'WORKING')
  assert.equal(working.project, 'active-project')
  assert.equal(working.task, '继续保留这个任务')
  await rm(directory, { recursive: true, force: true })
})

test('helper context-menu changes persist through the DSH settings service', async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'settings-helper.js')
  const listeners = new Map()
  let dispose
  let settingsListener
  let persisted
  let settingsValue = {
    enabled: true,
    scale: 1,
    bubbleScale: 1,
    activityLevel: 'normal',
    reducedMotion: false,
    soundEnabled: true,
    bubbleMode: 'always',
    bubbleStates: ['SUCCESS', 'ERROR', 'WAITING'],
    includeSubagents: false,
  }
  const settings = {
    get: () => ({ ...settingsValue }),
    watch(callback) {
      settingsListener = callback
      return () => { settingsListener = undefined }
    },
    async update(patch) {
      persisted = patch
      settingsValue = { ...settingsValue, ...patch }
      settingsListener?.({ ...settingsValue })
    },
  }
  const ctx = {
    settings: { register: () => settings },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, callback) {
      listeners.set(name, callback)
    },
    effect(setup) {
      dispose = setup()
    },
  }

  apply(ctx, {
    helper: {
      command: process.execPath,
      args: [fixture],
      headless: false,
      heartbeatMs: 0,
    },
  })
  await waitFor(() => persisted !== undefined)
  assert.deepEqual(persisted, {
    scale: 0.6,
    bubbleScale: 0.9,
    reducedMotion: true,
  })
  assert.equal(settingsValue.scale, 0.6)
  assert.equal(settingsValue.bubbleScale, 0.9)
  assert.equal(settingsValue.reducedMotion, true)
  dispose()
})

test('findUndecidedApprovalId selects the newest unclaimed ask for the call', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'approval/asked', data: { id: 'older', callId: 'call-1' } },
    { type: 'approval/asked', data: { id: 'newer', callId: 'call-1' } },
  ]
  assert.equal(findUndecidedApprovalId(events, 'call-1', new Set()), 'newer')
  assert.equal(findUndecidedApprovalId(events, 'call-1', new Set(['newer'])), 'older')
  assert.equal(findUndecidedApprovalId(events, 'call-other', new Set()), undefined)

  const decided = [
    { type: 'approval/asked', data: { id: 'done', callId: 'call-2' } },
    { type: 'approval/decided', data: { id: 'done', outcome: 'rejected' } },
  ]
  assert.equal(findUndecidedApprovalId(decided, 'call-2', new Set()), undefined)
  assert.equal(findUndecidedApprovalId([], 'call-2', new Set()), undefined)
})

test('the pet claim resolves when the helper answers the approval', async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'approval-helper.js')
  const listeners = new Map()
  let dispose
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, callback) {
      listeners.set(name, callback)
    },
    effect(setup) {
      dispose = setup()
    },
  }

  apply(ctx, {
    helper: {
      command: process.execPath,
      args: [fixture],
      headless: false,
      heartbeatMs: 0,
    },
  })
  const request = listeners.get('approval/request')
  assert.equal(typeof request, 'function', 'the approval/request waterfall listener must be registered')

  // Let the fixture helper reach READY: the pet only claims approvals while
  // its bridge is spawned.
  await new Promise((resolve) => setTimeout(resolve, 500))

  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'approval/asked', data: { id: 'approval-test-1', toolName: 'bash', callId: 'call-9', reason: 'escalate sandbox' } },
  ]
  const claim = request({
    agent: { session: { events } },
    callId: 'call-9',
    toolName: 'bash',
    reason: 'escalate sandbox',
  }, () => 'fell-through')

  // A session state message wakes the fixture, which replies "yes".
  listeners.get('session/event')({ header: { id: 'session-approval' } }, {
    type: 'turn/start',
    seq: 1,
    data: { turn: 1 },
  })

  const outcome = await Promise.race([
    claim,
    new Promise((resolve) => setTimeout(() => resolve('claim-timeout'), 4000)),
  ])
  assert.equal(outcome, 'allowed-once')
  dispose()
})

test('approval claims pass through when the pet answering feature is off', async () => {
  const listeners = new Map()
  let dispose
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, callback) {
      listeners.set(name, callback)
    },
    effect(setup) {
      dispose = setup()
    },
  }

  apply(ctx, {
    approvalOnPet: false,
    helper: { headless: true, heartbeatMs: 0 },
  })
  const request = listeners.get('approval/request')
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'approval/asked', data: { id: 'approval-pass', toolName: 'bash', callId: 'call-1' } },
  ]
  const outcome = request({
    agent: { session: { events } },
    callId: 'call-1',
  }, () => 'fell-through')
  assert.equal(outcome, 'fell-through')
  dispose()
})
