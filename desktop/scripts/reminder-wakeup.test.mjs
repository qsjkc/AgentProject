import assert from 'node:assert/strict'
import { test } from 'node:test'
import reminderWakeup from '../electron/reminder-wakeup.cjs'
import {
  createReminderPollController,
  getReminderPollPlan,
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

for (const failure of ['muted', 'network']) {
  test(`${failure} reminder delivery backs off for 30s even when more refresh events arrive`, async () => {
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
        if (failure === 'network') throw new Error('offline')
        return { retry: true }
      },
      schedule: async (at) => schedules.push(at),
    })
    const waiting = controller.request()
    await Promise.resolve()
    controller.request()
    read.resolve()
    await waiting
    now += 5000
    await controller.request()
    assert.equal(reads, 1)
    assert.deepEqual(schedules, [31_000, 31_000])
    now = 31_000
    await controller.request()
    assert.equal(reads, 2)
  })
}

test('disposing a reminder reader prevents late results from arming another account clock', async () => {
  const read = deferred()
  const schedules = []
  const controller = createReminderPollController({ poll: () => read.promise, schedule: (at) => schedules.push(at) })
  const waiting = controller.request()
  controller.dispose()
  read.resolve({ nextAt: 1000 })
  await waiting
  await controller.request()
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
