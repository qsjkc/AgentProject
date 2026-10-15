import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/api.js', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  define: { 'import.meta.env': '{"DEV":false,"VITE_API_BASE_URL":""}', __DETACHYM_DEFAULT_API_BASE_URL__: '""' },
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
let moduleSequence = 0
const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function withFixture(run) {
  const descriptors = new Map(['window', 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let server = 'https://original.example/api/v1'
  const session = Object.freeze({ token: 'original-account', generation: 1 })
  const context = Object.freeze({ hasSession: true, userId: 1, petType: 'pig', session, authoritative: { id: 'pet-a' }, server })
  const calls = []
  const cleared = []
  let fetchImpl = async () => response({ id: 1 })
  let validate = async () => true
  globalThis.window = {
    desktopBridge: {
      getApiBaseUrl: async () => server,
      getSessionSnapshot: async () => session,
      renewOperationContext: async () => ({ id: 'pet-a-renewed' }),
      validateOperationContext: (...args) => validate(...args),
      clearSessionToken: async (...args) => { cleared.push(args); return true },
    },
  }
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return fetchImpl(url, options) }
  try {
    const api = await import(`${moduleUrl}#reminder-server-${++moduleSequence}`)
    await run({
      api, context, calls, cleared,
      switchServer: () => { server = 'https://new.example/api/v1' },
      setFetch: (next) => { fetchImpl = next },
      setValidate: (next) => { validate = next },
    })
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

const changedContext = (error) => error.code === 'AUTH_CONTEXT_CHANGED'

test('a reminder trigger cannot be sent to a newly selected server', async () => {
  await withFixture(async ({ api, context, switchServer, calls }) => {
    switchServer()
    await assert.rejects(api.desktopApiRequest('/reminders/1/trigger', { method: 'POST' }, context), changedContext)
    assert.equal(calls.length, 0)
  })
})

test('server changes during capability validation reject the reminder before any HTTP mutation', async () => {
  await withFixture(async ({ api, context, switchServer, setValidate, calls }) => {
    setValidate(async () => { switchServer(); return true })
    await assert.rejects(api.desktopApiRequest('/reminders/1/trigger', { method: 'POST' }, context), changedContext)
    assert.equal(calls.length, 0)
  })
})

test('a late reminder response after a server switch cannot schedule or deliver its result', async () => {
  await withFixture(async ({ api, context, switchServer, setFetch, calls }) => {
    const body = deferred()
    setFetch(async () => ({ ...response(null), json: () => body.promise }))
    const read = api.desktopApiRequest('/reminders', {}, context)
    while (!calls.length) await Promise.resolve()
    switchServer()
    body.resolve([{ id: 1 }])
    await assert.rejects(read, changedContext)
    assert.equal(calls[0].url, `${context.server}/reminders`)
  })
})

test('a stale reminder 401 from the old server does not clear the current session', async () => {
  await withFixture(async ({ api, context, switchServer, setFetch, cleared }) => {
    setFetch(async () => { switchServer(); return response({ detail: 'expired' }, 401) })
    await assert.rejects(api.desktopApiRequest('/reminders', {}, context), changedContext)
    assert.deepEqual(cleared, [])
  })
})

test('matching reminder servers keep the original URL and do not mutate frozen caller context', async () => {
  await withFixture(async ({ api, context, calls }) => {
    const caller = Object.freeze({ ...context, server: `${context.server}/` })
    assert.deepEqual(await api.desktopApiRequest('/reminders/1/trigger', { method: 'POST' }, caller), { id: 1 })
    assert.equal(calls[0].url, `${context.server}/reminders/1/trigger`)
    assert.equal(caller.authoritative.id, 'pet-a')
  })
})

test('existing requests without an explicit server retain their current behavior', async () => {
  await withFixture(async ({ api, context, switchServer, calls }) => {
    const { server: _server, ...ordinaryContext } = context
    switchServer()
    assert.deepEqual(await api.desktopApiRequest('/chat/sessions', {}, ordinaryContext), { id: 1 })
    assert.equal(calls[0].url, 'https://new.example/api/v1/chat/sessions')
  })
})
