import assert from 'node:assert/strict'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
const createdSession = { sessionId: 'owned-A', appId: 'app', roomId: 'room', userId: 'user', aiUserId: 'ai', token: 'rtc-only', state: 'creating' }
const stoppedSession = { state: 'stopped', cleanupPending: false }

function fakeSdk(overrides = {}) {
  const calls = []
  const handlers = new Map()
  const events = Object.fromEntries([
    'onConnectionStateChanged', 'onUserJoined', 'onUserLeave', 'onUserPublishStream',
    'onUserUnpublishStream', 'onRemoteAudioPropertiesReport', 'onError',
  ].map((name) => [name, name]))
  const engine = {
    on: (name, callback) => handlers.set(name, callback),
    off: (name) => handlers.delete(name),
    setAudioProfile: async () => { calls.push('profile') },
    enableAudioPropertiesReport: () => { calls.push('report') },
    joinRoom: async () => { calls.push('join') },
    startAudioCapture: async () => { calls.push('capture') },
    publishStream: async () => { calls.push('publish') },
    unpublishStream: async () => { calls.push('unpublish') },
    stopAudioCapture: async () => { calls.push('stop-capture') },
    leaveRoom: async () => { calls.push('leave') },
    setCaptureVolume: () => { calls.push('capture-volume') },
    subscribeStream: async () => { calls.push('subscribe') },
    setPlaybackVolume: () => { calls.push('playback-volume') },
    getRemoteStreamTrack: () => ({ id: 'remote-track' }),
    ...overrides,
  }
  const sdk = {
    default: {
      createEngine: () => { calls.push('create'); return engine },
      destroyEngine: (target) => { assert.equal(target, engine); calls.push('destroy') },
      events,
    },
    AudioProfileType: { fluent: 0 },
    ConnectionState: { 0: 'connected' },
    MediaType: { AUDIO: 2 },
    StreamIndex: { STREAM_INDEX_MAIN: 0 },
  }
  return { sdk, engine, calls, handlers }
}

