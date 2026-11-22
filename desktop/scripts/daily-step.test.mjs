import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  DAILY_STEP_TITLE_LENGTH,
  getDailyStepDate,
  getDailyStepStorageKey,
  getDailyStepTitle,
  readCompletedDailySteps,
  readDailyStep,
  readDailyStepCarryOver,
  writeDailyStep,
} from '../src/shared/daily-step.js'

const scope = { server: 'https://companion.example/api/v1', userId: 1, petType: 'pig', hasSession: true }
const firstDay = '2026-11-21'
const nextDay = '2026-11-22'
const step = { title: '读几页书', completed: false }

function testStorage() {
  const records = new Map()
  const writes = []
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      writes.push('set')
      records.set(key, value)
    },
    removeItem: (key) => {
      writes.push('remove')
      records.delete(key)
    },
  }
  return { records, writes, getStorage: () => storage }
}

test('daily steps isolate accounts, pets and servers, including after signing back in', () => {
  const { getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  assert.equal(getDailyStepStorageKey({ ...scope, server: 'https://COMPANION.example:443/api/' }), key)
  assert.equal(getDailyStepStorageKey({ ...scope, session: { generation: 4, token: 'never stored' } }), key)
  assert.equal(getDailyStepStorageKey({ ...scope, hasSession: false }), null)
  assert.equal(getDailyStepStorageKey({ ...scope, server: '' }), null)
  assert.equal(getDailyStepStorageKey({ ...scope, server: 'https://user:secret@companion.example' }), null)
  assert.equal(getDailyStepStorageKey({ ...scope, userId: 0 }), null)
  assert.equal(getDailyStepStorageKey({ ...scope, petType: 'unknown' }), null)

  const completed = { ...step, completed: true }
  assert.equal(writeDailyStep(key, firstDay, completed, getStorage), true)
  for (const other of [{ userId: 2 }, { petType: 'cat' }, { server: 'https://other.example' }]) {
    const otherKey = getDailyStepStorageKey({ ...scope, ...other })
    assert.notEqual(otherKey, key)
    assert.equal(readDailyStep(otherKey, firstDay, getStorage), null)
    assert.deepEqual(readCompletedDailySteps(otherKey, firstDay, getStorage), [])
  }
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), completed)
  assert.deepEqual(readCompletedDailySteps(key, firstDay, getStorage), [{ date: firstDay, title: step.title }])
})

test('calendar keys use the device day and a new plan replaces the previous day for that scope', () => {
  const { records, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  assert.equal(getDailyStepDate(new Date(2026, 10, 21, 23, 59, 59).getTime()), firstDay)
  assert.equal(getDailyStepDate(new Date(2026, 10, 22, 0, 0).getTime()), nextDay)
  assert.equal(getDailyStepDate(new Date(2026, 0, 2).getTime()), '2026-01-02')

  assert.equal(writeDailyStep(key, firstDay, step, getStorage), true)
  assert.equal(readDailyStep(key, nextDay, getStorage), null)
  const newStep = { ...step, title: '散步十分钟' }
  assert.equal(writeDailyStep(key, nextDay, newStep, getStorage), true)
  assert.deepEqual(readDailyStep(key, nextDay, getStorage), newStep)
  assert.equal(readDailyStep(key, firstDay, getStorage), null)
  assert.equal(records.size, 1)
})

test('carry-over only offers yesterday’s unfinished step in the same scope and writes nothing when read', () => {
  const { records, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  assert.equal(writeDailyStep(key, firstDay, step, getStorage), true)
  assert.deepEqual(readDailyStepCarryOver(key, nextDay, getStorage), step)
  assert.equal(readDailyStep(key, nextDay, getStorage), null)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), step)
  assert.equal(readDailyStepCarryOver(key, '2026-11-23', getStorage), null)
  assert.equal(readDailyStepCarryOver(key, firstDay, getStorage), null)
  for (const other of [{ userId: 2 }, { petType: 'cat' }, { server: 'https://other.example' }]) {
    assert.equal(readDailyStepCarryOver(getDailyStepStorageKey({ ...scope, ...other }), nextDay, getStorage), null)
  }
  assert.equal(writeDailyStep(key, nextDay, step, getStorage), true)
  assert.deepEqual(readDailyStep(key, nextDay, getStorage), step)
  assert.equal(readDailyStep(key, firstDay, getStorage), null)
  assert.equal(readDailyStepCarryOver(key, nextDay, getStorage), null)
  assert.equal(records.size, 1)
})

