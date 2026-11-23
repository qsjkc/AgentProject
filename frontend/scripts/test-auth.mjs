import assert from 'node:assert/strict'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export async function testAuth(importModule) {
  const { createAuthStore } = await importModule('src/stores/authState.js')
  const { getLoginDestination, shouldExpireSession } = await importModule('src/lib/auth.js')
  const user = { id: 1, username: 'first', email: 'first@example.test', status: 'active' }
  const preferences = {
    id: 10,
    user_id: 1,
    pet_type: 'pig',
    quick_chat_enabled: true,
    bubble_frequency: 120,
    created_at: '2026-11-22T00:00:00Z',
    updated_at: '2026-11-22T00:00:00Z',
  }
  const catPreferences = { ...preferences, pet_type: 'cat' }
  function setup(getMe, getPreferences = async () => preferences) {
    const values = new Map([['token', 'session-a']])
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    }
    const store = createAuthStore({ storage, getMe, getPreferences })
    return { store, storage }
  }

  const pending = deferred()
  let calls = 0
  const { store } = setup(() => { calls++; return pending.promise })
  const first = store.getState().fetchUser()
  assert.equal(store.getState().fetchUser(), first, 'bootstrap requests share one in-flight promise')
  assert.equal(calls, 1)
  pending.resolve(user)
  await first
  assert.equal(store.getState().user.preferences.pet_type, 'pig')

  const delayedPreference = deferred()
  let embeddedPreferenceCalls = 0
  const embedded = setup(
    async () => ({ ...user, preferences: catPreferences }),
    () => {
      embeddedPreferenceCalls += 1
      return delayedPreference.promise
    },
  ).store
  const embeddedRequest = embedded.getState().fetchUser()
  await Promise.resolve()
  assert.equal(embeddedPreferenceCalls, 0, 'a complete same-account profile should skip the preference request')
  assert.equal(embedded.getState().loading, false, 'the account is ready as soon as its profile loads')
  assert.equal(embedded.getState().user.preferences, catPreferences)
  await embeddedRequest

  const stale = deferred()
  let preferenceCalls = 0
  const loggedOut = setup(() => stale.promise, async () => { preferenceCalls++; return preferences }).store
  const oldRequest = loggedOut.getState().fetchUser()
  loggedOut.getState().logout()
  stale.resolve({ ...user, preferences: catPreferences })
  await oldRequest
  assert.equal(loggedOut.getState().user, null, 'a late response must not resurrect a logged-out user')
  assert.equal(preferenceCalls, 0, 'a superseded session must not request the next user preferences')

  const pendingPreferences = deferred()
  const switching = setup(async () => user, () => pendingPreferences.promise).store
  const stalePreferences = switching.getState().fetchUser()
  await Promise.resolve()
  switching.getState().setToken('session-b')
  pendingPreferences.resolve(preferences)
  await stalePreferences
  assert.equal(switching.getState().user, null)
  assert.equal(switching.getState().token, 'session-b')
  assert.equal(switching.getState().loading, true)

  const oldFailure = deferred()
  const changing = setup(() => oldFailure.promise).store
  const failedOldRequest = changing.getState().fetchUser()
  changing.getState().setToken('session-b')
  oldFailure.reject({ response: { status: 401 } })
  await failedOldRequest
  assert.equal(changing.getState().token, 'session-b', 'old unauthorized responses must not log out a new session')

  // A real storage change is visible before the receiving tab handles its
  // storage event. Exercise that gap without calling the store's setToken.
  for (const nextToken of ['session-b', null]) {
    for (const stage of ['profile', 'preferences']) {
      for (const outcome of [200, 401, 503]) {
        const profileRequest = deferred()
        const preferenceRequest = deferred()
        let profileCalls = 0
        let preferenceCalls = 0
        const switched = setup(
          () => {
            profileCalls += 1
            return profileCalls === 1 ? profileRequest.promise : Promise.resolve({ ...user, id: 2, username: 'second' })
          },
          () => {
            preferenceCalls += 1
            return profileCalls === 1 ? preferenceRequest.promise : Promise.resolve({ ...preferences, user_id: 2 })
          },
        )
        switched.store.getState().setUser(user)
        const request = switched.store.getState().fetchUser()
        if (stage === 'preferences') {
          profileRequest.resolve(user)
          await Promise.resolve()
          assert.equal(preferenceCalls, 1)
        }
        if (nextToken) switched.storage.setItem('token', nextToken)
        else switched.storage.removeItem('token')
        const response = stage === 'profile' ? profileRequest : preferenceRequest
        if (outcome === 200) response.resolve(stage === 'profile' ? user : preferences)
        else response.reject({ response: { status: outcome, data: { detail: 'old session failure' } } })
        await request
        const scenario = `${stage} ${outcome}, external token ${nextToken}`
        assert.equal(switched.storage.getItem('token'), nextToken, `preserve shared session: ${scenario}`)
        assert.equal(switched.store.getState().token, nextToken, `adopt shared session: ${scenario}`)
        assert.equal(switched.store.getState().user, null, `discard old account: ${scenario}`)
        assert.equal(switched.store.getState().error, null, `discard old error: ${scenario}`)
        assert.equal(switched.store.getState().loading, Boolean(nextToken), scenario)
        assert.equal(preferenceCalls, stage === 'preferences' ? 1 : 0, `do not continue stale bootstrap: ${scenario}`)
        await switched.store.getState().fetchUser()
        assert.equal(switched.store.getState().user?.id ?? null, nextToken ? 2 : null, `new session can bootstrap: ${scenario}`)
        assert.equal(switched.store.getState().loading, false, scenario)
      }
    }
  }

  for (const nextToken of ['session-b', null]) {
    let fetchedToken
    const beforeRequest = setup(async () => {
      fetchedToken = beforeRequest.store.getState().token
      return user
    })
    if (nextToken) beforeRequest.storage.setItem('token', nextToken)
    else beforeRequest.storage.removeItem('token')
    await beforeRequest.store.getState().fetchUser()
    assert.equal(beforeRequest.store.getState().token, nextToken, 'bootstrap first adopts a pending storage change')
    assert.equal(fetchedToken, nextToken ?? undefined, 'a removed session must not send a profile request')
  }

  let attempts = 0
  const offline = setup(async () => {
    if (++attempts === 1) throw new Error('Network Error')
    return user
  })
  await offline.store.getState().fetchUser()
  assert.equal(offline.store.getState().token, 'session-a')
  assert.equal(offline.storage.getItem('token'), 'session-a')
  assert.equal(offline.store.getState().loading, false)
  assert.equal(offline.store.getState().error, 'Network Error')
  await offline.store.getState().fetchUser()
  assert.equal(offline.store.getState().user.id, 1, 'a network failure can be retried')
  assert.equal(offline.store.getState().error, null)

  for (const reconnectBeforeFailure of [false, true]) {
    const firstProfile = deferred()
    const recoveredProfile = deferred()
    const error = { code: 'ERR_NETWORK' }
    let profileCalls = 0
    const reconnecting = setup(() => ++profileCalls === 1 ? firstProfile.promise : recoveredProfile.promise)
    const state = reconnecting.store.getState
    const failedRequest = state().fetchUser()
    const signalReconnect = () => {
      state().resumeUserSync()
      state().resumeUserSync()
    }
    if (reconnectBeforeFailure) {
      signalReconnect()
      assert.equal(profileCalls, 1, 'online does not replace an active profile request')
    }
    firstProfile.reject(error)
    await failedRequest
    if (!reconnectBeforeFailure) signalReconnect()
    assert.equal(profileCalls, 2, 'online retries a failed profile exactly once in either ordering')
    const retry = state().fetchUser()
    recoveredProfile.resolve({ ...user, preferences })
    await retry
    signalReconnect()
    assert.equal(profileCalls, 2, 'online leaves an already restored profile alone')
    assert.equal(state().user.id, user.id)
    assert.equal(state().error, null)
    assert.equal(reconnecting.storage.getItem('token'), 'session-a')
  }

  for (const outcome of ['success', 'unauthorized', 'rate-limited', 'session-switch', 'logout', 'external-session-switch', 'retry-fails']) {
    const firstProfile = deferred()
    let profileCalls = 0
    const reconnecting = setup(() => {
      profileCalls += 1
      return profileCalls === 1 ? firstProfile.promise : Promise.reject({ response: { status: 503 } })
    })
    const state = reconnecting.store.getState
    const request = state().fetchUser()
    state().resumeUserSync()
    if (outcome === 'session-switch') state().setToken('session-b')
    if (outcome === 'logout') state().logout()
    if (outcome === 'external-session-switch') reconnecting.storage.setItem('token', 'session-b')
    if (outcome === 'success') firstProfile.resolve({ ...user, preferences })
    else if (outcome === 'unauthorized') firstProfile.reject({ response: { status: 401 } })
    else if (outcome === 'rate-limited') firstProfile.reject({ response: { status: 429 } })
    else firstProfile.reject({ response: { status: 503 } })
    await request
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(profileCalls, outcome === 'retry-fails' ? 2 : 1, outcome)
    if (outcome === 'unauthorized' || outcome === 'logout') assert.equal(state().token, null, outcome)
    if (outcome.includes('session-switch')) {
      assert.equal(state().token, 'session-b', outcome)
      assert.equal(state().user, null, outcome)
    }
  }

  const invalid = setup(async () => { throw { response: { status: 401 } } })
  await invalid.store.getState().fetchUser()
  assert.equal(invalid.storage.getItem('token'), null)
  assert.equal(invalid.store.getState().token, null)

  for (const profilePreferences of [
    undefined,
    null,
    { ...catPreferences, user_id: 2 },
    { ...catPreferences, pet_type: 'unknown' },
    { ...catPreferences, quick_chat_enabled: undefined },
  ]) {
    let fallbackCalls = 0
    const fallback = setup(async () => ({ ...user, preferences: profilePreferences }), async () => {
      fallbackCalls += 1
      return preferences
    }).store
    await fallback.getState().fetchUser()
    assert.equal(fallbackCalls, 1, 'missing or invalid profile preferences need a separate request')
    assert.equal(fallback.getState().user.preferences, preferences)

    const unavailable = setup(async () => ({ ...user, preferences: profilePreferences }), async () => {
      throw { response: { status: 503 } }
    }).store
    await unavailable.getState().fetchUser()
    assert.equal(unavailable.getState().token, 'session-a')
    assert.equal(unavailable.getState().loading, false)
    assert.equal(unavailable.getState().error, null)
    assert.equal(unavailable.getState().user.preferences, null, 'skip unavailable or invalid preferences without blocking the account')
  }
  const preferenceUnauthorized = setup(async () => user, async () => { throw { response: { status: 401 } } })
  await preferenceUnauthorized.store.getState().fetchUser()
  assert.equal(preferenceUnauthorized.store.getState().token, null)

  assert.equal(shouldExpireSession(401, '/auth/me', 'Bearer session-a', 'session-a'), true)
  assert.equal(shouldExpireSession(401, '/auth/me', 'Bearer session-a', 'session-b'), false)
  assert.equal(shouldExpireSession(401, '/auth/login', 'Bearer session-a', 'session-a'), false)
  assert.equal(shouldExpireSession(401, '/auth/login', undefined, null), false)
  assert.equal(shouldExpireSession(503, '/auth/me', 'Bearer session-a', 'session-a'), false)
  assert.equal(getLoginDestination('/voice-demo?test=1#controls'), '/voice-demo?test=1#controls')
  for (const from of [undefined, '//external.test', 'https://external.test', '/\\external.test', '/login', '/register?x=1']) {
    assert.equal(getLoginDestination(from), '/account')
  }
  console.log('frontend auth regression tests passed (deduplication, logout, switching, delayed storage events, reconnect, expiration, navigation)')
}
