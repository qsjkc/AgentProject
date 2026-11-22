import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createSessionRecoveryController } from '../src/shared/session-recovery.js'
import accountBoundary from '../electron/account-boundary.cjs'

const bundledApi = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/api.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  define: { 'import.meta.env': '{"DEV":false,"VITE_API_BASE_URL":""}', __DETACHYM_DEFAULT_API_BASE_URL__: '""' },
})
const apiModuleUrl = `data:text/javascript;base64,${Buffer.from(bundledApi.outputFiles[0].text).toString('base64')}`
let apiSequence = 0

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(restore = async () => true) {
  let context = { server: 'https://fixture-a.invalid/api/v1', session: { token: 'saved-fixture-token', generation: 1 } }
  let clock = 1000
  const states = []
  const calls = []
  const timers = new Map()
  let timerId = 0
  const controller = createSessionRecoveryController({
    readContext: async () => structuredClone(context),
    restore: async (...args) => { calls.push(args); return restore(...args) },
    onStateChange: (state) => states.push(state),
    now: () => clock,
    setTimer(callback, delay) {
      const id = ++timerId
      timers.set(id, { callback, at: clock + delay })
      return id
    },
    clearTimer: (id) => timers.delete(id),
  })
  return {
    controller, states, calls,
    get context() { return structuredClone(context) },
    setContext(value) { context = value },
    advance(ms) {
      const target = clock + ms
      for (const [id, { callback, at }] of timers) {
        if (at > target) continue
        timers.delete(id)
        clock = at
        callback()
      }
      clock = target
    },
  }
}

test('transient recovery failure keeps the saved account and manual retry needs no credentials', async () => {
  let offline = true
  const unavailable = Object.assign(new Error('Service unavailable'), { status: 503 })
  const f = fixture(async () => { if (offline) throw unavailable; return true })
  const saved = f.context
  assert.equal(await f.controller.run(), false)
  assert.equal(f.states.at(-1).status, 'retryable')
  assert.equal(f.states.at(-1).error, unavailable)
  assert.deepEqual(f.context, saved)
  offline = false
  assert.equal(await f.controller.run(), true)
  assert.equal(f.states.at(-1).status, 'idle')
  assert.deepEqual(f.calls.map(([context]) => context), [saved, saved])
})

test('manual, online, and focus retries share one pending request and automatic cooldown', async () => {
  let outcome = false
  let hold = null
  const f = fixture(async () => hold ? hold.promise : outcome)
  assert.equal(await f.controller.run({ automatic: true }), false, 'idle must not auto-load')
  assert.equal(f.calls.length, 0)
  assert.equal(await f.controller.run(), false)
  assert.equal(await f.controller.run({ automatic: true }), false)
  f.advance(1499)
  assert.equal(await f.controller.run({ automatic: true }), false)
  assert.equal(f.calls.length, 1)
  f.advance(1)
  hold = deferred()
  const first = f.controller.run({ automatic: true })
  assert.equal(f.controller.run(), first)
  assert.equal(f.controller.run({ automatic: true }), first)
  assert.equal(f.controller.run({ automatic: true, online: true }), first)
  await Promise.resolve()
  await Promise.resolve()
  hold.resolve(true)
  assert.equal(await first, true)
  assert.equal(f.calls.length, 2)
  f.advance(2000)
  assert.equal(await f.controller.run({ automatic: true }), false, 'healthy dashboard must not rehydrate on focus')
  assert.equal(f.calls.length, 2)
})

