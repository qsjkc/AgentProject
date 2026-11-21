import assert from 'node:assert/strict'
import { test } from 'node:test'
import reminderWakeup from '../electron/reminder-wakeup.cjs'
import {
  createReminderDeliveryController,
  createReminderPollController,
  getReminderPollPlan,
  isTransientReminderReadError,
  REMINDER_BACKLOG_DELAY_MS,
  REMINDER_RECONCILE_MS,
} from '../src/shared/reminder-poll.js'

const { createReminderWakeupController } = reminderWakeup
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function clockHarness() {
  let clock = 1_000_000
  let contextKey = 'server-a:user-a:pig:1'
  let owner = { id: 1 }
  let sequence = 0
  const timers = new Map()
  const events = []
  const controller = createReminderWakeupController({
    now: () => clock,
    getContextKey: () => contextKey,
    isOwnerCurrent: (candidate) => candidate === owner,
    onWake: (sender) => events.push({ sender, at: clock }),
    setTimer: (callback, delay) => {
      const id = ++sequence
      timers.set(id, { callback, at: clock + delay })
      return id
    },
    clearTimer: (id) => timers.delete(id),
  })
  return {
    controller, timers, events,
    now: () => clock,
    owner: () => owner,
    setContext: (next) => { contextKey = next },
    setOwner: (next) => { owner = next },
    advance: (delta, fire = true) => {
      clock += delta
      if (!fire) return
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

test('the main-process reminder clock wakes at the known deadline and keeps a 30s fallback', () => {
  const h = clockHarness()
  assert.equal(h.controller.schedule(h.owner(), h.now() + 1250, 1), true)
  h.advance(1249)
  assert.equal(h.events.length, 0)
  h.advance(1)
  assert.equal(h.events.length, 1)
  assert.equal([...h.timers.values()][0].at, h.now() + REMINDER_RECONCILE_MS)
  h.advance(REMINDER_RECONCILE_MS)
  assert.equal(h.events.length, 2)
})

test('a far-future deadline is bounded by the external-change reconciliation interval', () => {
  const h = clockHarness()
  h.controller.schedule(h.owner(), h.now() + 86_400_000, 1)
  h.advance(REMINDER_RECONCILE_MS)
  assert.equal(h.events.length, 1)
})

test('late scheduling replies cannot replace a newer reminder deadline', () => {
  const h = clockHarness()
  h.controller.schedule(h.owner(), h.now() + 1000, 2)
  assert.equal(h.controller.schedule(h.owner(), h.now() + 30_000, 1), false)
  assert.equal(h.controller.schedule(h.owner(), h.now() + 30_000, 2), false)
  h.advance(1000)
  assert.equal(h.events.length, 1)
})

test('account, pet, server, logout and session changes revoke a previously armed reminder clock', () => {
  for (const key of ['server-b:user-a:pig:1', 'server-a:user-b:pig:2', 'server-a:user-a:cat:1', 'server-a:user-a:pig:2', null]) {
    const h = clockHarness()
    h.controller.schedule(h.owner(), h.now() + 10, 1)
    const staleCallback = [...h.timers.values()][0].callback
    h.setContext(key)
    h.controller.syncContext()
    staleCallback()
    h.advance(100)
    assert.equal(h.events.length, 0)
    assert.equal(h.timers.size, 0)
  }
})

test('window destruction and renderer reload cancel timers, including already queued callbacks', () => {
  const h = clockHarness()
  h.controller.schedule(h.owner(), h.now() + 10, 10)
  const staleCallback = [...h.timers.values()][0].callback
  h.controller.cancelOwner(h.owner())
  staleCallback()
  assert.equal(h.events.length, 0)
  assert.equal(h.controller.schedule(h.owner(), h.now() + 10, 1), true)
  h.setOwner(null)
  h.advance(10)
  assert.equal(h.events.length, 0)
  assert.equal(h.timers.size, 0)
})

test('resume performs one immediate check after sleep without replaying stale timer ticks', () => {
  const h = clockHarness()
  h.controller.schedule(h.owner(), h.now() + 1000, 1)
  const staleCallback = [...h.timers.values()][0].callback
  h.advance(60_000, false)
  assert.equal(h.controller.wake(), true)
  staleCallback()
  assert.equal(h.events.length, 1)
  assert.equal(h.timers.size, 1)
})

test('invalid scheduling inputs and unknown owners cannot arm a reminder clock', () => {
  const h = clockHarness()
  for (const at of [NaN, Infinity, 'soon', null]) assert.equal(h.controller.schedule(h.owner(), at, 1), false)
  for (const sequence of [0, -1, NaN, 1.2, '1']) assert.equal(h.controller.schedule(h.owner(), h.now(), sequence), false)
  assert.equal(h.controller.schedule({}, h.now(), 1), false)
  h.controller.dispose()
  assert.equal(h.controller.schedule(h.owner(), h.now(), 1), false)
  assert.equal(h.timers.size, 0)
})

const row = (id, at, extra = {}) => ({ id, remind_at: new Date(at).toISOString(), status: 'pending', triggered_at: null, ...extra })

function receiptProfile() {
  let saved = null
  const storage = {
    getItem: () => saved,
    setItem: (_key, value) => { saved = value },
  }
  return {
    open: () => createReminderDeliveryController({ getStorage: () => storage, now: () => 1_000_000 }),
    receipts: () => JSON.parse(saved || '[]'),
  }
}

const reminderContext = { server: 'https://reminders.example/api/v1', userId: 1, petType: 'pig' }
const dueReminder = row(17, 999_900, { user_id: 1, pet_type: 'pig' })

test('a failed trigger acknowledgment retries after renderer reload without replaying either channel', async () => {
  const profile = receiptProfile()
  let presentations = 0
  let acknowledgements = 0
  const attempt = {
    context: reminderContext,
    reminder: dueReminder,
    present: (remember) => { presentations++; remember() },
    acknowledge: () => {
      if (++acknowledgements === 1) throw new Error('503 before trigger commit')
      return true
    },
  }
  await assert.rejects(profile.open().deliver(attempt), /503/)
  assert.equal(profile.receipts().length, 1)
  assert.deepEqual(await profile.open().deliver(attempt), { nextAt: 1_000_000 + REMINDER_BACKLOG_DELAY_MS })
  assert.equal(presentations, 1)
  assert.equal(acknowledgements, 2)
  assert.deepEqual(profile.receipts(), [])
})

test('an unavailable presentation channel does not consume an unseen reminder', async () => {
  const profile = receiptProfile()
  const controller = profile.open()
  let acknowledgements = 0
  const attempt = {
    context: reminderContext,
    reminder: dueReminder,
    present: () => {},
    acknowledge: () => { acknowledgements++; return true },
  }
  assert.deepEqual(await controller.deliver(attempt), { retry: true })
  assert.equal(acknowledgements, 0)
  assert.deepEqual(profile.receipts(), [])

  // A visible pet can record its bubble even when the native channel is muted.
  await controller.deliver({ ...attempt, present: (remember) => remember() })
  assert.equal(acknowledgements, 1)
})

test('a rejected native notification IPC cannot replay an already displayed bubble', async () => {
  const profile = receiptProfile()
  const controller = profile.open()
  let bubbles = 0
  let acknowledgements = 0
  const attempt = {
    context: reminderContext,
    reminder: dueReminder,
    present: (remember) => {
      bubbles++
      remember()
      throw new Error('native notification IPC disconnected')
    },
    acknowledge: () => { acknowledgements++; return true },
  }
  await assert.rejects(controller.deliver(attempt), /IPC disconnected/)
  await controller.deliver(attempt)
  assert.equal(bubbles, 1)
  assert.equal(acknowledgements, 1)
})

test('delivery receipts respect the exact scope and deadline and reconcile only covered occurrences', async () => {
  const profile = receiptProfile()
  const controller = profile.open()
  let presentations = 0
  const attempt = {
    context: reminderContext,
    reminder: dueReminder,
    present: (remember) => { presentations++; remember() },
    acknowledge: () => false,
  }
  await controller.deliver(attempt)
  await controller.deliver(attempt)
  await controller.deliver({ ...attempt, context: { ...reminderContext, server: 'https://other.example/api/v1' } })
  await controller.deliver({
    ...attempt,
    context: { ...reminderContext, userId: 2 },
    reminder: { ...dueReminder, user_id: 2 },
  })
  await controller.deliver({
    ...attempt,
    context: { ...reminderContext, petType: 'dog' },
    reminder: { ...dueReminder, pet_type: 'dog' },
  })
  const movedReminder = { ...dueReminder, remind_at: dueReminder.remind_at.replace('.900Z', '.900001Z') }
  assert.equal(Date.parse(movedReminder.remind_at), Date.parse(dueReminder.remind_at))
  await controller.deliver({ ...attempt, reminder: movedReminder })
  assert.equal(presentations, 5)
  controller.reconcile(reminderContext, [dueReminder], 1_000_000)
  assert.equal(profile.receipts().length, 4)
  controller.reconcile(reminderContext, [], 999_800)
  assert.equal(profile.receipts().length, 4)
  controller.reconcile(reminderContext, [], 1_000_000)
  assert.equal(profile.receipts().length, 3)
})

test('future reminders only set a deadline and completed, canceled, delivered or invalid rows never deliver', () => {
  const now = 1_000_000
  const plan = getReminderPollPlan([
    row(1, now - 1000, { status: 'completed' }),
    row(2, now - 1000, { status: 'canceled' }),
    row(3, now - 1000, { triggered_at: new Date(now).toISOString() }),
    row(4, now, { remind_at: 'invalid' }),
    row(5, now + 4000),
  ], now)
  assert.equal(plan.reminder, null)
  assert.equal(plan.nextAt, now + 4000)
  assert.equal(getReminderPollPlan([], now).nextAt, now + REMINDER_RECONCILE_MS)
})

test('overdue reminders are ordered by deadline and ID, including exact-deadline delivery', () => {
  const now = 1_000_000
  assert.equal(getReminderPollPlan([row(3, now + 1), row(2, now), row(1, now)], now).reminder.id, 1)
  assert.equal(getReminderPollPlan([row(3, now), row(2, now - 1)], now).reminder.id, 2)
})

test('creation and wakeup during an in-flight reminder read merge into one fresh read', async () => {
  const first = deferred()
  const schedules = []
  let reads = 0
  const controller = createReminderPollController({
    poll: async () => { reads += 1; if (reads === 1) await first.promise; return { nextAt: reads } },
    schedule: async (at) => schedules.push(at),
  })
  const waiting = controller.request()
  assert.equal(controller.request(), waiting)
  assert.equal(controller.request(), waiting)
  // The request starts in a microtask; trigger the invalidation during its read.
  await Promise.resolve()
  controller.request()
  first.resolve()
  await waiting
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [2])
})

test('a change arriving while re-arming also causes a fresh reminder read', async () => {
  const arming = deferred()
  let reads = 0
  let schedules = 0
  const controller = createReminderPollController({
    poll: async () => { reads += 1; return {} },
    schedule: async () => { schedules += 1; if (schedules === 1) await arming.promise },
  })
  const waiting = controller.request()
  while (!schedules) await Promise.resolve()
  controller.request()
  arming.resolve()
  await waiting
  assert.equal(reads, 2)
  assert.equal(schedules, 2)
})

test('successful reminder delivery drains backlog promptly without another 30s wait', async () => {
  let now = 1000
  const schedules = []
  let reads = 0
  const controller = createReminderPollController({
    now: () => now,
    poll: async () => { reads += 1; return { nextAt: now + REMINDER_BACKLOG_DELAY_MS } },
    schedule: async (at) => schedules.push(at),
  })
  await controller.request()
  now = schedules[0]
  await controller.request()
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [1250, 1500])
})

for (const failure of ['muted', 'acknowledgment']) {
  test(`${failure} reminder delivery keeps its cooldown through reconnect`, async () => {
    let now = 1000
    let reads = 0
    const read = deferred()
    const schedules = []
    const controller = createReminderPollController({
      now: () => now,
      poll: async () => {
        reads += 1
        if (reads > 1) return {}
        await read.promise
        if (failure === 'acknowledgment') throw Object.assign(new Error('Trigger unavailable'), { status: 503 })
        return { retry: true }
      },
      schedule: async (at) => schedules.push(at),
    })
    const waiting = controller.request()
    await Promise.resolve()
    controller.request({ reconnected: true })
    read.resolve()
    await waiting
    now += 5000
    await controller.request()
    await controller.request({ reconnected: true })
    assert.equal(reads, 1)
    assert.deepEqual(schedules, [31_000, 31_000, 31_000])
    now = 31_000
    await controller.request()
    assert.equal(reads, 2)
  })
}

const retryRead = { retry: true, retryOnReconnect: true }

test('a reminder read can retry on browser network failures, timeouts and temporary HTTP failures', () => {
  assert.equal(isTransientReminderReadError(new TypeError('Failed to fetch')), true)
  assert.equal(isTransientReminderReadError({ code: 'REQUEST_TIMEOUT' }), true)
  for (const status of [408, 500, 503, 504]) assert.equal(isTransientReminderReadError({ status }), true)
  for (const status of [401, 403, 404, 429]) assert.equal(isTransientReminderReadError({ status }), false)
  assert.equal(isTransientReminderReadError({ code: 'AUTH_CONTEXT_CHANGED' }), false)
  assert.equal(isTransientReminderReadError(new TypeError('Unexpected value')), false)
})

test('reconnection accelerates a failed reminder read already waiting for its retry deadline', async () => {
  let now = 1000
  let reads = 0
  const schedules = []
  const controller = createReminderPollController({
    now: () => now,
    poll: async () => {
      reads += 1
      return reads === 1 ? retryRead : { nextAt: now + 1000 }
    },
    schedule: (at) => schedules.push(at),
  })
  await controller.request()
  now = 1500
  await controller.request()
  assert.equal(reads, 1)
  await controller.request({ reconnected: true })
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [31_000, 31_000, 2500])
})

