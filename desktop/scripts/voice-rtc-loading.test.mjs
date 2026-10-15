import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

import { createVoiceSdkLoader, VOICE_START_CANCELLED } from '../src/shared/voice-sdk-loader.js'

// Bundle the real manager in memory. Only its HTTP boundary is replaced; no SDK,
// browser, backend, microphone, or temporary files are needed by these regressions.
const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/voice-rtc.js', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  external: ['@volcengine/rtc'],
  plugins: [{
    name: 'voice-api-fixture',
    setup(builder) {
      builder.onResolve({ filter: /\/voice-api$/ }, () => ({ path: 'voice-api', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: ['createVoiceDemoSession', 'getVoiceDemoSession', 'interruptVoiceDemoSession', 'startVoiceDemoSession', 'stopVoiceDemoSession']
          .map((name) => `export const ${name} = (...args) => globalThis.__voiceRtcTestApi.${name}(...args)`)
          .join('\n'),
        loader: 'js',
      }))
    },
  }],
})
const managerModuleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
let moduleId = 0
const restoreFixtureGlobals = []

afterEach(() => {
  // This also runs if fixture initialization or any assertion throws before dispose.
  while (restoreFixtureGlobals.length) restoreFixtureGlobals.pop()()
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flushUntil(predicate) {
  for (let attempt = 0; attempt < 80 && !predicate(); attempt += 1) await Promise.resolve()
  assert.ok(predicate(), 'expected asynchronous stage was reached')
}

async function fixture({ importSdk, creating, starting, context } = {}) {
  const originalGlobals = new Map(
    ['window', 'document', 'navigator', 'HTMLAudioElement', '__voiceRtcTestApi']
      .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  )
  restoreFixtureGlobals.push(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  const calls = { imports: 0, create: [], start: [], stop: [], engines: [], destroyed: [], errors: [], events: [], capture: 0, publish: 0 }
  const timers = new Map()
  const timerDurations = new Map()
  let timerId = 0
  class FakeAudio {
    style = {}
    pause() {}
    remove() {}
    async play() {}
  }
  globalThis.HTMLAudioElement = FakeAudio
  globalThis.window = {
    setTimeout: (callback, duration) => {
      const id = ++timerId
      timers.set(id, callback)
      timerDurations.set(id, duration)
      return id
    },
    clearTimeout: (id) => { timers.delete(id); timerDurations.delete(id) },
  }
  globalThis.document = { getElementById: () => null, createElement: () => new FakeAudio(), body: { appendChild() {} } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } } })
  const sdk = {
    AudioProfileType: { fluent: 'fluent' },
    MediaType: { AUDIO: 1 },
    StreamIndex: { STREAM_INDEX_MAIN: 0 },
    default: {
      events: new Proxy({}, { get: (_target, key) => key }),
      isSupported: async () => true,
      createEngine: () => {
        const engine = {
          calls: { capture: 0, publish: 0, stopCapture: 0, unpublish: 0, volumes: [] },
          on() {}, off() {}, setCaptureVolume(_index, volume) { this.calls.volumes.push(volume) }, setPlaybackVolume() {}, stopSubtitle() {},
          async setAudioProfile() {}, async joinRoom() {}, async leaveRoom() {},
          async startAudioCapture() { calls.capture += 1; this.calls.capture += 1 },
          async stopAudioCapture() { this.calls.stopCapture += 1 },
          async publishStream() { calls.publish += 1; this.calls.publish += 1 },
          async unpublishStream() { this.calls.unpublish += 1 },
        }
        calls.engines.push(engine)
        return engine
      },
      destroyEngine: (engine) => calls.destroyed.push(engine),
    },
  }
  const session = { sessionId: 'voice-1', appId: 'fixture', roomId: 'room', userId: 'user', aiUserId: 'ai', token: 'rtc-token' }
  globalThis.__voiceRtcTestApi = {
    createVoiceDemoSession: async (...args) => { calls.create.push(args); return creating ? creating.promise : session },
    startVoiceDemoSession: async (...args) => { calls.start.push(args); return starting ? starting.promise : { state: 'active' } },
    getVoiceDemoSession: async () => ({ state: 'active', sessionActive: true }),
    stopVoiceDemoSession: async (...args) => { calls.stop.push(args); return {} },
    interruptVoiceDemoSession: async () => ({}),
  }
  let currentContext = context || { authoritative: true, session: { token: 'account-a', generation: 1 } }
  const loadSdk = createVoiceSdkLoader(async () => {
    calls.imports += 1
    return importSdk ? importSdk(sdk, calls.imports) : sdk
  })
  const { createDesktopVoiceSession } = await import(`${managerModuleUrl}#fixture-${++moduleId}`)
  const manager = createDesktopVoiceSession({
    loadSdk,
    getPetType: () => 'pig',
    getOperationContext: async () => currentContext,
    onError: (error) => calls.errors.push(error),
    onEvent: (event, details) => calls.events.push({ event, details }),
  })
  return {
    manager, calls, sdk, session, timers,
    setContext: (value) => { currentContext = value },
    hasTimer: (duration) => [...timerDurations.values()].includes(duration),
    runTimer(duration) {
      const match = [...timerDurations.entries()].find(([, value]) => value === duration)
      assert.ok(match, `expected a ${duration}ms timer`)
      const [id] = match
      const callback = timers.get(id)
      timers.delete(id)
      timerDurations.delete(id)
      callback()
    },
    async dispose() { await manager.shutdownVoiceSession(); manager.destroy() },
  }
}