for (const onlineWhilePending of [false, true]) {
  const order = onlineWhilePending ? 'during a failing request' : 'during its cooldown'
  test(`one online event ${order} retries the same saved session`, async () => {
    const response = deferred()
    const entered = deferred()
    let attempts = 0
    const f = fixture(async () => {
      if (++attempts > 1) return true
      entered.resolve()
      return response.promise
    })
    const saved = f.context
    const pending = f.controller.run()
    await entered.promise
    f.advance(600)
    if (!onlineWhilePending) {
      response.reject(new Error('temporary outage'))
      assert.equal(await pending, false)
    }
    const online = () => f.controller.run({ automatic: true, online: true })
    if (onlineWhilePending) {
      assert.equal(online(), pending)
      assert.equal(online(), pending)
      response.reject(new Error('temporary outage'))
      assert.equal(await pending, false)
    } else {
      await online()
      await online()
    }
    f.advance(899)
    assert.equal(f.calls.length, 1, 'Online recovery must respect the remaining cooldown')
    f.advance(1)
    await new Promise(setImmediate)
    assert.deepEqual(f.calls.map(([context]) => context), [saved, saved])
    assert.equal(f.states.at(-1).status, 'idle')
  })
}

test('a failed online retry does not queue another retry from duplicate online events', async () => {
  const second = deferred()
  const entered = deferred()
  let attempts = 0
  const f = fixture(async () => {
    if (++attempts === 1) return false
    entered.resolve()
    return second.promise
  })
  assert.equal(await f.controller.run(), false)
  f.advance(1500)
  const retry = f.controller.run({ automatic: true, online: true })
  await entered.promise
  assert.equal(f.controller.run({ automatic: true, online: true }), retry)
  second.resolve(false)
  assert.equal(await retry, false)
  f.advance(3000)
  await new Promise(setImmediate)
  assert.equal(f.calls.length, 2)
  assert.equal(f.states.at(-1).status, 'retryable')
})

for (const transition of ['server change', 'session generation change', 'invalidation', 'disposal', 'manual retry']) {
  test(`a queued online retry cannot take over after ${transition}`, async () => {
    let attempts = 0
    const f = fixture(async () => ++attempts > 1)
    assert.equal(await f.controller.run(), false)
    f.advance(600)
    await f.controller.run({ automatic: true, online: true })
    if (transition === 'server change') f.setContext({ ...f.context, server: 'https://fixture-b.invalid/api/v1' })
    if (transition === 'session generation change') f.setContext({ ...f.context, session: { ...f.context.session, generation: 2 } })
    if (transition === 'invalidation') f.controller.invalidate()
    if (transition === 'disposal') f.controller.dispose()
    if (transition === 'manual retry') assert.equal(await f.controller.run(), true)
    f.advance(3000)
    await new Promise(setImmediate)
    assert.equal(f.calls.length, transition === 'manual retry' ? 2 : 1)
  })
}

for (const transition of ['logout', 'account', 'generation', 'server']) {
  for (const completion of ['success', 'failure']) {
    test(`late ${completion} cannot revive a recovery after ${transition}`, async () => {
      const hold = deferred()
      const entered = deferred()
      const f = fixture(async () => { entered.resolve(); return hold.promise })
      const pending = f.controller.run()
      await entered.promise
      const current = f.context
      if (transition === 'logout') current.session = { token: null, generation: 2 }
      if (transition === 'account') current.session = { token: 'account-b', generation: 2 }
      if (transition === 'generation') current.session.generation += 1
      if (transition === 'server') current.server = 'https://fixture-b.invalid/api/v1'
      f.setContext(current)
      const [, guards] = f.calls[0]
      assert.equal(await guards.isContextCurrent(), false)
      if (completion === 'success') hold.resolve(true)
      else hold.reject(new Error('late outage'))
      assert.equal(await pending, false)
      assert.equal(f.states.at(-1).status, 'idle')
      assert.equal(f.states.at(-1).error, null)
      assert.deepEqual(f.context, current)
    })
  }
}

test('invalidating old recovery allows a new one without old completion clearing its lock', async () => {
  const holds = [deferred(), deferred()]
  const entered = [deferred(), deferred()]
  let index = 0
  const f = fixture(async () => { const selected = index++; entered[selected].resolve(); return holds[selected].promise })
  const stale = f.controller.run()
  await entered[0].promise
  const staleGuard = f.calls[0][1]
  f.controller.invalidate()
  assert.equal(staleGuard.isCurrent(), false)
  const current = f.controller.run()
  await entered[1].promise
  holds[0].resolve(true)
  assert.equal(await stale, false)
  assert.equal(f.states.at(-1).status, 'recovering')
  assert.equal(f.controller.run(), current)
  holds[1].resolve(true)
  assert.equal(await current, true)
  assert.equal(f.states.at(-1).status, 'idle')
})

