import assert from 'node:assert/strict'
import axios from 'axios'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export async function testApiSessions(importModule) {
  const { installApiSessionBinding, matchingUiSession } = await importModule('src/lib/apiSession.js')
  const { createAdminOperations } = await importModule('src/lib/adminOperations.js')
  const sent = []
  let token = 'account-a'
  let storedToken = token
  let response = null
  const api = axios.create({
    adapter(config) {
      sent.push(config)
      const result = { status: 200, statusText: 'OK', headers: {}, config, data: { saved: true } }
      return response ? response.promise.then(() => result) : Promise.resolve(result)
    },
  })
  const register = installApiSessionBinding(api, () => storedToken)
  await assert.rejects(api.get('/auth/me'), /登录状态已改变/, 'protected requests fail closed before store registration')
  assert.equal(sent.length, 0)
  register(() => token)

  for (const changedStorage of ['account-b', null]) {
    storedToken = changedStorage
    for (const [method, url] of [
      ['put', '/users/me/preferences'], ['post', '/auth/change-password'], ['delete', '/admin/users/2'],
    ]) {
      await assert.rejects(api.request({ method, url, data: { oldAccountDraft: true } }), /登录状态已改变/)
    }
    assert.equal(sent.length, 0, 'an A screen cannot send its changes using another tab\'s session')
  }

  storedToken = token
  response = deferred()
  const inFlight = api.put('/users/me/preferences', { pet_type: 'cat' })
  assert.equal(sent.length, 1, 'the adapter starts in the original calling stack')
  token = 'account-b'
  storedToken = token
  assert.equal(sent[0].headers.get('Authorization'), 'Bearer account-a', 'a started request stays bound to its original token')
  response.resolve()
  await inFlight
  response = null

  await api.get('/auth/me', { headers: { Authorization: 'Bearer supplied-stale-token' } })
  assert.equal(sent.at(-1).headers.get('Authorization'), 'Bearer account-b', 'normal protected requests use the registered UI store token')

  token = null
  storedToken = 'account-from-another-tab'
  for (const url of [
    '/auth/login', '/auth/register', '/auth/send-verification-code',
    '/auth/forgot-password', '/auth/reset-password', '/auth/login?from=account',
    '/public/version/win-x64',
  ]) {
    await api.post(url, {}, { headers: { Authorization: 'Bearer stale-token' } })
    assert.equal(sent.at(-1).headers.has('Authorization'), false, `public request stays anonymous: ${url}`)
  }
  const publicCount = sent.length
  for (const url of ['/auth/me', '/auth/change-password', '/auth/login-admin', '/publicity']) {
    await assert.rejects(api.post(url, {}), /登录状态已改变/)
  }
  assert.equal(sent.length, publicCount, 'similarly named protected paths do not inherit the public exemption')

  // These are the same context reader and operation guard used by Account and
  // Admin. Exercise both outcomes before a delayed storage event is delivered.
  for (const form of ['preferences', 'password', 'admin']) {
    for (const transition of ['storage-only', 'store-before-render', 'account-switch', 'unmount']) {
      for (const outcome of ['success', 'error']) {
        let visible = { token: 'account-a', userId: 1 }
        let current = { ...visible }
        let stored = visible.token
        const operations = createAdminOperations(() => matchingUiSession(visible, current, stored))
        operations.mount()
        const operation = operations.beginMutation()
        assert.ok(operation)
        const reply = deferred()
        const view = { message: '', error: '', draft: 'new account draft', saving: true }
        const handleReply = (async () => {
          try {
            const result = await reply.promise
            if (!operation.isCurrent()) return
            view.message = result
            view.draft = ''
          } catch (error) {
            if (operation.isCurrent()) view.error = error.message
          } finally {
            if (operation.isCurrent()) view.saving = false
            operation.finish()
          }
        })()
        if (transition === 'storage-only') stored = 'account-b'
        if (transition === 'store-before-render') {
          current = { token: 'account-b', userId: 2 }
          stored = current.token
        }
        if (transition === 'account-switch') {
          current = { token: 'account-b', userId: 2 }
          visible = { ...current }
          stored = current.token
          operations.invalidate()
        }
        if (transition === 'unmount') operations.unmount()
        if (outcome === 'success') reply.resolve('old account success')
        else reply.reject(new Error('old account error'))
        await handleReply
        assert.deepEqual(view, { message: '', error: '', draft: 'new account draft', saving: true }, `${form}: ${transition} ${outcome}`)
        if (transition !== 'account-switch') {
          assert.equal(operations.beginMutation(), null, 'a stale or unmounted screen cannot start another mutation')
        } else {
          const next = operations.beginMutation()
          assert.ok(next, 'new account work is available after old completion')
          next.finish()
        }
        operations.unmount()
      }
    }
  }

  console.log('frontend API session tests passed (real Axios dispatch, public routes, Account/Admin late results)')
}
