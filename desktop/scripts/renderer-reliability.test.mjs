import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldSubmitChatInput,
  restoreFailedChatDraft,
  isChatScrollNearBottom,
  shouldFollowChatUpdate,
} from '../src/shared/chat-input.js'
import { createReminderPanelOperations } from '../src/shared/reminder-panel-operations.js'
import {
  commitAccountOperation,
  createAccountOperationGate,
  executeSessionBoundRequest,
  runAccountOperation,
} from '../src/shared/pet-account-context.js'
import { runWithRequestDeadline } from '../src/shared/request-deadline.js'
import { formatApiErrorDetail } from '../src/shared/api-error.js'
import { getPetWeeklySummaryPeriod } from '../src/shared/pet-weekly-summary.js'

const context = { userId: 7, petType: 'pig', session: { token: 'test-token', generation: 1 } }
const deferred = () => {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}

test('Enter confirms Chinese composition without submitting a chat or reminder', () => {
  for (const event of [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', nativeEvent: { isComposing: true } },
    { key: 'Enter', keyCode: 229 },
    { key: 'Enter', nativeEvent: { keyCode: 229 } },
    { key: 'Enter', shiftKey: true },
    { key: 'Enter', repeat: true },
  ]) assert.equal(shouldSubmitChatInput(event), false)
  assert.equal(shouldSubmitChatInput({ key: 'Enter', nativeEvent: { isComposing: false } }), true)
})

test('a failed send restores an empty draft and preserves a newer draft', () => {
  assert.equal(restoreFailedChatDraft('', '明天下午提醒我喝水'), '明天下午提醒我喝水')
  assert.equal(restoreFailedChatDraft('正在写下一条', 'old message'), '正在写下一条')
})

test('new replies follow the bottom but do not pull readers away from history', () => {
  assert.equal(isChatScrollNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 690 }), true)
  assert.equal(isChatScrollNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 100 }), false)
  assert.equal(isChatScrollNearBottom({ scrollHeight: 200, clientHeight: 300, scrollTop: 0 }), true)
  assert.equal(shouldFollowChatUpdate({ following: false, previousConversation: 'history', conversation: 'history' }), false)
  assert.equal(shouldFollowChatUpdate({ following: false, previousConversation: 'history', conversation: 'new-chat' }), true)
  assert.equal(shouldFollowChatUpdate({ following: true, previousConversation: 'history', conversation: 'history' }), true)
})

test('starting a new chat prevents an older response from clearing its loading state', () => {
  const gate = createAccountOperationGate()
  const oldSend = gate.begin(context)
  gate.invalidate()
  const newSend = gate.begin(context)
  let loading = true
  commitAccountOperation(gate, oldSend, context, () => { loading = false })
  assert.equal(loading, true)
  commitAccountOperation(gate, newSend, context, () => { loading = false })
  assert.equal(loading, false)
})

test('background refresh cannot steal the loading request or its cleanup', async () => {
  const operations = createReminderPanelOperations()
  const first = operations.beginLoad(context)
  assert.equal(operations.beginLoad(context), null)
  let loading = true
  await runAccountOperation({
    gate: operations.loadGate,
    requestContext: first,
    getCurrentContext: () => context,
    operation: async () => [],
    onFinally: () => { loading = false },
  })
  operations.finishLoad(first)
  assert.equal(loading, false)
  assert.ok(operations.beginLoad(context))
})

test('late reminder refresh cannot resurrect a completed item', async () => {
  const operations = createReminderPanelOperations()
  const response = deferred()
  const load = operations.beginLoad(context)
  let rows = [{ id: 1 }]
  const pending = runAccountOperation({
    gate: operations.loadGate,
    requestContext: load,
    getCurrentContext: () => context,
    operation: () => response.promise,
    onSuccess: (items) => { rows = items },
  })
  const action = operations.beginAction(context)
  commitAccountOperation(operations.actionGate, action, context, () => { rows = [] })
  operations.finishAction(action)
  response.resolve([{ id: 1 }])
  await pending
  operations.finishLoad(load)
  assert.deepEqual(rows, [])
})

test('actions block refresh and synchronous duplicate submissions until finished', () => {
  const operations = createReminderPanelOperations()
  const action = operations.beginAction(context)
  assert.equal(operations.beginAction(context), null)
  assert.equal(operations.beginLoad(context), null)
  operations.finishAction(action)
  assert.ok(operations.beginLoad(context))
})

test('a canceled load cannot unlock a newer refresh after an action', () => {
  const operations = createReminderPanelOperations()
  const oldLoad = operations.beginLoad(context)
  const action = operations.beginAction(context)
  operations.finishAction(action)
  const newLoad = operations.beginLoad(context)
  operations.finishLoad(oldLoad)
  assert.equal(operations.beginLoad(context), null)
  operations.finishLoad(newLoad)
  assert.ok(operations.beginLoad(context))
})

test('account invalidation rejects old reminder results and releases busy state', () => {
  const operations = createReminderPanelOperations()
  const action = operations.beginAction(context)
  operations.invalidate()
  assert.equal(operations.actionGate.isCurrent(action, context), false)
  const nextContext = { ...context, userId: 8, session: { token: 'next', generation: 2 } }
  assert.ok(operations.beginLoad(nextContext))
})

test('selecting another conversation rejects a pending reply and slower earlier selection', () => {
  const gate = createAccountOperationGate()
  const reply = gate.begin(context)
  const earlierSelection = gate.begin(context)
  const latestSelection = gate.begin(context)
  let visible = 'original'
  commitAccountOperation(gate, latestSelection, context, () => { visible = 'latest selection' })
  commitAccountOperation(gate, earlierSelection, context, () => { visible = 'stale selection' })
  commitAccountOperation(gate, reply, context, () => { visible = 'old reply' })
  assert.equal(visible, 'latest selection')
})

