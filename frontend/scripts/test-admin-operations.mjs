import assert from 'node:assert/strict'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export async function testAdminOperations(importCompiledModule) {
  const { createAdminOperations } = await importCompiledModule('src/lib/adminOperations.js')
  let session = { token: 'account-a', userId: 1 }
  const operations = createAdminOperations(() => session)
  operations.mount()

  const view = { users: [], error: '', loading: false }
  async function read(response) {
    const request = operations.beginRead()
    view.loading = true
    view.error = ''
    try {
      const users = await response
      if (request.isCurrent()) view.users = users
    } catch (error) {
      if (request.isCurrent()) view.error = error.message
    } finally {
      if (request.isCurrent()) view.loading = false
    }
  }

  // Search B wins even when search A returns after it.
  const first = deferred()
  const second = deferred()
  const firstRead = read(first.promise)
  const secondRead = read(second.promise)
  second.resolve(['B'])
  await secondRead
  first.resolve(['A'])
  await firstRead
  assert.deepEqual(view, { users: ['B'], error: '', loading: false })

  // An earlier failed refresh cannot replace the pending query or end its loading state.
  const failing = deferred()
  const pending = deferred()
  const failedRead = read(failing.promise)
  const pendingRead = read(pending.promise)
  failing.reject(new Error('old network failure'))
  await failedRead
  assert.equal(view.error, '')
  assert.equal(view.loading, true)
  pending.resolve(['C'])
  await pendingRead
  assert.deepEqual(view.users, ['C'])

  const oldRead = operations.beginRead()
  const oldMutation = operations.beginMutation()
  assert.ok(oldMutation)
  assert.equal(operations.beginMutation(), null, 'a second click cannot start another mutation')
  operations.beginRead()
  assert.equal(oldMutation.isCurrent(), true, 'searching does not cancel an accepted mutation')
  session = { token: 'account-b', userId: 2 }
  assert.equal(oldMutation.isCurrent(), false, 'a switched account cannot receive mutation results')
  assert.equal(oldRead.isCurrent(), false)

  operations.invalidate()
  const nextMutation = operations.beginMutation()
  assert.ok(nextMutation)
  oldMutation.finish()
  assert.equal(operations.beginMutation(), null, 'old cleanup cannot release the new account lock')
  nextMutation.finish()
  const afterFinish = operations.beginMutation()
  assert.ok(afterFinish)
  afterFinish.finish()

  // A → B → A must not revive requests from the original visit.
  const previousVisit = operations.beginRead()
  session = { token: 'account-a', userId: 1 }
  operations.invalidate()
  session = { token: 'account-b', userId: 2 }
  operations.invalidate()
  assert.equal(previousVisit.isCurrent(), false)

  const beforeUnmount = operations.beginRead()
  const mutationBeforeUnmount = operations.beginMutation()
  operations.unmount()
  assert.equal(beforeUnmount.isCurrent(), false)
  assert.equal(mutationBeforeUnmount.isCurrent(), false)
  assert.equal(operations.beginMutation(), null)
  operations.mount()
  assert.equal(beforeUnmount.isCurrent(), false, 'StrictMode remount cannot revive the previous request')
  assert.equal(operations.beginRead().isCurrent(), true)

  session = { token: null, userId: null }
  operations.invalidate()
  assert.equal(operations.beginRead().isCurrent(), false)
  assert.equal(operations.beginMutation(), null)
}
