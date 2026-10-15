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
  const preferences = { user_id: 1, pet_type: 'pig' }
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

  const stale = deferred()
  let preferenceCalls = 0
  const loggedOut = setup(() => stale.promise, async () => { preferenceCalls++; return preferences }).store
  const oldRequest = loggedOut.getState().fetchUser()
  loggedOut.getState().logout()
  stale.resolve(user)
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

  const invalid = setup(async () => { throw { response: { status: 401 } } })
  await invalid.store.getState().fetchUser()
  assert.equal(invalid.storage.getItem('token'), null)
  assert.equal(invalid.store.getState().token, null)

  const fallback = setup(async () => ({ ...user, preferences }), async () => { throw new Error('offline') })
  await fallback.store.getState().fetchUser()
  assert.equal(fallback.store.getState().user.preferences, preferences)
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
  console.log('frontend auth regression tests passed (deduplication, logout, switching, delayed storage events, retry, expiration, navigation)')
}