test('RTC stays unloaded for idle/settings/cleanup and concurrent voice entry loads once', async () => {
  const loading = deferred()
  const f = await fixture({ importSdk: () => loading.promise })
  f.manager.updateSettings({ desktop_voice_output_mode: 'text_only' })
  await f.manager.shutdownVoiceSession({ reason: 'idle' })
  assert.equal(f.calls.imports, 0)
  const first = f.manager.enterVoiceMode()
  const second = f.manager.enterVoiceMode()
  await flushUntil(() => f.calls.imports === 1)
  assert.equal(f.calls.create.length, 0)
  loading.resolve(f.sdk)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(a.outputMode, 'text_only')
  assert.equal(f.calls.create.length, 1)
  assert.equal(f.calls.engines.length, 1)
  assert.equal(f.calls.capture, 0, 'entering voice mode does not start push-to-talk capture')
  await f.manager.startPressToTalk()
  assert.equal(f.calls.capture, 1)
  assert.equal(f.calls.publish, 1)
  await f.dispose()
})

test('a failed SDK import can be retried without recreating the voice manager', async () => {
  const f = await fixture({ importSdk: (sdk, attempt) => attempt === 1 ? Promise.reject(new Error('chunk unavailable')) : sdk })
  await assert.rejects(f.manager.enterVoiceMode(), /chunk unavailable/)
  assert.equal(f.calls.create.length, 0)
  assert.equal((await f.manager.enterVoiceMode()).sessionId, 'voice-1')
  assert.equal(f.calls.imports, 2)
  await f.dispose()
})

for (const reason of ['escape', 'signed-out', 'component-unmount']) {
  test(`pending SDK startup is cancelled by ${reason} without creating a session or reporting an error`, async () => {
    const loading = deferred()
    const f = await fixture({ importSdk: () => loading.promise })
    const pending = f.manager.enterVoiceMode()
    const cancelled = assert.rejects(pending, { code: VOICE_START_CANCELLED })
    await flushUntil(() => f.calls.imports === 1)
    await f.manager.shutdownVoiceSession({ reason })
    if (reason === 'component-unmount') f.manager.destroy()
    await cancelled
    loading.resolve(f.sdk)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(f.calls.create.length, 0)
    assert.equal(f.calls.engines.length, 0)
    assert.equal(f.calls.errors.length, 0)
    if (reason === 'component-unmount') {
      await assert.rejects(f.manager.enterVoiceMode(), { code: VOICE_START_CANCELLED })
    } else {
      assert.equal((await f.manager.enterVoiceMode()).sessionId, 'voice-1')
      assert.equal(f.calls.imports, 1, 'a fresh startup can reuse the settled SDK module')
    }
    await f.dispose()
  })
}

test('a fresh startup can share an unfinished SDK load after the old startup is cancelled', async () => {
  const loading = deferred()
  const f = await fixture({ importSdk: () => loading.promise })
  const oldRequest = f.manager.enterVoiceMode()
  const cancelled = assert.rejects(oldRequest, { code: VOICE_START_CANCELLED })
  await flushUntil(() => f.calls.imports === 1)
  await f.manager.shutdownVoiceSession({ reason: 'escape' })
  await cancelled
  const nextRequest = f.manager.enterVoiceMode()
  loading.resolve(f.sdk)
  await nextRequest
  assert.equal(f.calls.imports, 1)
  assert.equal(f.calls.create.length, 1)
  await f.dispose()
})

