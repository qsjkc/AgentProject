import assert from 'node:assert/strict'

function deferred() {
  let resolve
  const promise = new Promise((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

export async function testAuthFormOperations(importCompiledModule) {
  const { createAuthFormOperations } = await importCompiledModule('src/lib/authFormOperations.js')
  let token = null
  const pageA = createAuthFormOperations(() => token)
  const pageB = createAuthFormOperations(() => token)
  pageA.mount()
  pageB.mount()

  async function authenticate(page, response) {
    const operation = page.begin('submit')
    if (!operation) return false
    try {
      const result = await response
      if (!operation.isCurrent()) return false
      token = result
      return true
    } finally {
      operation.finish()
    }
  }

  const delayedA = deferred()
  const loginA = authenticate(pageA, delayedA.promise)
  assert.equal(pageA.begin('submit'), null, 'synchronous double submit is rejected')
  assert.equal(pageA.begin('code'), null, 'sending a code cannot overlap an accepted submit')
  assert.equal(await authenticate(pageB, Promise.resolve('B')), true)
  delayedA.resolve('A')
  assert.equal(await loginA, false)
  assert.equal(token, 'B', 'old login cannot overwrite the newer successful login')

  // A newer failed attempt still supersedes an earlier login intent.
  token = null
  const firstIntent = pageA.begin('submit')
  const secondIntent = pageB.begin('submit')
  secondIntent.finish()
  assert.equal(firstIntent.isCurrent(), false)
  firstIntent.finish()

  // Navigating away while the verification email is pending must not start a timer.
  const codeResponse = deferred()
  let cooldownStarted = false
  const code = pageA.begin('code')
  const send = codeResponse.promise.then(() => {
    if (code.isCurrent()) cooldownStarted = true
    code.finish()
  })
  pageA.unmount()
  codeResponse.resolve()
  await send
  assert.equal(cooldownStarted, false)
  assert.equal(pageA.begin('submit'), null)

  pageA.mount()
  const beforeSessionChange = pageA.begin('submit')
  token = 'other-tab'
  assert.equal(beforeSessionChange.isCurrent(), false)
  pageA.invalidate()
  token = null
  assert.equal(beforeSessionChange.isCurrent(), false, 'logout does not revive a previous null-token attempt')
  const afterSessionChange = pageA.begin('submit')
  beforeSessionChange.finish()
  assert.equal(pageA.begin('submit'), null, 'old cleanup cannot unlock the newer operation')
  assert.equal(afterSessionChange.isCurrent(), true)
  pageA.unmount()
  pageA.mount()
  assert.equal(afterSessionChange.isCurrent(), false, 'StrictMode remount does not revive old work')
  afterSessionChange.finish()
  assert.ok(pageA.begin('code'))
  pageA.unmount()
  pageB.unmount()
  console.log('frontend auth form regression tests passed (late login, intent, mutex, unmount, verification timer)')
}