test('carry-over finds the previous local date across DST and calendar rollover', () => {
  const moduleUrl = new URL('../src/shared/daily-step.js', import.meta.url).href
  const program = `
    import assert from 'node:assert/strict'
    import { getDailyStepDate, readDailyStepCarryOver } from ${JSON.stringify(moduleUrl)}
    assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York')
    for (const [today, yesterday] of [
      [new Date(2026, 2, 9, 0, 15), '2026-03-08'],
      [new Date(2026, 10, 1, 23, 45), '2026-10-31'],
      [new Date(2027, 0, 1, 0, 15), '2026-12-31'],
    ]) {
      const step = { title: 'Read', completed: false }
      const getStorage = () => ({ getItem: () => JSON.stringify({ date: yesterday, ...step }) })
      assert.deepEqual(readDailyStepCarryOver('local-step', getDailyStepDate(today), getStorage), step)
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr || result.error || result.stdout)
})

test('editing, completion, undo and removal persist only explicit writes', () => {
  const { getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  const completed = { title: '读完这一章', completed: true }
  assert.equal(writeDailyStep(key, firstDay, step, getStorage), true)
  assert.equal(writeDailyStep(key, firstDay, { ...completed, completed: false }, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { ...completed, completed: false })
  assert.equal(writeDailyStep(key, firstDay, completed, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), completed)
  assert.equal(readDailyStepCarryOver(key, nextDay, getStorage), null)
  assert.equal(writeDailyStep(key, firstDay, { ...completed, completed: false }, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { ...completed, completed: false })
  assert.equal(writeDailyStep(key, firstDay, null, getStorage), true)
  assert.equal(readDailyStep(key, firstDay, getStorage), null)
})

test('completed legacy plans appear on read and migrate on the next single write', () => {
  const { records, writes, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  const legacy = JSON.stringify({ date: firstDay, ...step, completed: true })
  records.set(key, legacy)

  const completion = { date: firstDay, title: step.title }
  assert.deepEqual(readCompletedDailySteps(key, nextDay, getStorage), [completion])
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { ...step, completed: true })
  assert.equal(records.get(key), legacy)
  assert.deepEqual(writes, [])

  assert.equal(writeDailyStep(key, nextDay, { title: 'Take a walk', completed: false }, getStorage), true)
  assert.deepEqual(writes, ['set'])
  assert.deepEqual(JSON.parse(records.get(key)), {
    date: nextDay, title: 'Take a walk', completed: false, completedHistory: [completion],
  })
  assert.deepEqual(readCompletedDailySteps(key, nextDay, getStorage), [completion])
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { ...step, completed: true })
  assert.equal(readDailyStepCarryOver(key, nextDay, getStorage), null)
})

test('each date has one completion, and undo and removal affect only their date', () => {
  const { records, writes, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  const first = { date: firstDay, title: 'Read' }
  assert.equal(writeDailyStep(key, firstDay, { title: first.title, completed: true }, getStorage), true)
  assert.equal(writeDailyStep(key, nextDay, { title: 'Walk', completed: true }, getStorage), true)
  assert.equal(writeDailyStep(key, nextDay, { title: 'Walk ten minutes', completed: true }, getStorage), true)
  assert.deepEqual(readCompletedDailySteps(key, nextDay, getStorage), [
    { date: nextDay, title: 'Walk ten minutes' }, first,
  ])

  const undone = { title: 'Walk ten minutes', completed: false }
  assert.equal(writeDailyStep(key, nextDay, undone, getStorage), true)
  assert.deepEqual(readDailyStep(key, nextDay, getStorage), undone)
  assert.deepEqual(readCompletedDailySteps(key, nextDay, getStorage), [first])
  assert.equal(writeDailyStep(key, nextDay, { ...undone, completed: true }, getStorage), true)
  assert.equal(writeDailyStep(key, nextDay, null, getStorage), true)
  assert.deepEqual(JSON.parse(records.get(key)), { completedHistory: [first] })
  assert.equal(readDailyStep(key, nextDay, getStorage), null)
  assert.equal(readDailyStepCarryOver(key, nextDay, getStorage), null)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { title: first.title, completed: true })
  assert.equal(writeDailyStep(key, firstDay, null, getStorage), true)
  assert.equal(records.has(key), false)
  assert.deepEqual(writes, ['set', 'set', 'set', 'set', 'set', 'set', 'remove'])
})

test('history retains the newest seven dates and only shows dates in the requested calendar week', () => {
  const { records, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  const rows = Array.from({ length: 9 }, (_, index) => ({ date: `2026-11-${15 + index}`, title: `Step ${index + 1}` }))
  for (const { date, title } of rows) {
    assert.equal(writeDailyStep(key, date, { title, completed: true }, getStorage), true)
  }
  assert.deepEqual(JSON.parse(records.get(key)).completedHistory, rows.slice(-7).reverse())
  assert.deepEqual(readCompletedDailySteps(key, '2026-11-23', getStorage), rows.slice(-7).reverse())
  assert.deepEqual(readCompletedDailySteps(key, '2026-11-19', getStorage), rows.slice(2, 5).reverse())
  assert.deepEqual(readCompletedDailySteps(key, '2026-11-30', getStorage), [])
  assert.equal(readDailyStep(key, '2026-11-16', getStorage), null)
  assert.deepEqual(readDailyStep(key, '2026-11-17', getStorage), { title: rows[2].title, completed: true })
  assert.equal(writeDailyStep(key, '2026-11-17', null, getStorage), true)
  assert.deepEqual(readDailyStep(key, '2026-11-23', getStorage), { title: rows[8].title, completed: true })
  assert.equal(JSON.parse(records.get(key)).date, '2026-11-23')
  assert.equal(readDailyStep(key, '2026-11-17', getStorage), null)
})

test('history bounds use calendar days over spring and fall DST and over the new year', () => {
  const moduleUrl = new URL('../src/shared/daily-step.js', import.meta.url).href
  const program = `
    import assert from 'node:assert/strict'
    import { getDailyStepDate, readCompletedDailySteps } from ${JSON.stringify(moduleUrl)}
    for (const [from, dates] of [
      [new Date(2026, 2, 9, 0, 15), ['2026-03-02', '2026-03-03', '2026-03-09', '2026-03-10']],
      [new Date(2026, 10, 2, 0, 15), ['2026-10-26', '2026-10-27', '2026-11-02', '2026-11-03']],
      [new Date(2027, 0, 1, 0, 15), ['2026-12-25', '2026-12-26', '2027-01-01', '2027-01-02']],
    ]) {
      const completedHistory = dates.map((date) => ({ date, title: 'Read' }))
      const getStorage = () => ({ getItem: () => JSON.stringify({ completedHistory }) })
      assert.deepEqual(readCompletedDailySteps('local-step', getDailyStepDate(from), getStorage), [completedHistory[2], completedHistory[1]])
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr || result.error || result.stdout)
})