test('startup captures the original account before SDK loading and preserves it for create/start/stop', async () => {
  const loading = deferred()
  const contextA = { authoritative: true, session: { token: 'a', generation: 1 } }
  const f = await fixture({ importSdk: () => loading.promise, context: contextA })
  const request = f.manager.enterVoiceMode()
  await flushUntil(() => f.calls.imports === 1)
  f.setContext({ authoritative: true, session: { token: 'b', generation: 2 } })
  loading.resolve(f.sdk)
  await request
  assert.equal(f.calls.create[0][1], contextA)
  assert.equal(f.calls.start[0][1], contextA)
  await f.dispose()
  assert.equal(f.calls.stop[0][1], contextA)
})

test('a server session created after cancellation is cleaned with its original account', async () => {
  const creating = deferred()
  const contextA = { authoritative: true, session: { token: 'a', generation: 1 } }
  const f = await fixture({ creating, context: contextA })
  const request = f.manager.enterVoiceMode()
  const cancelled = assert.rejects(request, { code: VOICE_START_CANCELLED })
  await flushUntil(() => f.calls.create.length === 1)
  await f.manager.shutdownVoiceSession({ reason: 'signed-out' })
  f.setContext({ authoritative: true, session: { token: 'b', generation: 2 } })
  await cancelled
  creating.resolve(f.session)
  await flushUntil(() => f.calls.stop.length === 1)
  assert.equal(f.calls.stop[0][0], 'voice-1')
  assert.equal(f.calls.stop[0][1], contextA)
  assert.equal(f.calls.engines.length, 0)
  assert.equal(f.calls.errors.length, 0)
  await f.dispose()
})

test('cancelling while the server starts prevents readiness and destroys the partial engine', async () => {
  const starting = deferred()
  const f = await fixture({ starting })
  const request = f.manager.enterVoiceMode()
  const cancelled = assert.rejects(request, { code: VOICE_START_CANCELLED })
  await flushUntil(() => f.calls.start.length === 1)
  await f.manager.shutdownVoiceSession({ reason: 'escape' })
  await cancelled
  starting.resolve({ state: 'active' })
  assert.equal(f.calls.destroyed.length, 1)
  assert.equal(f.calls.errors.length, 0)
  assert.equal(f.timers.size, 0)
  await f.dispose()
})

test('releasing push-to-talk while READY status is pending never starts capture or publication', async () => {
  const f = await fixture()
  await f.manager.enterVoiceMode()
  const status = deferred()
  let checkedStatus = false
  globalThis.__voiceRtcTestApi.getVoiceDemoSession = () => {
    checkedStatus = true
    return status.promise
  }
  const pressing = f.manager.startPressToTalk()
  await flushUntil(() => checkedStatus)
  assert.deepEqual(await f.manager.stopPressToTalk(), { accepted: true, hadAudio: false })
  status.resolve({ state: 'active', sessionActive: true })
  assert.equal((await pressing).accepted, false)
  assert.equal(f.calls.capture, 0)
  assert.equal(f.calls.publish, 0)
  assert.ok(!f.calls.engines[0].calls.volumes.includes(100))
  assert.ok(!f.calls.events.some(({ event }) => event === 'voice:key-down'))
  await f.dispose()
})

test('releasing during capture startup stops the original microphone without publishing it', async () => {
  const f = await fixture()
  await f.manager.enterVoiceMode()
  const target = f.calls.engines[0]
  const captured = deferred()
  const originalCapture = target.startAudioCapture
  target.startAudioCapture = async function () {
    await originalCapture.call(this)
    await captured.promise
  }
  const pressing = f.manager.startPressToTalk()
  await flushUntil(() => target.calls.capture === 1)
  const releasing = f.manager.stopPressToTalk()
  captured.resolve()
  assert.equal((await pressing).accepted, false)
  assert.deepEqual(await releasing, { accepted: true, hadAudio: false })
  assert.equal(target.calls.publish, 0)
  assert.equal(target.calls.stopCapture, 1)
  assert.ok(!target.calls.volumes.includes(100))
  await f.dispose()
})

for (const heldOperation of ['startAudioCapture', 'publishStream']) {
  test(`a late ${heldOperation} after shutdown cannot touch the replacement session`, async () => {
    const f = await fixture()
    await f.manager.enterVoiceMode()
    const previousEngine = f.calls.engines[0]
    const pendingOperation = deferred()
    const originalOperation = previousEngine[heldOperation]
    let operationStarted = false
    previousEngine[heldOperation] = async function () {
      await originalOperation.call(this)
      operationStarted = true
      await pendingOperation.promise
    }
    const previousPress = f.manager.startPressToTalk()
    await flushUntil(() => operationStarted)
    await f.manager.shutdownVoiceSession({ reason: 'escape' })
    await f.manager.enterVoiceMode()
    assert.equal((await f.manager.startPressToTalk()).accepted, true)
    const replacementEngine = f.calls.engines[1]
    const replacementCalls = structuredClone(replacementEngine.calls)
    const eventCount = f.calls.events.length
    pendingOperation.resolve()
    assert.equal((await previousPress).accepted, false)
    assert.deepEqual(replacementEngine.calls, replacementCalls)
    assert.equal(replacementEngine.calls.capture, 1)
    assert.equal(replacementEngine.calls.publish, 1)
    assert.equal(f.calls.events.length, eventCount, 'a stale turn emits no events for the current session')
    assert.equal(previousEngine.calls.publish, heldOperation === 'publishStream' ? 1 : 0)
    assert.ok(previousEngine.calls.stopCapture >= 1)
    await f.dispose()
  })
}