test('reconnection during a failing read coalesces into one early retry even if that retry also fails', async () => {
  const first = deferred()
  const retry = deferred()
  const schedules = []
  let reads = 0
  const controller = createReminderPollController({
    now: () => 1000,
    poll: async () => {
      reads += 1
      return reads === 1 ? first.promise : retry.promise
    },
    schedule: (at) => schedules.push(at),
  })
  const waiting = controller.request()
  await Promise.resolve()
  assert.equal(controller.request({ reconnected: true }), waiting)
  assert.equal(controller.request(), waiting)
  first.resolve(retryRead)
  await new Promise(setImmediate)
  assert.equal(reads, 2)
  assert.equal(controller.request({ reconnected: true }), waiting)
  retry.resolve(retryRead)
  await waiting
  await controller.request({ reconnected: true })
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [31_000, 31_000])
})

test('reconnection during re-arming still retries a failed reminder read', async () => {
  const arming = deferred()
  const schedules = []
  let reads = 0
  const controller = createReminderPollController({
    now: () => 1000,
    poll: async () => {
      reads += 1
      return reads === 1 ? retryRead : { nextAt: 2000 }
    },
    schedule: async (at) => {
      schedules.push(at)
      if (schedules.length === 1) await arming.promise
    },
  })
  const waiting = controller.request()
  await new Promise(setImmediate)
  assert.deepEqual(schedules, [31_000])
  assert.equal(controller.request({ reconnected: true }), waiting)
  arming.resolve()
  await waiting
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [31_000, 2000])
})