test('disposed renderers suppress late failure and all subsequent recovery', async () => {
  const hold = deferred()
  const entered = deferred()
  const f = fixture(async () => { entered.resolve(); return hold.promise })
  const pending = f.controller.run()
  await entered.promise
  f.controller.dispose()
  const count = f.states.length
  hold.reject(new Error('late failure'))
  assert.equal(await pending, false)
  assert.equal(await f.controller.run(), false)
  assert.equal(f.states.length, count)
  assert.equal(f.calls.length, 1)
})

test('missing session and stale supplied context never invoke account restoration', async () => {
  const f = fixture()
  const old = f.context
  f.setContext({ ...old, session: { token: null, generation: 2 } })
  assert.equal(await f.controller.run(), false)
  assert.equal(await f.controller.run({ context: old }), false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.states.at(-1).status, 'idle')
})

test('session rejection does not offer reconnection to obsolete credentials', async () => {
  let f
  f = fixture(async () => {
    f.setContext({ ...f.context, session: { token: null, generation: 2 } })
    throw Object.assign(new Error('expired session'), { status: 401 })
  })
  assert.equal(await f.controller.run(), false)
  assert.equal(f.states.at(-1).status, 'idle')
})

test('expired operation authority is retryable only while the complete saved context is unchanged', async () => {
  let expired = true
  const same = fixture(async () => {
    if (expired) throw Object.assign(new Error('changed'), { code: 'AUTH_CONTEXT_CHANGED' })
    return true
  })
  assert.equal(await same.controller.run(), false)
  assert.equal(same.states.at(-1).status, 'retryable')
  expired = false
  assert.equal(await same.controller.run(), true)
  let changed
  changed = fixture(async () => {
    changed.setContext({ ...changed.context, session: { token: 'new-account', generation: 2 } })
    throw Object.assign(new Error('changed'), { code: 'AUTH_CONTEXT_CHANGED' })
  })
  assert.equal(await changed.controller.run(), false)
  assert.equal(changed.states.at(-1).status, 'idle')
})

test('synchronous recovery-state listeners cannot reenter single-flight restoration', async () => {
  let controller
  let nested
  let calls = 0
  controller = createSessionRecoveryController({
    readContext: async () => ({ server: 'https://fixture.invalid/api/v1', session: { token: 'fixture', generation: 1 } }),
    restore: async () => { calls += 1; return true },
    onStateChange: ({ status }) => { if (status === 'recovering') nested = controller.run() },
  })
  const pending = controller.run()
  assert.equal(nested, pending)
  assert.equal(await pending, true)
  assert.equal(calls, 1)
})

