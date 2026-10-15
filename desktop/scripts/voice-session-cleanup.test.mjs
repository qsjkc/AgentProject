import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

import { createAuthContextChangedError, isSessionSnapshotCurrent } from '../src/shared/pet-account-context.js'

// Exercise the actual HTTP and deadline logic without a server, microphone, or
// disk artifacts. Only the existing shared API's account/bridge boundary is fake.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/voice-api.js', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'voice-cleanup-api-fixture',
    setup(builder) {
      builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: ['assertApiOperationContextCurrent', 'clearSessionToken', 'desktopApiRequest', 'getApiBaseUrl', 'getSessionSnapshot']
          .map((name) => `export const ${name} = (...args) => globalThis.__voiceCleanupApi.${name}(...args)`)
          .join('\n'),
        loader: 'js',
      }))
    },
  }],
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
let moduleId = 0
const restoreGlobals = []
afterEach(() => {
  while (restoreGlobals.length) restoreGlobals.pop()()
})

function deferred() {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}

async function flushUntil(predicate) {
  for (let index = 0; index < 100 && !predicate(); index += 1) await Promise.resolve()
  assert.ok(predicate(), 'expected asynchronous stage was reached')
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

async function fixture({ fetchImpl } = {}) {
  const descriptors = new Map(['fetch', 'setTimeout', 'clearTimeout', '__voiceCleanupApi']
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  restoreGlobals.push(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  const context = Object.freeze({ authoritative: { id: 'a' }, session: { token: 'account-a', generation: 1 } })
  let current = context.session
  let server = 'https://original.example/api/v1'
  const calls = { http: [], generic: [], cleared: [], snapshots: 0, servers: 0 }
  let nextTimer = 0
  const timers = new Map()
  globalThis.setTimeout = (callback, duration) => {
    const id = ++nextTimer
    timers.set(id, { callback, duration })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  const assertCurrent = async (operationContext) => {
    if (!operationContext?.authoritative || !isSessionSnapshotCurrent(operationContext.session, current)) {
      throw createAuthContextChangedError()
    }
  }
  globalThis.__voiceCleanupApi = {
    assertApiOperationContextCurrent: assertCurrent,
    getSessionSnapshot: async () => { calls.snapshots += 1; return current },
    getApiBaseUrl: async () => { calls.servers += 1; return server },
    clearSessionToken: async (expected) => {
      calls.cleared.push(expected)
      if (!isSessionSnapshotCurrent(expected, current)) return false
      current = { token: null, generation: current.generation + 1 }
      return true
    },
    desktopApiRequest: async (path, options, operationContext) => {
      calls.generic.push({ path, options, operationContext })
      await assertCurrent(operationContext)
      return { generic: true }
    },
  }
  globalThis.fetch = async (url, options) => {
    calls.http.push({ url, options })
    if (fetchImpl) return fetchImpl(url, options, calls.http.length)
    return url.endsWith('/stop') ? response({ success: true }) : response({ sessionId: 'voice-a' })
  }
  const api = await import(`${moduleUrl}#fixture-${++moduleId}`)
  return {
    api, calls, context, timers,
    getCurrent: () => current,
    switchAccount: () => { current = { token: 'account-b', generation: 2 } },
    logout: () => { current = { token: null, generation: 2 } },
    switchServer: () => { server = 'https://new.example/api/v1' },
    runTimer(duration) {
      const entry = [...timers.entries()].find(([, timer]) => timer.duration === duration)
      assert.ok(entry, `expected a ${duration}ms deadline`)
      const [id, timer] = entry
      timers.delete(id)
      timer.callback()
    },
  }
}

test('a successful create arriving after account A changed to B stops only A\'s created session', async () => {
  const creatingBody = deferred()
  const item = await fixture({ fetchImpl: (url) => url.endsWith('/stop')
    ? response({ success: true })
    : { ...response(null), json: () => creatingBody.promise } })
  const creating = item.api.createVoiceDemoSession({ pet_type: 'pig' }, item.context)
  await flushUntil(() => item.calls.http.length === 1)
  item.switchAccount()
  creatingBody.resolve({ sessionId: 'voice-a' })
  await assert.rejects(creating, { code: 'AUTH_CONTEXT_CHANGED' })
  await flushUntil(() => item.calls.http.length === 2)
  assert.equal(item.calls.http[1].url, 'https://original.example/api/v1/rtc/voice-demo/session/voice-a/stop')
  assert.equal(item.calls.http[1].options.headers.Authorization, 'Bearer account-a')
  assert.equal(item.calls.http[1].options.method, 'POST')
  assert.equal(item.calls.http[1].options.redirect, 'error')
  assert.equal(item.getCurrent().token, 'account-b')
  assert.equal(item.calls.generic.length, 0)
  assert.equal(item.calls.cleared.length, 0)
  await flushUntil(() => item.timers.size === 0)
})

test('an active voice session can be stopped after logout without consulting the next login', async () => {
  const item = await fixture()
  const created = await item.api.createVoiceDemoSession({}, item.context)
  item.logout()
  const callsBefore = { snapshots: item.calls.snapshots, servers: item.calls.servers }
  assert.deepEqual(await item.api.stopVoiceDemoSession(created.sessionId, item.context), { success: true })
  assert.deepEqual(await item.api.stopVoiceDemoSession(created.sessionId, item.context), { success: true })
  assert.equal(item.calls.http.length, 2, 'a completed stop is idempotent')
  assert.equal(item.calls.snapshots, callsBefore.snapshots)
  assert.equal(item.calls.servers, callsBefore.servers)
  assert.equal(item.calls.http[1].options.headers.Authorization, 'Bearer account-a')
  assert.equal(item.calls.cleared.length, 0)
})

test('a server change during create cleans the original server and cannot deliver stale credentials', async () => {
  const creating = deferred()
  const item = await fixture({ fetchImpl: (url) => url.endsWith('/stop') ? response({ success: true }) : creating.promise })
  const pending = item.api.createVoiceDemoSession({}, item.context)
  await flushUntil(() => item.calls.http.length === 1)
  item.switchServer()
  creating.resolve(response({ sessionId: 'voice-a' }))
  await assert.rejects(pending, { code: 'AUTH_CONTEXT_CHANGED' })
  await flushUntil(() => item.calls.http.length === 2)
  assert.ok(item.calls.http.every((call) => call.url.startsWith('https://original.example/')))
  await flushUntil(() => item.timers.size === 0)
})

test('a later stop keeps the captured server and token even when both have changed', async () => {
  const item = await fixture()
  await item.api.createVoiceDemoSession({}, item.context)
  item.switchServer()
  item.switchAccount()
  await item.api.stopVoiceDemoSession('voice-a', item.context)
  assert.equal(item.calls.http[1].url, 'https://original.example/api/v1/rtc/voice-demo/session/voice-a/stop')
  assert.equal(item.calls.http[1].options.headers.Authorization, 'Bearer account-a')
})

test('owned cleanup does not authorize start, get, interrupt, another session, or a copied context', async () => {
  const item = await fixture()
  await item.api.createVoiceDemoSession({}, item.context)
  item.switchAccount()
  for (const name of ['startVoiceDemoSession', 'getVoiceDemoSession', 'interruptVoiceDemoSession']) {
    await assert.rejects(item.api[name]('voice-a', item.context), { code: 'AUTH_CONTEXT_CHANGED' })
  }
  await assert.rejects(item.api.stopVoiceDemoSession('voice-other', item.context), { code: 'AUTH_CONTEXT_CHANGED' })
  await assert.rejects(item.api.stopVoiceDemoSession('voice-a', { ...item.context }), { code: 'AUTH_CONTEXT_CHANGED' })
  assert.equal(item.calls.generic.length, 5)
  assert.equal(item.calls.http.length, 1)
  await item.api.stopVoiceDemoSession('voice-a', item.context)
  assert.equal(item.calls.http.length, 2)
})

test('a stale failed create cannot expire the account that replaced it', async () => {
  const creating = deferred()
  const item = await fixture({ fetchImpl: () => creating.promise })
  const pending = item.api.createVoiceDemoSession({}, item.context)
  await flushUntil(() => item.calls.http.length === 1)
  item.switchAccount()
  creating.resolve(response({ detail: 'Expired' }, 401))
  await assert.rejects(pending, { code: 'AUTH_CONTEXT_CHANGED' })
  assert.equal(item.calls.cleared.length, 0)
  assert.equal(item.getCurrent().token, 'account-b')
  assert.equal(item.calls.http.length, 1)
})

test('a current create authentication failure still expires only its expected login', async () => {
  const item = await fixture({ fetchImpl: () => response({ detail: 'Expired' }, 401) })
  await assert.rejects(item.api.createVoiceDemoSession({}, item.context), { code: 'VOICE_AUTH_EXPIRED' })
  assert.deepEqual(item.calls.cleared, [item.context.session])
  assert.equal(item.getCurrent().token, null)
})

test('a refused cleanup never clears the new account and a later cleanup can retry', async () => {
  let refused = true
  const item = await fixture({ fetchImpl: (url) => {
    if (!url.endsWith('/stop')) return response({ sessionId: 'voice-a' })
    return refused ? response({ detail: 'Expired' }, 401) : response({ success: true })
  } })
  await item.api.createVoiceDemoSession({}, item.context)
  item.switchAccount()
  await assert.rejects(item.api.stopVoiceDemoSession('voice-a', item.context), { status: 401 })
  assert.equal(item.calls.cleared.length, 0)
  assert.equal(item.getCurrent().token, 'account-b')
  refused = false
  assert.deepEqual(await item.api.stopVoiceDemoSession('voice-a', item.context), { success: true })
})

test('cleanup has a bounded deadline even when its response body stalls', async () => {
  const body = deferred()
  const item = await fixture({ fetchImpl: (url) => url.endsWith('/stop')
    ? { ...response(null), json: () => body.promise }
    : response({ sessionId: 'voice-a' }) })
  await item.api.createVoiceDemoSession({}, item.context)
  item.logout()
  const stopping = item.api.stopVoiceDemoSession('voice-a', item.context)
  const rejected = assert.rejects(stopping, { code: 'REQUEST_TIMEOUT' })
  await flushUntil(() => item.calls.http.length === 2)
  item.runTimer(5_000)
  await rejected
  assert.equal(item.calls.http[1].options.signal.aborted, true)
  assert.equal(item.timers.size, 0)
  body.resolve({ success: true })
})

test('a create timeout settles promptly and still cleans a success returned by an abort-ignoring transport', async () => {
  const creating = deferred()
  const item = await fixture({ fetchImpl: (url) => url.endsWith('/stop') ? response({ success: true }) : creating.promise })
  const pending = item.api.createVoiceDemoSession({}, item.context)
  const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT' })
  await flushUntil(() => item.calls.http.length === 1)
  item.runTimer(30_000)
  await rejected
  assert.equal(item.calls.http[0].options.signal.aborted, true)
  item.switchAccount()
  creating.resolve(response({ sessionId: 'voice-a' }))
  await flushUntil(() => item.calls.http.length === 2)
  assert.equal(item.calls.http[1].options.headers.Authorization, 'Bearer account-a')
  assert.equal(item.calls.cleared.length, 0)
  await flushUntil(() => item.timers.size === 0)
})

test('concurrent stop requests reuse the same fixed cleanup and encode the owned session path', async () => {
  const stopping = deferred()
  const sessionId = 'voice/a?next=other#fragment'
  const item = await fixture({ fetchImpl: (url) => url.endsWith('/stop') ? stopping.promise : response({ sessionId }) })
  await item.api.createVoiceDemoSession({}, item.context)
  const first = item.api.stopVoiceDemoSession(sessionId, item.context)
  const second = item.api.stopVoiceDemoSession(sessionId, item.context)
  assert.equal(first, second)
  await flushUntil(() => item.calls.http.length === 2)
  assert.equal(item.calls.http[1].url, `https://original.example/api/v1/rtc/voice-demo/session/${encodeURIComponent(sessionId)}/stop`)
  stopping.resolve(response({ success: true }))
  await first
})