test('disposing a reminder reader prevents late results from arming another account clock', async () => {
  const read = deferred()
  const schedules = []
  const controller = createReminderPollController({ poll: () => read.promise, schedule: (at) => schedules.push(at) })
  const waiting = controller.request()
  controller.dispose()
  read.resolve({ nextAt: 1000 })
  await waiting
  await controller.request({ reconnected: true })
  assert.deepEqual(schedules, [])
})

test('initial capability adoption does not block a newly created reminder for 30 seconds', async () => {
  let reads = 0
  const schedules = []
  const controller = createReminderPollController({
    now: () => 1000,
    poll: async () => {
      reads += 1
      if (reads === 1) throw Object.assign(new Error('adopting identity'), { code: 'AUTH_CONTEXT_CHANGED' })
      return { nextAt: 1500 }
    },
    schedule: async (at) => schedules.push(at),
  })
  await controller.request()
  assert.deepEqual(schedules, [1250])
  // The creation signal arrives before the short retry deadline.
  await controller.request()
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [1250, 1500])
})

test('identity recovery during an interrupted read keeps its pending refresh', async () => {
  const initialRead = deferred()
  let reads = 0
  const schedules = []
  const controller = createReminderPollController({
    now: () => 1000,
    poll: async () => {
      reads += 1
      if (reads === 1) {
        await initialRead.promise
        throw Object.assign(new Error('old capability'), { code: 'AUTH_CONTEXT_CHANGED' })
      }
      return { nextAt: 1500 }
    },
    schedule: async (at) => schedules.push(at),
  })
  const waiting = controller.request()
  await Promise.resolve()
  controller.request()
  initialRead.resolve()
  await waiting
  assert.equal(reads, 2)
  assert.deepEqual(schedules, [1500])
})

test('persistent unavailable identity backs off without permanently swallowing a later recovery event', async () => {
  let now = 1000
  let ready = false
  const delays = []
  const controller = createReminderPollController({
    now: () => now,
    poll: async () => {
      if (!ready) throw Object.assign(new Error('identity unavailable'), { code: 'AUTH_CONTEXT_CHANGED' })
      return { nextAt: now + 1000 }
    },
    schedule: async (at) => { delays.push(at - now) },
  })
  for (let index = 0; index < 10; index += 1) {
    await controller.request()
    now += delays.at(-1)
  }
  assert.deepEqual(delays.slice(0, 4), [250, 500, 1000, 2000])
  assert.equal(delays.at(-1), REMINDER_RECONCILE_MS)
  ready = true
  await controller.request()
  assert.equal(delays.at(-1), 1000)
})
