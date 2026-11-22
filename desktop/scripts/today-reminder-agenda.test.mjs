import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { getTodayReminderAgenda } from '../src/shared/today-reminder-agenda.js'

const accountContext = { hasSession: true, userId: 7, petType: 'pig' }
const now = new Date(2026, 10, 22, 12).getTime()
const localTime = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString()

function reminder(id, remindAt, overrides = {}) {
  return { id, title: `Reminder ${id}`, user_id: 7, pet_type: 'pig', status: 'pending', remind_at: remindAt, ...overrides }
}

function recurrence(id, remindAt, overrides = {}) {
  return { id, title: `Series ${id}`, user_id: 7, pet_type: 'pig', status: 'active', next_occurrence_at: remindAt, ...overrides }
}

test('today agenda distinguishes receipt, due time, next reminder and prior-day count', () => {
  const start = localTime(22)
  const received = reminder(1, localTime(22, 11), { triggered_at: localTime(22, 11, 1) })
  const earlier = reminder(4, localTime(21, 23, 55))
  const scheduled = [
    reminder(5, localTime(23)), reminder(2, localTime(22, 12, 5)), earlier,
    reminder(3, start), reminder(6, start, { status: 'canceled' }), reminder(7, start, { status: 'completed' }),
  ]
  const original = [...scheduled]
  const result = getTodayReminderAgenda({ scheduled, delivered: [received, earlier], accountContext, now })
  assert.equal(result.earlierUnfinished, 1)
  assert.equal(result.earlierDestination, 'upcoming')
  assert.deepEqual(result.items, [
    { key: 'reminder:3', title: 'Reminder 3', remindAt: Date.parse(start), status: 'due', destination: 'upcoming', targetId: 3 },
    { key: 'reminder:1', title: 'Reminder 1', remindAt: Date.parse(received.remind_at), status: 'delivered', destination: 'delivered', targetId: 1 },
    { key: 'reminder:2', title: 'Reminder 2', remindAt: Date.parse(localTime(22, 12, 5)), status: 'scheduled', destination: 'upcoming', targetId: 2 },
  ])
  assert.deepEqual(scheduled, original)
})

test('today agenda orders a prior-day reminder by its receipt while keeping the original occurrence', () => {
  const originalDue = localTime(21, 23, 55)
  const lateReceipt = localTime(22, 0, 5)
  const currentTime = Date.parse(localTime(22, 0, 10))
  const delivered = [
    reminder(1, originalDue, { series_id: 10, triggered_at: lateReceipt }),
    reminder(6, originalDue, { status: 'completed', triggered_at: lateReceipt }),
    reminder(7, originalDue, { status: 'canceled', triggered_at: lateReceipt }),
    reminder(8, originalDue, { user_id: 18, triggered_at: lateReceipt }),
    reminder(9, originalDue, { pet_type: 'cat', triggered_at: lateReceipt }),
  ]
  const scheduled = [
    reminder(1, originalDue, { series_id: 10 }), reminder(2, localTime(22, 0, 1)),
    reminder(3, originalDue), reminder(4, originalDue, { triggered_at: localTime(22, 0, 11) }),
    reminder(5, originalDue, { triggered_at: 'invalid' }),
    reminder(11, originalDue, { triggered_at: localTime(21, 23, 59) }),
  ]
  const series = [recurrence(10, localTime(22, 0, 15))]
  const result = getTodayReminderAgenda({ scheduled, delivered, series, accountContext, now: currentTime })
  assert.deepEqual(result.items.map(({ key }) => key), ['reminder:2', 'reminder:1', `series:10:${Date.parse(localTime(22, 0, 15))}`])
  assert.deepEqual(result.items[1], {
    key: 'reminder:1', title: 'Reminder 1', remindAt: Date.parse(originalDue),
    lateDeliveryAt: Date.parse(lateReceipt), status: 'delivered', destination: 'delivered', targetId: 1,
  })
  assert.equal(result.earlierUnfinished, 4)
})

test('today agenda keeps only pending rows and series from the active user and pet', () => {
  const scheduled = [reminder(1, localTime(22, 15), { user_id: 18 }), reminder(2, localTime(22, 12), { pet_type: 'cat' }),
    reminder(3, 'invalid'), reminder(4, localTime(21), { user_id: 18 }), reminder(5, localTime(22, 13))]
  const series = [recurrence(20, localTime(22, 16), { pet_type: 'dog' }), recurrence(21, localTime(22, 16), { user_id: 18 })]
  const delivered = [reminder(6, localTime(22, 10), { triggered_at: localTime(22, 10), user_id: 18 })]
  const result = getTodayReminderAgenda({ scheduled, delivered, series, accountContext, now })
  assert.deepEqual(result.items.map((row) => row.key), ['reminder:5'])
  assert.equal(result.earlierUnfinished, 0)
  assert.equal(result.earlierDestination, null)
  for (const invalidContext of [null, { ...accountContext, hasSession: false }, { ...accountContext, userId: null }]) {
    assert.deepEqual(getTodayReminderAgenda({ scheduled, series, accountContext: invalidContext, now }), {
      items: [], earlierUnfinished: 0, earlierDestination: null,
    })
  }
})