export async function testVoiceSessions(importCompiledModule) {
  const { createVoiceSessionController, isVoiceConnectionCancelled } = await importCompiledModule('src/lib/voiceSessionController.js')
  const { createVoiceSessionApi } = await importCompiledModule('src/lib/voiceSessionApi.js')
  const { createVoiceRtcSession } = await importCompiledModule('src/lib/voiceRtc.js')
  const cases = []
  const check = async (name, run) => { await run(); cases.push(name) }

  await check('replacing a connection invalidates it before cleanup and destroys once', async () => {
    const controller = createVoiceSessionController()
    const leaveGate = deferred()
    const calls = []
    const first = controller.begin(() => true)
    await first.ownRtc({ leave: () => { calls.push('leave'); return leaveGate.promise }, destroy: () => calls.push('destroy') })
    await first.ownBackend({ stop: async () => { calls.push('stop') } })
    const second = controller.begin(() => true)
    assert.equal(first.isCurrent(), false)
    assert.equal(second.isCurrent(), true)
    assert.throws(first.assertCurrent, isVoiceConnectionCancelled)
    let settled = false
    void second.previousCleanup.then(() => { settled = true })
    await tick()
    assert.equal(settled, false)
    leaveGate.resolve()
    await second.previousCleanup
    await first.cleanup()
    assert.equal(calls.filter((call) => call === 'destroy').length, 1)
    assert.equal(calls.filter((call) => call === 'stop').length, 1)
  })

  await check('RTC leave failure still destroys and stops backend', async () => {
    const controller = createVoiceSessionController()
    const attempt = controller.begin(() => true)
    const calls = []
    await attempt.ownRtc({ leave: async () => { throw new Error('leave failed') }, destroy: () => calls.push('destroy') })
    await attempt.ownBackend({ stop: async () => { calls.push('stop') } })
    await controller.cancel()
    assert.deepEqual(calls.sort(), ['destroy', 'stop'])
  })

  await check('resources returned after cancellation are closed without activation', async () => {
    const controller = createVoiceSessionController()
    const attempt = controller.begin(() => true)
    const calls = []
    await controller.cancel()
    await assert.rejects(attempt.ownBackend({ stop: async () => calls.push('stop') }), isVoiceConnectionCancelled)
    await assert.rejects(attempt.ownRtc({ leave: async () => calls.push('leave'), destroy: () => calls.push('destroy') }), isVoiceConnectionCancelled)
    assert.deepEqual(calls, ['stop', 'leave', 'destroy'])
  })

  await check('a stuck SDK leave is bounded and still destroys', async () => {
    const controller = createVoiceSessionController({ cleanupTimeoutMs: 10 })
    const attempt = controller.begin(() => true)
    let destroyed = 0
    await attempt.ownRtc({ leave: () => new Promise(() => {}), destroy: () => { destroyed += 1 } })
    await controller.cancel()
    assert.equal(destroyed, 1)
  })

  await check('late create after logout only stops its own session with original token', async () => {
    const gate = deferred()
    let current = true
    const calls = []
    const api = createVoiceSessionApi({
      baseUrl: 'https://api.example/api/v1', token: 'account-A', isCurrent: () => current,
      fetcher: async (url, options) => { calls.push({ url, options }); return url.endsWith('/stop') ? response(stoppedSession) : gate.promise },
    })
    const creating = api.create()
    current = false
    gate.resolve(response(createdSession))
    await assert.rejects(creating, isVoiceConnectionCancelled)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://api.example/api/v1/rtc/voice-demo/session/owned-A/stop')
    assert.equal(calls[1].options.headers.Authorization, 'Bearer account-A')
    assert.equal(calls[1].options.keepalive, true)
    assert.equal(calls[1].options.redirect, 'error')
  })

  await check('owned stop is deduplicated, encoded and available after account change', async () => {
    let current = true
    const gate = deferred()
    const calls = []
    const api = createVoiceSessionApi({
      baseUrl: 'https://api.example/api/v1/', token: 'account-A', isCurrent: () => current,
      fetcher: async (url, options) => { calls.push({ url, options }); return url.endsWith('/stop') ? gate.promise : response({ ...createdSession, sessionId: 'owned?A' }) },
    })
    const owned = await api.create()
    current = false
    await assert.rejects(owned.start(), isVoiceConnectionCancelled)
    await assert.rejects(owned.getStatus(), isVoiceConnectionCancelled)
    await assert.rejects(owned.interrupt(), isVoiceConnectionCancelled)
    const first = owned.stop()
    const second = owned.stop()
    assert.equal(first, second)
    gate.resolve(response(stoppedSession))
    await first
    await owned.stop()
    assert.equal(calls.length, 2)
    assert.match(calls[1].url, /owned%3FA\/stop$/)
    assert.equal(calls[1].options.headers.Authorization, 'Bearer account-A')
  })

  await check('stale 401 cannot expire a newer login and 403 does not expire current login', async () => {
    const gate = deferred()
    let current = true
    let expired = 0
    const api = createVoiceSessionApi({
      baseUrl: 'https://api.example/api/v1', token: 'account-A', isCurrent: () => current,
      onUnauthorized: () => { expired += 1 }, fetcher: () => gate.promise,
    })
    const creating = api.create()
    current = false
    gate.resolve(response({ detail: 'old unauthorized' }, 401))
    await assert.rejects(creating, /old unauthorized/)
    assert.equal(expired, 0)
    const forbidden = createVoiceSessionApi({
      baseUrl: 'https://api.example/api/v1', token: 'account-B', isCurrent: () => true,
      onUnauthorized: () => { expired += 1 }, fetcher: async () => response({ detail: 'forbidden' }, 403),
    })
    await assert.rejects(forbidden.create(), /forbidden/)
    assert.equal(expired, 0)
  })

  await check('known create response at timeout is still cleaned up', async () => {
    const calls = []
    const api = createVoiceSessionApi({
      baseUrl: 'https://api.example/api/v1', token: 'account-A', isCurrent: () => true, timeoutMs: 5,
      fetcher: async (url) => {
        calls.push(url)
        if (url.endsWith('/stop')) return response(stoppedSession)
        return { ok: true, status: 200, json: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return createdSession } }
      },
    })
    await assert.rejects(api.create(), /超时/)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /owned-A\/stop$/)
  })

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } })
  try {
    const makeConfig = (isCurrent = () => true, extra = {}) => ({
      appId: 'app', roomId: 'room', userId: 'user', aiUserId: 'ai', token: 'rtc-only', isCurrent,
      onConnectionStateChange() {}, onRoomStateChange() {}, onRemoteAudioTrack() {}, onLog() {}, onError() {}, ...extra,
    })
    for (const [blockedMethod, nextCall] of [
      ['setAudioProfile', 'join'], ['joinRoom', 'capture'], ['startAudioCapture', 'publish'], ['publishStream', null],
    ]) {
      await check(`cancel while ${blockedMethod} waits cannot continue startup`, async () => {
        const gate = deferred()
        const entered = deferred()
        let current = true
        const fake = fakeSdk({ [blockedMethod]: async () => { entered.resolve(); await gate.promise } })
        const session = await createVoiceRtcSession(makeConfig(() => current), fake.sdk)
        const joining = session.joinAndPublish()
        const rejected = assert.rejects(joining, isVoiceConnectionCancelled)
        await entered.promise
        current = false
        const leaving = session.leave()
        await tick()
        assert.ok(fake.calls.includes('stop-capture'))
        gate.resolve()
        await rejected
        await leaving
        session.destroy()
        if (nextCall) assert.equal(fake.calls.includes(nextCall), false)
        assert.equal(session.isJoined(), false)
        assert.equal(fake.calls.filter((call) => call === 'destroy').length, 1)
      })
    }

    await check('SDK is not instantiated for an already cancelled attempt', async () => {
      const fake = fakeSdk()
      await assert.rejects(createVoiceRtcSession(makeConfig(() => false), fake.sdk), isVoiceConnectionCancelled)
      assert.deepEqual(fake.calls, [])
    })

    await check('old capture settling after forced destruction cannot affect replacement engine', async () => {
      const controller = createVoiceSessionController({ cleanupTimeoutMs: 10 })
      const capture = deferred()
      const entered = deferred()
      const oldFake = fakeSdk({ startAudioCapture: async () => { entered.resolve(); await capture.promise } })
      const oldAttempt = controller.begin(() => true)
      const oldRtc = await createVoiceRtcSession(makeConfig(oldAttempt.isCurrent), oldFake.sdk)
      await oldAttempt.ownRtc(oldRtc)
      const oldJoining = oldRtc.joinAndPublish()
      const oldRejected = assert.rejects(oldJoining, isVoiceConnectionCancelled)
      await entered.promise

      const nextAttempt = controller.begin(() => true)
      await nextAttempt.previousCleanup
      assert.equal(oldFake.calls.filter((call) => call === 'destroy').length, 1)
      const nextFake = fakeSdk()
      const nextRtc = await createVoiceRtcSession(makeConfig(nextAttempt.isCurrent), nextFake.sdk)
      await nextAttempt.ownRtc(nextRtc)
      await nextRtc.joinAndPublish()
      capture.resolve()
      await oldRejected
      await tick()

      assert.equal(oldFake.calls.includes('publish'), false)
      assert.equal(nextFake.calls.includes('destroy'), false)
      assert.equal(nextRtc.isJoined(), true)
      assert.equal(nextAttempt.isCurrent(), true)
      await nextAttempt.cleanup()
    })

    await check('late remote subscription cannot attach audio after cancellation', async () => {
      const subscription = deferred()
      let current = true
      let attached = 0
      const fake = fakeSdk({ subscribeStream: () => subscription.promise })
      const session = await createVoiceRtcSession(makeConfig(() => current, { onRemoteAudioTrack: (track) => { if (track) attached += 1 } }), fake.sdk)
      await session.joinAndPublish()
      const publishing = fake.handlers.get('onUserPublishStream')({ userId: 'ai', mediaType: 2 })
      current = false
      await session.leave()
      session.destroy()
      subscription.resolve()
      await publishing
      assert.equal(attached, 0)
      assert.equal(fake.calls.includes('playback-volume'), false)
    })

    await check('listener removal failure cannot prevent engine destruction', async () => {
      const fake = fakeSdk({ off: () => { throw new Error('listener failure') } })
      const session = await createVoiceRtcSession(makeConfig(), fake.sdk)
      assert.throws(() => session.destroy(), /listener failure/)
      assert.ok(fake.calls.includes('destroy'))
      session.destroy()
      assert.equal(fake.calls.filter((call) => call === 'destroy').length, 1)
    })
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  }

  console.log(`voice session tests passed (${cases.length} lifecycle scenarios)`)
}