test('history ignores invalid persisted rows, honors the current slot, and recovers corrupt JSON on write', () => {
  const { records, writes, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  records.set(key, JSON.stringify({
    date: '2028-03-01', title: 'Current', completed: false,
    completedHistory: [
      null, { date: '2028-02-30', title: 'Impossible' }, { date: '2028-02-27', title: 'Line\nbreak' },
      { date: '2028-02-28', title: 'Pending', completed: false }, { date: '2028-03-01', title: 'Stale completed' },
      { date: '2028-02-29', title: '  Valid  ' },
    ],
  }))
  assert.deepEqual(readCompletedDailySteps(key, '2028-03-01', getStorage), [{ date: '2028-02-29', title: 'Valid' }])
  assert.deepEqual(readCompletedDailySteps(key, '2028-02-30', getStorage), [])
  assert.equal(readDailyStep(key, '2028-02-30', getStorage), null)
  assert.equal(writeDailyStep(key, '2028-02-30', step, getStorage), false)
  assert.deepEqual(writes, [])
  records.set(key, '{')
  assert.deepEqual(readCompletedDailySteps(key, firstDay, getStorage), [])
  assert.equal(writeDailyStep(key, firstDay, step, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), step)
})

test('invalid titles, old records and corrupted storage cannot surface as plans', () => {
  const { records, getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  assert.equal(getDailyStepTitle('  读书  '), '读书')
  assert.equal(getDailyStepTitle('读'.repeat(DAILY_STEP_TITLE_LENGTH)).length, DAILY_STEP_TITLE_LENGTH)
  for (const title of ['', '  ', 'line\nbreak', '读'.repeat(DAILY_STEP_TITLE_LENGTH + 1)]) {
    assert.equal(getDailyStepTitle(title), '')
    assert.equal(writeDailyStep(key, firstDay, { title, completed: false }, getStorage), false)
  }
  for (const raw of ['{', 'null', '{"date":"2026-11-21","title":"Missing completion"}', JSON.stringify({ ...step, date: '2026-08-01' })]) {
    records.set(key, raw)
    assert.equal(readDailyStep(key, firstDay, getStorage), null)
  }
})

test('restricted storage cannot claim a save or removal', () => {
  const key = getDailyStepStorageKey(scope)
  const unavailable = () => { throw new Error('Storage blocked') }
  const full = () => ({ getItem: () => null, setItem: () => { throw new Error('Storage full') } })
  const readOnly = () => ({ getItem: () => null, removeItem: () => { throw new Error('Storage read-only') } })
  assert.equal(readDailyStep(key, firstDay, unavailable), null)
  assert.deepEqual(readCompletedDailySteps(key, firstDay, unavailable), [])
  assert.equal(writeDailyStep(key, firstDay, step, unavailable), false)
  assert.equal(writeDailyStep(key, firstDay, step, full), false)
  assert.equal(writeDailyStep(key, firstDay, null, readOnly), false)
  assert.equal(writeDailyStep(key, firstDay, null, () => undefined), false)
})