test('the delayed key-up drain remains attached to its original RTC engine after reconnecting', async () => {
  const f = await fixture()
  await f.manager.enterVoiceMode()
  assert.equal((await f.manager.startPressToTalk()).accepted, true)
  const releasing = f.manager.stopPressToTalk()
  await flushUntil(() => f.hasTimer(220))
  await f.manager.shutdownVoiceSession({ reason: 'escape' })
  await f.manager.enterVoiceMode()
  assert.equal((await f.manager.startPressToTalk()).accepted, true)
  const replacementEngine = f.calls.engines[1]
  const replacementCalls = structuredClone(replacementEngine.calls)
  const eventCount = f.calls.events.length
  f.runTimer(220)
  assert.deepEqual(await releasing, { accepted: true, hadAudio: true })
  assert.deepEqual(replacementEngine.calls, replacementCalls)
  assert.equal(replacementEngine.calls.volumes.at(-1), 100)
  assert.equal(f.calls.events.length, eventCount)
  await f.dispose()
})

test('a new press on the same engine waits for the previous drain before opening its microphone', async () => {
  const f = await fixture()
  await f.manager.enterVoiceMode()
  const target = f.calls.engines[0]
  assert.equal((await f.manager.startPressToTalk()).accepted, true)
  const releasing = f.manager.stopPressToTalk()
  await flushUntil(() => f.hasTimer(220))
  const pressingAgain = f.manager.startPressToTalk()
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal(target.calls.capture, 1, 'the new turn cannot reuse audio awaiting a previous stop')
  f.runTimer(220)
  assert.equal((await releasing).accepted, true)
  assert.equal((await pressingAgain).accepted, true)
  assert.equal(target.calls.capture, 2)
  assert.equal(target.calls.publish, 2)
  assert.equal(target.calls.stopCapture, 1)
  assert.equal(target.calls.unpublish, 1)
  assert.equal(target.calls.volumes.at(-1), 100)
  await f.dispose()
})

test('a new press waits for a cancelled capture to settle and clean up on the same engine', async () => {
  const f = await fixture()
  await f.manager.enterVoiceMode()
  const target = f.calls.engines[0]
  const firstCapture = deferred()
  const originalCapture = target.startAudioCapture
  target.startAudioCapture = async function () {
    await originalCapture.call(this)
    if (this.calls.capture === 1) await firstCapture.promise
  }
  const firstPress = f.manager.startPressToTalk()
  await flushUntil(() => target.calls.capture === 1)
  const firstRelease = f.manager.stopPressToTalk()
  const nextPress = f.manager.startPressToTalk()
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal(target.calls.capture, 1)
  assert.equal(target.calls.publish, 0)
  firstCapture.resolve()
  assert.equal((await firstPress).accepted, false)
  assert.equal((await firstRelease).accepted, true)
  assert.equal((await nextPress).accepted, true)
  assert.equal(target.calls.capture, 2)
  assert.equal(target.calls.publish, 1)
  assert.equal(target.calls.stopCapture, 1)
  assert.equal(target.calls.volumes.at(-1), 100)
  await f.dispose()
})

test('a rejected capture releases attempted microphone resources and permits retry', async () => {
  const f = await fixture()
  await f.manager.enterVoiceMode()
  const target = f.calls.engines[0]
  const originalCapture = target.startAudioCapture
  target.startAudioCapture = async function () {
    await originalCapture.call(this)
    if (this.calls.capture === 1) throw new Error('capture failed')
  }
  await assert.rejects(f.manager.startPressToTalk(), /capture failed/)
  assert.equal(target.calls.stopCapture, 1)
  assert.equal(target.calls.publish, 0)
  assert.equal((await f.manager.startPressToTalk()).accepted, true)
  assert.equal(target.calls.capture, 2)
  assert.equal(target.calls.publish, 1)
  await f.dispose()
})
