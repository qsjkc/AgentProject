import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import loginBoundary from '../electron/login-attempt.cjs'
import { createLoginOperations } from '../src/shared/login-operations.js'

const { createLoginAttemptController } = loginBoundary
const changed = (error) => error?.code === 'AUTH_CONTEXT_CHANGED'
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function mainFixture() {
  const sender = {}
  let nonce = 'renderer-a'
  let server = 'https://server-a.invalid/api/v1'
  let session = { token: null, generation: 0 }
  let sequence = 0
  const controller = createLoginAttemptController({
    readContext: () => ({ server, session }),
    readRendererNonce: () => nonce,
    createId: () => `attempt-${++sequence}`,
  })
  const owner = { sender, senderRole: 'main-panel', rendererInstanceNonce: nonce }
  return {
    controller, owner,
    get server() { return server },
    get session() { return { ...session } },
    begin: (target = server) => controller.begin({ ...owner, server: target }),
    save: (attempt, target) => controller.saveServer({ ...owner, attempt }, target, (value) => { server = value }),
    commit: (attempt, token) => controller.commitSession({ ...owner, attempt }, () => {
      session = { token, generation: session.generation + 1 }
      return { ...session }
    }),
    cancel: (attempt) => controller.cancel({ ...owner, attempt }),
    switchSession: () => { session = { token: 'fixture-account-b', generation: session.generation + 1 } },
    changeServerDirectly: () => { server = 'https://server-b.invalid/api/v1' },
    rotateRenderer: () => { nonce = 'renderer-b' },
  }
}

test('main login authority requires registered owner, verified server, and one-use intent', () => {
  const fixture = mainFixture()
  assert.equal(fixture.controller.begin({ ...fixture.owner, senderRole: 'pet', server: fixture.server }), null)
  assert.equal(fixture.controller.begin({ ...fixture.owner, rendererInstanceNonce: 'stale', server: fixture.server }), null)
  const attempt = fixture.begin()
  assert.deepEqual(attempt.session, { token: null, generation: 0 })
  assert.equal(fixture.commit(attempt, 'fixture-login'), false)
  assert.equal(fixture.save(attempt, 'https://wrong.invalid/api/v1'), false)
  assert.equal(fixture.save(attempt, fixture.server), fixture.server)
  assert.equal(fixture.controller.commitSession({ ...fixture.owner, sender: {}, attempt }, () => true), false)
  assert.deepEqual(fixture.commit(attempt, 'fixture-login'), { token: 'fixture-login', generation: 1 })
  assert.equal(fixture.commit(attempt, 'replayed'), false)
  assert.equal(fixture.commit(undefined, 'unscoped'), false)
})

for (const transition of ['session', 'server', 'renderer', 'unmount', 'logout', 'new-intent']) {
  test(`main login CAS rejects ${transition} transitions before storing a token`, () => {
    const fixture = mainFixture()
    const attempt = fixture.begin()
    fixture.save(attempt, fixture.server)
    if (transition === 'session') fixture.switchSession()
    if (transition === 'server') fixture.changeServerDirectly()
    if (transition === 'renderer') fixture.rotateRenderer()
    if (transition === 'unmount') fixture.controller.cancelOwner(fixture.owner.sender)
    if (transition === 'logout') fixture.controller.invalidate()
    if (transition === 'new-intent') fixture.begin()
    const before = fixture.session
    assert.equal(fixture.commit(attempt, 'fixture-stale-login'), false)
    assert.deepEqual(fixture.session, before)
  })
}

test('late connection probes cannot overwrite a newer saved server, including A to B to A', () => {
  const fixture = mainFixture()
  const original = fixture.server
  const first = fixture.begin()
  const second = fixture.begin('https://server-b.invalid/api/v1')
  fixture.save(second, second.server)
  assert.equal(fixture.save(first, original), false)
  assert.equal(fixture.server, second.server)
  const third = fixture.begin(original)
  fixture.save(third, original)
  assert.equal(fixture.commit(first, 'stale-even-after-server-returns'), false)
  assert.equal(fixture.commit(third, 'latest')?.token, 'latest')
})