async function withApiFixture(run) {
  const descriptors = new Map(['window', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let context = { hasSession: true, userId: 101, petType: 'pig', relationshipId: 1013, session: { token: 'fixture-a', generation: 1 } }
  let server = 'https://fixture-a.invalid/api/v1'
  let clock = 1000
  let captures = 0
  let renewals = 0
  let requests = 0
  let clears = 0
  let fetchResponse = null
  let responseStatus = 503
  let sequence = 0
  const authority = accountBoundary.createAuthoritativeOperationContextState()
  const registry = accountBoundary.createOperationCapabilityRegistry({
    authoritativeState: authority, now: () => clock, ttlMs: 30000, createId: () => `cap-${++sequence}`,
  })
  const owner = { sender: {}, senderRole: 'main-panel', rendererInstanceNonce: 'fixture-renderer' }
  registry.registerRendererInstance(owner)
  authority.observe(context)
  const issue = (scope, semantic) => registry.issue({ ...owner, scope, currentContext: context, expectedContext: semantic })
  globalThis.window = { desktopBridge: {
    getSessionSnapshot: async () => ({ ...context.session }),
    getApiBaseUrl: async () => server,
    getPetState: async () => ({ userId: context.userId, petType: context.petType }),
    clearSessionToken: async () => { clears += 1; context.session = { token: null, generation: context.session.generation + 1 }; return true },
    captureOperationContext: async (scope, semantic) => {
      captures += 1
      return issue(scope, semantic)
    },
    renewOperationContext: async (capability, scope, semantic) => {
      renewals += 1
      return registry.renew({ ...owner, capability, requiredScope: scope, currentContext: context, expectedSemantic: semantic })
    },
    validateOperationContext: async (capability, scope, semantic) => registry.authorize({ ...owner, capability, requiredScope: scope, currentContext: context, expectedSemantic: semantic }).ok,
  } }
  globalThis.fetch = async () => {
    requests += 1
    if (fetchResponse) return fetchResponse()
    return { ok: responseStatus === 200, status: responseStatus, json: async () => responseStatus === 200 ? { id: context.userId } : { detail: 'Fixture temporary outage' } }
  }
  try {
    const api = await import(`${apiModuleUrl}#recovery-${++apiSequence}`)
    await run({
      api,
      values: () => ({ server, session: { ...context.session }, epoch: 1 }),
      advance: (ms) => { clock += ms },
      changeSession: () => {
        context = { ...context, userId: 202, session: { token: 'fixture-b', generation: 2 } }
        authority.observe(context)
      },
      changeServer: () => { server = 'https://fixture-b.invalid/api/v1' },
      changeRenderer: () => registry.registerRendererInstance({ ...owner, rendererInstanceNonce: 'replacement-renderer' }),
      transitionPetCapability: (capability) => registry.transition({
        ...owner, capability, requiredScope: 'pet', currentContext: context, nextScope: 'relationship',
        apply: () => { authority.observe(context, { forceRelationshipRevision: true }); return true },
        getCurrentContext: () => context,
      }),
      rejectRepeatedCapture: () => issue('account', context),
      succeed: () => { responseStatus = 200 },
      setFetchResponse: (callback) => { fetchResponse = callback },
      counts: () => ({ captures, renewals, requests, clears }),
    })
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

const changed = (error) => error?.code === 'AUTH_CONTEXT_CHANGED'

test('503 recovery renews the real main-process capability, including after its TTL, without capturing twice', async () => {
  await withApiFixture(async ({ api, values, advance, counts, succeed, rejectRepeatedCapture }) => {
    const saved = values()
    const states = []
    const controller = createSessionRecoveryController({
      readContext: async () => values(),
      restore: async (context) => {
        const operation = await api.captureApiOperationContext(context, 'account')
        await api.desktopApi.me(operation)
        return true
      },
      onStateChange: (state) => states.push(state),
    })
    assert.equal(await controller.run(), false)
    assert.equal(states.at(-1).status, 'retryable')
    assert.match(states.at(-1).error.message, /Fixture temporary outage/)
    assert.equal(rejectRepeatedCapture(), null, 'Fixture must preserve the real one-capture-per-renderer restriction')
    advance(60000)
    succeed()
    assert.equal(await controller.run(), true)
    assert.equal(states.at(-1).status, 'idle')
    assert.deepEqual(values(), saved)
    assert.equal(counts().captures, 1)
    assert.equal(counts().requests, 2)
    assert(counts().renewals >= 3)
  })
})

test('real API finishes rejecting late 401 before reading its body or clearing the replacement account', async () => {
  await withApiFixture(async ({ api, values, changeSession, setFetchResponse, counts }) => {
    const headers = deferred()
    const requested = deferred()
    let bodyRead = false
    setFetchResponse(() => { requested.resolve(); return headers.promise })
    const context = await api.captureApiOperationContext(values(), 'account')
    const pending = api.desktopApi.me(context)
    await requested.promise
    changeSession()
    const savedB = values()
    headers.resolve({ ok: false, status: 401, json: async () => { bodyRead = true; return { detail: 'expired old account' } } })
    await assert.rejects(pending, changed)
    assert.equal(bodyRead, false)
    assert.equal(counts().clears, 0)
    assert.deepEqual(values(), savedB)
  })
})

test('initial history retains its account authority while a parallel relationship write consumes the pet capability', async () => {
  await withApiFixture(async ({ api, values, transitionPetCapability, succeed, counts }) => {
    const pet = await api.captureApiOperationContext(values(), 'pet')
    const list = await api.captureApiOperationContext({ ...values(), authoritative: pet.authoritative }, 'account')
    assert.notEqual(list.authoritative.id, pet.authoritative.id, 'The list must own a distinct account capability')
    const transition = transitionPetCapability(pet.authoritative)
    assert.equal(transition.ok, true)
    // This is the failing CI ordering: the main process has consumed P, but the
    // renderer still holds P while the cache write's IPC reply is in flight.
    await assert.rejects(api.captureApiOperationContext({ ...values(), authoritative: pet.authoritative }, 'account'), changed)
    succeed()
    await api.assertApiOperationContextCurrent(list)
    assert.deepEqual(await api.desktopApi.getSession(44, list), { id: 101 })
    assert.equal(counts().requests, 1)
  })
})

for (const boundary of ['session', 'server']) {
  test(`retained initial-history authority still rejects a changed ${boundary}`, async () => {
    await withApiFixture(async ({ api, values, transitionPetCapability, changeSession, changeServer, counts }) => {
      const pet = await api.captureApiOperationContext(values(), 'pet')
      const list = await api.captureApiOperationContext({ ...values(), authoritative: pet.authoritative }, 'account')
      assert.equal(transitionPetCapability(pet.authoritative).ok, true)
      if (boundary === 'session') changeSession()
      else changeServer()
      await assert.rejects(api.desktopApi.getSession(44, list), changed)
      assert.equal(counts().requests, 0, 'Old account data request escaped the retained-context boundary')
    })
  })
}

test('capturing an account context binds it to the current server when the caller omits it', async () => {
  await withApiFixture(async ({ api, values, transitionPetCapability, changeServer, succeed, counts }) => {
    const { server, ...accountValues } = values()
    const pet = await api.captureApiOperationContext(accountValues, 'pet')
    const list = await api.captureApiOperationContext({ ...accountValues, authoritative: pet.authoritative }, 'account')
    assert.equal(list.server, server)
    assert.equal(transitionPetCapability(pet.authoritative).ok, true)
    const savedSession = { ...list.session }
    changeServer()
    assert.deepEqual(values().session, savedSession, 'This boundary must hold without changing the token or generation')
    succeed()
    await assert.rejects(api.assertApiOperationContextCurrent(list), changed)
    await assert.rejects(api.desktopApi.getSession(44, list), changed)
    const retainedCounts = counts()
    await assert.rejects(api.captureApiOperationContext({ ...accountValues, server, authoritative: list.authoritative }, 'account'), changed)
    assert.deepEqual(counts(), retainedCounts, 'A stale source reached the current server or capability registry')
    assert.equal(counts().requests, 0, 'A context from the previous server reached the replacement server')
  })
})

for (const boundary of ['session', 'server', 'renderer', 'explicit-capability']) {
  test(`renewed recovery cannot bypass ${boundary} authority`, async () => {
    await withApiFixture(async ({ api, values, changeSession, changeServer, changeRenderer, counts }) => {
      const original = values()
      const first = await api.captureApiOperationContext(original, 'account')
      if (boundary === 'session') changeSession()
      if (boundary === 'server') changeServer()
      if (boundary === 'renderer') changeRenderer()
      if (boundary === 'explicit-capability') original.authoritative = { id: 'forged-capability' }
      if (boundary === 'server') await assert.rejects(api.desktopApi.me(first), changed)
      else await assert.rejects(api.captureApiOperationContext(original, 'account'), changed)
      assert.equal(counts().requests, 0, 'Stale authority reached the API')
    })
  })
}
