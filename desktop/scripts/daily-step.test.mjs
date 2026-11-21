import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DAILY_STEP_TITLE_LENGTH,
  getDailyStepDate,
  getDailyStepStorageKey,
  getDailyStepTitle,
  readDailyStep,
  writeDailyStep,
} from '../src/shared/daily-step.js'

const scope = { server: 'https://companion.example/api/v1', userId: 1, petType: 'pig', hasSession: true }
const firstDay = '2026-11-21'
const nextDay = '2026-11-22'
const step = { title: '读几页书', completed: false }

function testStorage() {
  const records = new Map()
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  }
  return { records, getStorage: () => storage }
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

  assert.equal(writeDailyStep(key, firstDay, step, getStorage), true)
  for (const other of [{ userId: 2 }, { petType: 'cat' }, { server: 'https://other.example' }]) {
    const otherKey = getDailyStepStorageKey({ ...scope, ...other })
    assert.notEqual(otherKey, key)
    assert.equal(readDailyStep(otherKey, firstDay, getStorage), null)
  }
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), step)
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

test('editing, completion, undo and removal persist only explicit writes', () => {
  const { getStorage } = testStorage()
  const key = getDailyStepStorageKey(scope)
  const completed = { title: '读完这一章', completed: true }
  assert.equal(writeDailyStep(key, firstDay, step, getStorage), true)
  assert.equal(writeDailyStep(key, firstDay, { ...completed, completed: false }, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { ...completed, completed: false })
  assert.equal(writeDailyStep(key, firstDay, completed, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), completed)
  assert.equal(writeDailyStep(key, firstDay, { ...completed, completed: false }, getStorage), true)
  assert.deepEqual(readDailyStep(key, firstDay, getStorage), { ...completed, completed: false })
  assert.equal(writeDailyStep(key, firstDay, null, getStorage), true)
  assert.equal(readDailyStep(key, firstDay, getStorage), null)
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
  const full = () => ({ setItem: () => { throw new Error('Storage full') } })
  assert.equal(readDailyStep(key, firstDay, unavailable), null)
  assert.equal(writeDailyStep(key, firstDay, step, unavailable), false)
  assert.equal(writeDailyStep(key, firstDay, step, full), false)
  assert.equal(writeDailyStep(key, firstDay, null, () => undefined), false)
})