test('login and connection testing share one synchronous lock and do not survive remount', () => {
  const canceled = []
  const operations = createLoginOperations((attempt) => canceled.push(attempt.id))
  operations.mount()
  const testing = operations.begin()
  assert.equal(operations.begin(), null, 'submitting while testing cannot start a login')
  testing.ownAttempt({ id: 'old' })
  operations.unmount()
  assert.equal(testing.signal.aborted, true)
  assert.equal(testing.isCurrent(), false)
  operations.mount()
  const login = operations.begin()
  assert.equal(operations.begin(), null, 'double submit cannot start two logins')
  testing.finish()
  assert.equal(login.isCurrent(), true, 'old finally cannot release the new operation')
  login.finish()
  const pendingCapture = operations.begin()
  operations.unmount()
  assert.throws(() => pendingCapture.ownAttempt({ id: 'late-capture' }), changed)
  assert.ok(canceled.includes('late-capture'))
})

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/api.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  define: { 'import.meta.env': '{"DEV":false,"VITE_API_BASE_URL":""}', __DETACHYM_DEFAULT_API_BASE_URL__: '""' },
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
let moduleSequence = 0

async function withApiFixture(run) {
  const descriptors = new Map(['window', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const fixture = mainFixture()
  const calls = []
  const commits = []
  const started = deferred()
  let body = async () => ({ access_token: 'fixture-login' })
  let beforeCommit = () => {}
  globalThis.window = { desktopBridge: {
    beginLoginAttempt: async (server) => fixture.begin(server),
    cancelLoginAttempt: async (attempt) => fixture.cancel(attempt),
    getApiBaseUrl: async () => fixture.server,
    getSessionSnapshot: async () => fixture.session,
    setApiBaseUrl: async (server, attempt) => fixture.save(attempt, server),
    setSessionToken: async (token, attempt) => {
      commits.push(attempt?.id)
      beforeCommit()
      return fixture.commit(attempt, token)
    },
  } }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    started.resolve()
    return { ok: true, json: () => body() }
  }
  try {
    const api = await import(`${moduleUrl}#login-${++moduleSequence}`)
    const attempt = await api.beginLoginAttempt(fixture.server)
    await api.setApiBaseUrl(attempt.server, attempt)
    await run({
      api, attempt, fixture, calls, commits, started: started.promise,
      setBody: (callback) => { body = callback },
      beforeCommit: (callback) => { beforeCommit = callback },
    })
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

test('real renderer login uses the captured server and commits a session receipt', async () => {
  await withApiFixture(async ({ api, attempt, calls, fixture }) => {
    const receipt = await api.login('fixture-user', 'fixture-password', { attempt })
    assert.deepEqual(receipt.session, fixture.session)
    assert.equal(receipt.server, attempt.server)
    assert.equal(calls[0].url, `${attempt.server}/auth/login`)
    assert.equal(calls[0].options.body.get('username'), 'fixture-user')
  })
})

for (const transition of ['session', 'server', 'intent']) {
  test(`real renderer late login body cannot cross a ${transition} change`, async () => {
    await withApiFixture(async ({ api, attempt, fixture, setBody, commits, started }) => {
      const response = deferred()
      setBody(() => response.promise)
      const pending = api.login('fixture-user', 'fixture-password', { attempt })
      await started
      if (transition === 'session') fixture.switchSession()
      if (transition === 'server') fixture.changeServerDirectly()
      if (transition === 'intent') fixture.begin()
      const expected = fixture.session
      response.resolve({ access_token: 'fixture-late-login' })
      await assert.rejects(pending, changed)
      assert.deepEqual(fixture.session, expected)
      if (transition !== 'intent') assert.equal(commits.length, 0)
    })
  })
}

test('main-process CAS closes the race after renderer validation but before token storage', async () => {
  await withApiFixture(async ({ api, attempt, fixture, beforeCommit }) => {
    beforeCommit(() => fixture.switchSession())
    await assert.rejects(api.login('fixture-user', 'fixture-password', { attempt }), changed)
    assert.equal(fixture.session.token, 'fixture-account-b')
  })
})

test('unmount aborts a pending body and late completion cannot commit', async () => {
  await withApiFixture(async ({ api, attempt, fixture, setBody, commits, started }) => {
    const response = deferred()
    setBody(() => response.promise)
    const operations = createLoginOperations(api.cancelLoginAttempt)
    operations.mount()
    const operation = operations.begin()
    operation.ownAttempt(attempt)
    const pending = api.login('fixture-user', 'fixture-password', { attempt, signal: operation.signal, isCurrent: operation.isCurrent })
    await started
    operations.unmount()
    await assert.rejects(pending, changed)
    response.resolve({ access_token: 'fixture-late-login' })
    await Promise.resolve()
    assert.deepEqual(commits, [])
    assert.equal(fixture.session.token, null)
  })
})