test('today agenda prefers a receipt and deduplicates a recurring preview by occurrence instant', () => {
  const due = localTime(22, 16)
  const received = reminder(8, localTime(22, 11), { triggered_at: localTime(22, 11, 1), title: 'Already reminded' })
  const scheduled = [reminder(8, localTime(22, 11)), reminder(9, due, { series_id: 10 })]
  const active = recurrence(11, localTime(22, 18))
  const series = [
    recurrence(10, due.replace('Z', '+00:00')), active, active,
    recurrence(12, localTime(22, 17), { status: 'paused' }), recurrence(13, localTime(22, 17), { status: 'canceled' }),
    recurrence(14, localTime(22, 12)), recurrence(15, localTime(23)),
  ]
  const result = getTodayReminderAgenda({ scheduled, delivered: [received], series, accountContext, now })
  assert.deepEqual(result.items.map(({ title, status, destination, targetId }) => ({ title, status, destination, targetId })), [
    { title: received.title, status: 'delivered', destination: 'delivered', targetId: 8 },
    { title: 'Reminder 9', status: 'scheduled', destination: 'recurring', targetId: 10 },
    { title: 'Series 11', status: 'projected', destination: 'recurring', targetId: 11 },
  ])
})

test('today agenda retains delivered receipts from stopped series and directs earlier rows by age', () => {
  const scheduled = [
    reminder(5, localTime(22, 16), { series_id: 20 }),
    reminder(6, localTime(22, 10), { series_id: 21 }),
    reminder(7, localTime(20, 10), { series_id: 22 }),
    reminder(8, localTime(19, 10), { series_id: 21 }),
  ]
  const delivered = [
    reminder(1, localTime(21, 11), { triggered_at: localTime(21, 11, 1) }),
    reminder(2, localTime(22, 11), { series_id: 20, triggered_at: localTime(22, 11, 1) }),
  ]
  const series = [
    recurrence(20, localTime(22, 16), { status: 'paused' }),
    recurrence(21, localTime(22, 16), { status: 'canceled' }),
  ]
  const result = getTodayReminderAgenda({ scheduled, delivered, series, accountContext, now })
  assert.deepEqual(result.items.map((item) => item.key), ['reminder:2'])
  assert.equal(result.earlierUnfinished, 2)
  assert.equal(result.earlierDestination, 'recurring')
})

test('today agenda uses local calendar bounds on both DST clock changes', () => {
  const moduleUrl = new URL('../src/shared/today-reminder-agenda.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { getTodayReminderAgenda } from ${JSON.stringify(moduleUrl)}
    const accountContext = { userId: 7, petType: 'pig' }
    for (const [current, boundaries] of [
      ['2026-03-08T12:00:00Z', ['2026-03-08T04:59:59Z', '2026-03-08T05:00:00Z', '2026-03-09T03:59:59Z', '2026-03-09T04:00:00Z']],
      ['2026-11-01T12:00:00Z', ['2026-11-01T03:59:59Z', '2026-11-01T04:00:00Z', '2026-11-02T04:59:59Z', '2026-11-02T05:00:00Z']],
    ]) {
      const scheduled = boundaries.map((remind_at, index) => ({ id: index + 1, title: 'Reminder', user_id: 7, pet_type: 'pig', status: 'pending', remind_at }))
      const { items, earlierUnfinished } = getTodayReminderAgenda({ scheduled, accountContext, now: Date.parse(current) })
      assert.deepEqual(items.map((item) => item.key), ['reminder:2', 'reminder:3'])
      assert.equal(earlierUnfinished, 1)
      const delivered = [{ ...scheduled[0], triggered_at: boundaries[1] }]
      const withReceipt = getTodayReminderAgenda({ scheduled, delivered, accountContext, now: Date.parse(current) })
      assert.equal(withReceipt.earlierUnfinished, 0)
      assert.equal(withReceipt.items.length, 3)
      const late = withReceipt.items.find(({ key }) => key === 'reminder:1')
      assert.equal(late.remindAt, Date.parse(boundaries[0]))
      assert.equal(late.lateDeliveryAt, Date.parse(boundaries[1]))
    }
  `], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
