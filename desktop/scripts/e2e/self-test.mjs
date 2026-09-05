import { mkdir, mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, assertEqual } from './assertions.mjs'
import { CdpClient } from './cdp-client.mjs'
import { USERS, decodeJwtSubject } from './fixtures.mjs'
import { assertSafeUserDataPath, removeSafeUserDataPath } from './run.mjs'
import { startStubServer } from './stub-server.mjs'

class FakeSocket {
  constructor() {
    this.listeners = new Map()
    this.requests = []
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(payload) {
    this.requests.push(JSON.parse(payload))
  }

  emit(type, data = undefined) {
    for (const listener of this.listeners.get(type) || []) listener({ data })
  }

  close() {
    this.emit('close')
  }
}

async function testCdpRequestMatching() {
  const socket = new FakeSocket()
  const client = new CdpClient(socket, { defaultTimeoutMs: 1_000 })
  const first = client.send('Runtime.evaluate', { expression: '1' })
  const second = client.send('DOM.getDocument')
  assertEqual(socket.requests.length, 2)
  socket.emit('message', JSON.stringify({ id: socket.requests[1].id, result: { root: { nodeId: 42 } } }))
  socket.emit('message', JSON.stringify({ id: socket.requests[0].id, result: { result: { value: 1 } } }))
  assertEqual((await first).result.value, 1, 'CDP first response matched the wrong request')
  assertEqual((await second).root.nodeId, 42, 'CDP second response matched the wrong request')
  client.close()
}

async function testStubEndpoints() {
  const stub = await startStubServer()
  try {
    const loginBody = new FormData()
    loginBody.append('username', USERS.A.username)
    loginBody.append('password', USERS.A.password)
    const loginResponse = await fetch(`${stub.apiBaseUrl}/auth/login`, { method: 'POST', body: loginBody })
    assertEqual(loginResponse.status, 200)
    const token = (await loginResponse.json()).access_token
    assertEqual(decodeJwtSubject(token), USERS.A.id, 'Stub JWT sub is not a decodable number')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const me = await fetch(`${stub.apiBaseUrl}/auth/me`, { headers }).then((response) => response.json())
    assertEqual(me.id, USERS.A.id)
    assertEqual(me.preferences.pet_type, 'pig')

    const relationship = await fetch(`${stub.apiBaseUrl}/pets/pig/relationship`, { headers }).then((response) => response.json())
    assertEqual(relationship.level, 1)
    assert(Date.now() - Date.parse(relationship.created_at) < 24 * 60 * 60 * 1000, 'P1-K relationship is older than 24 hours')

    const reminder = await fetch(`${stub.apiBaseUrl}/reminders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        pet_type: 'pig',
        title: 'self-test',
        remind_at: new Date(Date.now() + 60_000).toISOString(),
        recurrence_type: 'once',
        email_enabled: false,
      }),
    }).then((response) => response.json())
    assertEqual(reminder.user_id, USERS.A.id)
    const pending = await fetch(`${stub.apiBaseUrl}/reminders?pet_type=pig&status=pending`, { headers }).then((response) => response.json())
    assertEqual(pending.length, 1)
    const triggered = await fetch(`${stub.apiBaseUrl}/reminders/${reminder.id}/trigger`, { method: 'POST', headers }).then((response) => response.json())
    assert(Boolean(triggered.triggered_at), 'Trigger endpoint did not set triggered_at')
    const completed = await fetch(`${stub.apiBaseUrl}/reminders/${reminder.id}/complete`, { method: 'POST', headers }).then((response) => response.json())
    assertEqual(completed.status, 'completed')

    const message = await fetch(`${stub.apiBaseUrl}/chat/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'hello', pet_type: 'pig' }),
    }).then((response) => response.json())
    assertEqual(message.role, 'assistant')
    const dailyStatus = await fetch(`${stub.apiBaseUrl}/pets/pig/daily-summary`, { headers })
    const weeklyStatus = await fetch(`${stub.apiBaseUrl}/pets/pig/weekly-summary`, { headers })
    assertEqual(dailyStatus.status, 200)
    assertEqual(weeklyStatus.status, 200)
  } finally {
    await stub.close()
  }
}

async function testPathGuard() {
  const userDataPath = await mkdtemp(join(tmpdir(), 'detachym-e2e-'))
  const nestedBadPath = join(userDataPath, 'wrong-prefix')
  await mkdir(nestedBadPath)
  try {
    const guarded = await assertSafeUserDataPath(userDataPath)
    assertEqual(guarded.resolvedTarget, await import('node:fs/promises').then(({ realpath }) => realpath(userDataPath)))
    let refused = false
    try {
      await assertSafeUserDataPath(nestedBadPath)
    } catch {
      refused = true
    }
    assert(refused, 'Path guard accepted a directory without the detachym-e2e- basename prefix')
  } finally {
    await rmdir(nestedBadPath)
    await removeSafeUserDataPath(userDataPath)
  }
}

export async function selfTest() {
  const tests = [
    ['CDP request matching', testCdpRequestMatching],
    ['stub endpoints', testStubEndpoints],
    ['TEMP path guard', testPathGuard],
  ]
  const results = []
  for (const [name, test] of tests) {
    const startedAt = Date.now()
    await test()
    results.push({ name, status: 'passed', durationMs: Date.now() - startedAt })
  }
  return results
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  selfTest().then((results) => {
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`)
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}