function requestWith(response, overrides = {}) {
  return executeSessionBoundRequest({
    path: '/reminders',
    operationContext: context,
    getSessionSnapshot: async () => context.session,
    requireApiBaseUrl: async () => 'https://example.test/api',
    fetchImpl: async () => response,
    ...overrides,
  })
}

test('a renewed request validates its returned capability without mutating the caller', async () => {
  const original = Object.freeze({ ...context, authoritative: Object.freeze({ id: 'relationship-capability' }) })
  const renewed = Object.freeze({ id: 'independent-pet-capability' })
  const observed = []
  const result = await requestWith({ ok: true, status: 200, json: async () => ({ loaded: true }) }, {
    operationContext: original,
    renewOperationContext: async (current) => {
      observed.push(current.authoritative.id)
      return renewed
    },
    validateOperationContext: async (current) => current.authoritative.id === renewed.id,
  })
  assert.deepEqual(result, { loaded: true })
  assert.deepEqual(observed, ['relationship-capability', 'independent-pet-capability', 'independent-pet-capability'])
  assert.equal(original.authoritative.id, 'relationship-capability')
})

test('revoked capabilities stop a request instead of recapturing the next account', async () => {
  let fetched = false
  let validated = false
  await assert.rejects(requestWith(null, {
    operationContext: { ...context, authoritative: { id: 'revoked' } },
    renewOperationContext: async () => null,
    validateOperationContext: async () => { validated = true; return true },
    fetchImpl: async () => { fetched = true },
  }), { code: 'AUTH_CONTEXT_CHANGED' })
  assert.equal(fetched, false)
  assert.equal(validated, false)
})

test('network timeout aborts a stalled fetch and releases the caller', async () => {
  let signal
  await assert.rejects(requestWith(null, {
    timeoutMs: 10,
    fetchImpl: async (_url, options) => {
      signal = options.signal
      return new Promise(() => {})
    },
  }), { code: 'REQUEST_TIMEOUT' })
  assert.equal(signal.aborted, true)
})

test('timeout also covers a response whose headers arrive but body never finishes', async () => {
  await assert.rejects(requestWith({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}),
  }, { timeoutMs: 10 }), { code: 'REQUEST_TIMEOUT' })
})

test('a late 401 body after timeout cannot clear the current login', async () => {
  const body = deferred()
  let cleared = 0
  await assert.rejects(requestWith({
    ok: false,
    status: 401,
    json: () => body.promise,
  }, { timeoutMs: 10, clearSessionSnapshot: async () => { cleared += 1 } }), { code: 'REQUEST_TIMEOUT' })
  body.resolve({ detail: 'Expired' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(cleared, 0)
})

test('caller cancellation propagates its reason and does not start a pre-aborted request', async () => {
  const abort = new AbortController()
  const reason = new Error('view closed')
  abort.abort(reason)
  let called = false
  await assert.rejects(runWithRequestDeadline(() => { called = true }, { signal: abort.signal }), reason)
  assert.equal(called, false)
  const liveAbort = new AbortController()
  let operationSignal
  const running = runWithRequestDeadline((signal) => {
    operationSignal = signal
    liveAbort.abort(reason)
    return new Promise(() => {})
  }, { signal: liveAbort.signal })
  await assert.rejects(running, reason)
  assert.equal(operationSignal.aborted, true)
})

test('successful requests are not aborted by a leftover deadline', async () => {
  let signal
  assert.equal(await runWithRequestDeadline((value) => {
    signal = value
    return 'ok'
  }, { timeoutMs: 5 }), 'ok')
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(signal.aborted, false)
})

test('403 permissions failures preserve login while 401 expires its original snapshot', async () => {
  let cleared = 0
  const clearSessionSnapshot = async (snapshot) => {
    assert.deepEqual(snapshot, context.session)
    cleared += 1
  }
  await assert.rejects(requestWith({ ok: false, status: 403, json: async () => ({ detail: 'Admin access required' }) }, {
    clearSessionSnapshot,
  }), { status: 403, message: 'Admin access required' })
  assert.equal(cleared, 0)
  await assert.rejects(requestWith({ ok: false, status: 401, json: async () => ({ detail: 'Unauthorized' }) }, {
    clearSessionSnapshot,
  }), /登录已过期/)
  assert.equal(cleared, 1)
})

test('validation error details show useful messages instead of object coercion', () => {
  assert.equal(formatApiErrorDetail([{ msg: 'Please choose a future time' }, { msg: 'Title is required' }]),
    'Please choose a future time；Title is required')
  assert.equal(formatApiErrorDetail({ unknown: true }, 'Unable to save'), 'Unable to save')
})

test('weekly calendar dates remain on their server-defined day across timezones', () => {
  const summary = { week_start: '2025-12-29', week_end: '2026-01-04', timezone: 'Asia/Shanghai' }
  assert.equal(getPetWeeklySummaryPeriod('en', summary), 'Dec 29, 2025 – Jan 4, 2026')
  assert.equal(getPetWeeklySummaryPeriod('zh-CN', summary), '2025年12月29日 – 2026年1月4日')
  for (const value of ['2026-02-30', '2026-99-12', 'not-a-date', '2026-09-25T00:00:00Z']) {
    assert.equal(getPetWeeklySummaryPeriod('en', { week_start: value, week_end: value }), '')
  }
  assert.equal(getPetWeeklySummaryPeriod('en', { week_start: '2026-02-02', week_end: '2026-02-01' }), '')
})
