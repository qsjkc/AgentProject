import assert from 'node:assert/strict'
import { test } from 'node:test'
import focusSessions from '../electron/focus-session.cjs'
import { captureFocusSnapshot, formatFocusTime, getFocusRemainingMs, getFocusSnapshotRemainingMs, isFocusSnapshotCurrent } from '../src/shared/focus-session.js'

const { createFocusAccountKey, createFocusSessionController, emptyFocusSession, normalizeFocusSession, transitionFocusSession } = focusSessions
const accountA = { server: 'https://example.test/api/v1', hasSession: true, userId: 1, petType: 'pig', session: { generation: 1 } }
const accountB = { ...accountA, userId: 2, session: { generation: 2 } }

function harness({ storage = new Map(), initialNow = 1_000_000, independentClocks = false } = {}) {
  let clock = initialNow
  let elapsed = 0
  let sequence = 0
  const timers = new Map()
  const events = []
  const completed = []
  const writes = []
  const controller = createFocusSessionController({
    now: () => clock,
    ...(independentClocks ? { elapsedNow: () => elapsed } : {}),
    read: (key) => storage.get(key),
    write: (key, state) => { storage.set(key, structuredClone(state)); writes.push({ key, state }) },
    createId: () => `focus-${++sequence}`,
    setTimer: (callback, delay) => { timers.set(++sequence, { callback, at: elapsed + delay }); return sequence },
    clearTimer: (id) => timers.delete(id),
    onChange: (snapshot) => events.push(snapshot),
    onComplete: (snapshot) => completed.push(snapshot),
  })
  const advance = (milliseconds, { fire = true } = {}) => {
    clock += milliseconds
    elapsed += milliseconds
    if (!fire) return
    for (const [id, timer] of [...timers]) {
      if (timer.at > elapsed) continue
      timers.delete(id)
      timer.callback()
    }
  }
  const update = (command, payload = {}) => controller.update(command, {
    expectedRevision: controller.current().state?.revision,
    ...payload,
  })
  controller.setContext(accountA)
  return { controller, storage, timers, events, completed, writes, advance, update, now: () => clock, elapsed: () => elapsed, adjustWall: (milliseconds) => { clock += milliseconds } }
}

test('starting a focus session validates presets, bounds intention and persists one deadline', () => {
  const h = harness()
  assert.equal(h.update('start', { minutes: 0 }).ok, false)
  assert.equal(h.update('start', { minutes: Infinity }).ok, false)
  const started = h.update('start', { minutes: 25, intention: ` ${'读'.repeat(100)} ` })
  assert.equal(started.ok, true)
  assert.equal(started.state.status, 'running')
  assert.equal(started.state.endsAt, h.now() + 25 * 60000)
  assert.equal(started.state.intention.length, 80)
  assert.equal(h.writes.length, 1)
  assert.equal(h.timers.size, 1)
})

test('pause freezes remaining time and resume uses a fresh deadline', () => {
  const h = harness()
  h.update('start', { minutes: 25 })
  h.advance(5 * 60000)
  assert.equal(h.update('pause').state.remainingMs, 20 * 60000)
  assert.equal(h.timers.size, 0)
  h.advance(60 * 60000)
  const resumed = h.update('resume').state
  assert.equal(resumed.endsAt, h.now() + 20 * 60000)
  h.advance(20 * 60000)
  assert.equal(h.controller.current().state.status, 'completed')
  assert.equal(h.completed.length, 1)
})

test('main-process timer completes without a renderer and never duplicates completion', () => {
  const h = harness()
  h.update('start', { minutes: 15 })
  h.advance(15 * 60000)
  assert.equal(h.completed.length, 1)
  assert.equal(h.controller.current().state.remainingMs, 0)
  h.controller.resume()
  h.advance(60 * 60000)
  assert.equal(h.completed.length, 1)
  assert.equal(h.timers.size, 0)
})

test('resume after skipped timer callbacks settles elapsed time exactly once', () => {
  const h = harness()
  h.update('start', { minutes: 15 })
  h.advance(60 * 60000, { fire: false })
  h.controller.resume()
  assert.equal(h.controller.current().state.status, 'completed')
  assert.equal(h.completed.length, 1)
  assert.equal(h.timers.size, 0)
})

for (const adjustment of [-60 * 60000, 60 * 60000]) {
  test(`wall clock adjustment of ${adjustment / 60000} minutes does not change a live focus duration`, () => {
    const h = harness({ independentClocks: true })
    const started = h.update('start', { minutes: 25 })
    h.advance(5 * 60000)
    h.adjustWall(adjustment)
    const current = h.controller.current().state
    assert.equal(current.status, 'running')
    assert.equal(current.revision, started.state.revision)
    assert.equal(current.remainingMs, 20 * 60000)
    assert.equal(current.endsAt, h.now() + 20 * 60000)
    assert.equal(h.storage.get(createFocusAccountKey(accountA)).endsAt, current.endsAt)
    assert.equal(h.completed.length, 0)
    h.advance(20 * 60000 - 1)
    assert.equal(h.controller.current().state.remainingMs, 1)
    h.advance(1)
    assert.equal(h.controller.current().state.status, 'completed')
    assert.equal(h.controller.current().state.revision, started.state.revision + 1)
    assert.equal(h.completed.length, 1)
    h.controller.resume()
    h.advance(60 * 60000)
    assert.equal(h.completed.length, 1)
    assert.equal(h.timers.size, 0)
  })
}

test('an unobserved clock change cannot delay the timer or consume its one completion', () => {
  for (const adjustment of [-60 * 60000, 60 * 60000]) {
    const h = harness({ independentClocks: true })
    h.update('start', { minutes: 15 })
    h.adjustWall(adjustment)
    // No renderer reads or context updates repair the state before the timeout.
    h.advance(15 * 60000)
    assert.equal(h.controller.current().state.status, 'completed')
    assert.equal(h.completed.length, 1)
    h.controller.resume()
    assert.equal(h.completed.length, 1)
  }
})

test('pause and resume preserve elapsed work across multiple wall clock corrections', () => {
  const h = harness({ independentClocks: true })
  h.update('start', { minutes: 25 })
  h.advance(5 * 60000)
  h.adjustWall(-60 * 60000)
  assert.equal(h.update('pause').state.remainingMs, 20 * 60000)
  h.advance(60 * 60000)
  h.adjustWall(120 * 60000)
  assert.equal(h.controller.current().state.remainingMs, 20 * 60000)
  const resumed = h.update('resume')
  assert.equal(resumed.state.endsAt, h.now() + 20 * 60000)
  h.advance(20 * 60000, { fire: false })
  h.adjustWall(-60 * 60000)
  h.controller.resume()
  assert.equal(h.controller.current().state.status, 'completed')
  assert.equal(h.completed.length, 1)
  assert.equal(h.timers.size, 0)
})

test('hidden account and pet clocks retain their elapsed anchors without cross-account notifications', () => {
  const h = harness({ independentClocks: true })
  h.update('start', { minutes: 25, intention: 'Private A' })
  h.advance(5 * 60000)
  h.controller.setContext(accountB)
  h.adjustWall(60 * 60000)
  h.advance(5 * 60000)
  assert.equal(h.controller.current().state.intention, '')
  assert.equal(h.completed.length, 0)
  const returned = { ...accountA, session: { generation: 3 } }
  assert.equal(h.controller.setContext(returned).state.remainingMs, 15 * 60000)
  h.controller.setContext({ ...returned, petType: 'cat' })
  h.adjustWall(-120 * 60000)
  h.advance(20 * 60000)
  assert.equal(h.controller.current().state.status, 'idle')
  assert.equal(h.controller.current().state.intention, '')
  assert.equal(h.controller.setContext(returned).state.status, 'completed')
  assert.equal(h.completed.length, 0)
})

test('a graceful restart checkpoints corrected deadlines for inactive servers and restores wall time', () => {
  for (const adjustment of [-60 * 60000, 60 * 60000]) {
    const h = harness({ independentClocks: true })
    h.update('start', { minutes: 25 })
    h.advance(5 * 60000)
    h.controller.setContext({ ...accountA, server: 'https://another.test/api/v1' })
    h.update('start', { minutes: 45 })
    h.adjustWall(adjustment)
    h.controller.dispose()
    const restarted = harness({ storage: h.storage, initialNow: h.now() + 5 * 60000, independentClocks: true })
    assert.equal(restarted.controller.current().state.remainingMs, 15 * 60000)
    assert.equal(restarted.controller.setContext({ ...accountA, server: 'https://another.test/api/v1' }).state.remainingMs, 40 * 60000)
    assert.equal(restarted.completed.length, 0)
    restarted.controller.dispose()
  }
})

test('restart after a wall rollback never restores more than the last known remaining time', () => {
  const h = harness({ independentClocks: true })
  h.update('start', { minutes: 25 })
  h.advance(5 * 60000)
  h.controller.dispose()
  assert.equal(h.storage.get(createFocusAccountKey(accountA)).remainingMs, 20 * 60000)
  const restarted = harness({ storage: h.storage, initialNow: h.now() - 60 * 60000, independentClocks: true })
  assert.equal(restarted.controller.current().state.remainingMs, 20 * 60000)
  assert.equal(restarted.controller.current().state.endsAt, restarted.now() + 20 * 60000)
  restarted.advance(20 * 60000)
  assert.equal(restarted.controller.current().state.status, 'completed')
  assert.equal(restarted.completed.length, 1)
})

test('the production default clock stays independent of Date.now corrections', () => {
  const actualDateNow = Date.now
  let wall = 1_000_000
  const storage = new Map()
  const controller = createFocusSessionController({
    read: (key) => storage.get(key), write: (key, state) => storage.set(key, state),
    createId: () => 'native-clock', setTimer: () => 1, clearTimer: () => {},
  })
  // Create a fresh controller after replacing Date.now, as the real factory
  // captures it once. The independently selected default elapsed clock must not.
  Date.now = () => wall
  const corrected = createFocusSessionController({
    read: (key) => storage.get(key), write: (key, state) => storage.set(key, state),
    createId: () => 'native-clock', setTimer: () => 1, clearTimer: () => {},
  })
  try {
    corrected.setContext(accountA)
    corrected.update('start', { expectedRevision: 0, minutes: 15 })
    wall += 60 * 60000
    const state = corrected.current().state
    assert.equal(state.status, 'running')
    assert.ok(state.remainingMs > 14 * 60000 && state.remainingMs <= 15 * 60000)
  } finally {
    Date.now = actualDateNow
    corrected.dispose()
    controller.dispose()
  }
})

test('renderer countdown and focus suppression use received elapsed time across wall corrections', () => {
  const h = harness({ independentClocks: true })
  const started = h.update('start', { minutes: 25 })
  const captured = captureFocusSnapshot(started, null, h.elapsed())
  h.advance(5 * 60000)
  h.adjustWall(60 * 60000)
  assert.equal(getFocusSnapshotRemainingMs(captured, h.elapsed()), 20 * 60000)
  h.adjustWall(-120 * 60000)
  h.advance(10 * 60000)
  assert.equal(getFocusSnapshotRemainingMs(captured, h.elapsed()), 10 * 60000)
  h.advance(10 * 60000)
  assert.equal(getFocusSnapshotRemainingMs(captured, h.elapsed()), 0)
})

test('delayed snapshots cannot rewind the renderer countdown or replace a paused revision', () => {
  const h = harness({ independentClocks: true })
  const started = h.update('start', { minutes: 25 })
  const first = captureFocusSnapshot(started, null, h.elapsed())
  h.advance(5 * 60000)
  const delayed = captureFocusSnapshot(started, first, h.elapsed())
  assert.equal(getFocusSnapshotRemainingMs(delayed, h.elapsed()), 20 * 60000)
  const paused = captureFocusSnapshot(h.update('pause'), delayed, h.elapsed())
  h.advance(10 * 60000)
  assert.equal(getFocusSnapshotRemainingMs(paused, h.elapsed()), 20 * 60000)
  assert.equal(captureFocusSnapshot(started, paused, h.elapsed()), paused)
  const otherAccount = captureFocusSnapshot({ ...started, userId: accountB.userId }, paused, h.elapsed())
  assert.equal(getFocusSnapshotRemainingMs(otherAccount, h.elapsed()), 25 * 60000)
})

test('a read at the deadline cannot consume and lose the completion notification', () => {
  const h = harness()
  h.update('start', { minutes: 15 })
  h.advance(15 * 60000, { fire: false })
  assert.equal(h.controller.current().state.status, 'completed')
  assert.equal(h.completed.length, 1)
  h.advance(1)
  h.controller.current()
  assert.equal(h.completed.length, 1)
})

test('restart restores running and paused sessions without reissuing elapsed notifications', () => {
  const h = harness()
  h.update('start', { minutes: 25, intention: 'Read a chapter' })
  h.advance(10 * 60000)
  h.controller.dispose()
  const restarted = harness({ storage: h.storage, initialNow: h.now() })
  assert.equal(getFocusRemainingMs(restarted.controller.current().state, restarted.now()), 15 * 60000)
  restarted.update('pause')
  restarted.controller.dispose()
  const paused = harness({ storage: h.storage, initialNow: h.now() + 60 * 60000 })
  assert.equal(paused.controller.current().state.status, 'paused')
  assert.equal(paused.controller.current().state.remainingMs, 15 * 60000)
  paused.update('resume')
  paused.controller.dispose()
  const elapsed = harness({ storage: h.storage, initialNow: paused.now() + 60 * 60000 })
  assert.equal(elapsed.controller.current().state.status, 'completed')
  assert.equal(elapsed.completed.length, 0)
})

test('account switching hides the previous intention and does not notify the wrong account', () => {
  const h = harness()
  h.update('start', { minutes: 15, intention: 'Only A can see this' })
  h.controller.setContext(accountB)
  assert.equal(h.controller.current().state.status, 'idle')
  assert.equal(h.controller.current().state.intention, '')
  h.advance(20 * 60000)
  assert.equal(h.completed.length, 0)
  h.controller.setContext({ ...accountA, session: { generation: 3 } })
  assert.equal(h.controller.current().state.status, 'completed')
  assert.equal(h.controller.current().state.intention, 'Only A can see this')
  assert.equal(h.completed.length, 0)
})

test('logout and unsupported pets clear active timers and reject mutations', () => {
  const h = harness()
  h.update('start', { minutes: 25 })
  for (const context of [{ ...accountA, hasSession: false }, { ...accountA, petType: 'rabbit' }]) {
    h.controller.setContext(context)
    assert.equal(h.controller.current().state, null)
    assert.equal(h.timers.size, 0)
    assert.equal(h.update('start', { minutes: 25 }).reason, 'no-account')
  }
})

test('the same numerical user id on a different server has an independent timer', () => {
  const h = harness()
  h.update('start', { minutes: 25 })
  h.controller.setContext({ ...accountA, server: 'https://another.test/api/v1' })
  assert.equal(h.controller.current().state.status, 'idle')
  assert.equal(createFocusAccountKey(accountA), createFocusAccountKey({ ...accountA, server: `${accountA.server}/` }))
})

test('concurrent or stale commands cannot reset or replace a new session', () => {
  const h = harness()
  const first = h.update('start', { minutes: 15 })
  assert.equal(h.update('start', { minutes: 45 }).reason, 'invalid-transition')
  h.update('pause')
  assert.equal(h.update('reset', { expectedRevision: first.state.revision }).reason, 'conflict')
  h.update('reset')
  h.update('start', { minutes: 45 })
  assert.equal(h.update('pause', { expectedRevision: first.state.revision }).reason, 'conflict')
  assert.equal(h.controller.current().state.durationMs, 45 * 60000)
})

test('early finish cancels the timer without generating a success notification', () => {
  const h = harness()
  h.update('start', { minutes: 15 })
  h.advance(60000)
  assert.equal(h.update('reset').state.status, 'idle')
  h.advance(15 * 60000)
  assert.equal(h.completed.length, 0)
  assert.equal(h.timers.size, 0)
})

test('corrupt persisted state resets safely, preserving its revision', () => {
  assert.deepEqual(normalizeFocusSession({ revision: 4, status: 'running', endsAt: Infinity }), emptyFocusSession(4))
  const result = transitionFocusSession(emptyFocusSession(), 'pause', { expectedRevision: 0 }, 0, () => 'id')
  assert.equal(result.reason, 'invalid-transition')
})

test('invalid stored server settings disable focus without crashing startup', () => {
  const h = harness()
  h.update('start', { minutes: 15 })
  for (const server of [42, {}, [], null, undefined]) {
    const result = h.controller.setContext({ ...accountA, server })
    assert.equal(result.state, null)
    assert.equal(result.server, null)
    assert.equal(h.timers.size, 0)
  }
  h.controller.setContext(accountA)
  assert.equal(h.controller.current().state.status, 'running')
})

test('countdown rounds partial seconds up, stays bounded and suppresses stale account snapshots', () => {
  assert.equal(formatFocusTime(900000), '15:00')
  assert.equal(formatFocusTime(1001), '00:02')
  assert.equal(formatFocusTime(-10), '00:00')
  const h = harness()
  const started = h.update('start', { minutes: 15 })
  assert.equal(isFocusSnapshotCurrent(started, accountA), true)
  assert.equal(isFocusSnapshotCurrent(started, accountB), false)
  assert.equal(isFocusSnapshotCurrent(started, { ...accountA, server: 'https://another.test/api/v1' }), false)
  assert.equal(isFocusSnapshotCurrent(started, { ...accountA, session: { generation: 3 } }), false)
  assert.equal(getFocusRemainingMs(started.state, h.now() - 60000), 900000)
  assert.equal(getFocusRemainingMs(started.state, h.now() + 1000000), 0)
})

for (const petType of ['cat', 'dog']) {
  test(`${petType} focus sessions survive pet switches without exposing another pet session`, () => {
    const h = harness()
    h.update('start', { minutes: 25, intention: 'Pig only' })
    const pigSnapshot = h.controller.current()
    const petContext = { ...accountA, petType }
    h.controller.setContext(petContext)
    assert.equal(h.controller.current().state.status, 'idle')
    assert.equal(isFocusSnapshotCurrent(pigSnapshot, petContext), false)
    assert.equal(h.update('start', { minutes: 15, intention: `${petType} only` }).ok, true)
    const petSnapshot = h.controller.current()
    assert.equal(isFocusSnapshotCurrent(petSnapshot, petContext), true)
    assert.equal(isFocusSnapshotCurrent(petSnapshot, accountA), false)
    h.controller.setContext(accountA)
    assert.equal(h.controller.current().state.intention, 'Pig only')
    h.controller.setContext(petContext)
    assert.equal(h.controller.current().state.intention, `${petType} only`)
    assert.notEqual(createFocusAccountKey(petContext), createFocusAccountKey(accountA))
  })
}

test('completed history is saved with state and survives reset, new sessions and clock checkpoints', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime(), independentClocks: true })
  const started = h.update('start', { minutes: 15, intention: 'Read one chapter' })
  assert.deepEqual(started.history, [])
  h.advance(15 * 60000)
  const history = [{ id: started.state.id, intention: 'Read one chapter', durationMs: 15 * 60000, completedAt: h.now() }]
  assert.deepEqual(h.controller.current().history, history)
  assert.deepEqual(h.completed[0].history, history)
  assert.deepEqual(h.writes.at(-1).state.history, history)
  assert.equal(h.writes.at(-1).state.status, 'completed')
  assert.equal(h.writes.length, 2, 'completion and history must be one write')
  assert.equal(Object.hasOwn(h.controller.current().state, 'history'), false)
  assert.deepEqual(normalizeFocusSession(h.writes.at(-1).state), h.controller.current().state)
  assert.deepEqual(h.update('reset').history, history)
  assert.deepEqual(h.update('start', { minutes: 25 }).history, history)
  h.advance(5 * 60000)
  h.adjustWall(60 * 60000)
  assert.deepEqual(h.controller.current().history, history)
  assert.deepEqual(h.update('pause').history, history)
  assert.deepEqual(h.update('resume').history, history)
  h.controller.dispose()
  assert.deepEqual(h.storage.get(createFocusAccountKey(accountA)).history, history)
  assert.deepEqual(h.update('reset').history, history, 'ending early must not add a completed record')
})

test('completed history deduplicates repeated reads, resume and restart without rewriting', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime() })
  h.update('start', { minutes: 15 })
  h.advance(15 * 60000)
  const history = h.controller.current().history
  const writes = h.writes.length
  h.controller.current()
  h.controller.resume()
  h.controller.dispose()
  assert.equal(h.writes.length, writes)
  const restarted = harness({ storage: h.storage, initialNow: h.now() })
  assert.deepEqual(restarted.controller.current().history, history)
  assert.equal(restarted.writes.length, 0)
  assert.equal(restarted.completed.length, 0)
  assert.equal(restarted.controller.current().history.length, 1)
})

test('a wall clock rollback preserves completed history until the clock is restored', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime(), independentClocks: true })
  h.update('start', { minutes: 15, intention: 'Already finished' })
  h.advance(15 * 60000)
  const history = h.controller.current().history
  const writes = h.writes.length
  h.adjustWall(-24 * 60 * 60000)
  assert.deepEqual(h.controller.current().history, history)
  assert.deepEqual(h.storage.get(createFocusAccountKey(accountA)).history, history)
  h.adjustWall(24 * 60 * 60000)
  assert.deepEqual(h.controller.current().history, history)
  assert.equal(h.writes.length, writes)
})

test('completed history survives reset and a temporary wall clock jump beyond the display window', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime(), independentClocks: true })
  h.update('start', { minutes: 15, intention: 'Keep the completed result' })
  h.advance(15 * 60000)
  const history = h.update('reset').history
  const writes = h.writes.length
  h.adjustWall(8 * 24 * 60 * 60000)
  assert.deepEqual(h.controller.current().history, history)
  assert.deepEqual(h.storage.get(createFocusAccountKey(accountA)).history, history)
  h.adjustWall(-8 * 24 * 60 * 60000)
  assert.deepEqual(h.controller.current().history, history)
  assert.equal(h.writes.length, writes)
})

test('legacy completed sessions are added once regardless of age without repeated writes', () => {
  const now = new Date(2026, 9, 24, 12).getTime()
  const completed = { ...emptyFocusSession(2), id: 'legacy', status: 'completed', intention: 'Before upgrade', durationMs: 15 * 60000, completedAt: now - 60000 }
  const storage = new Map([[createFocusAccountKey(accountA), completed]])
  const h = harness({ storage, initialNow: now })
  assert.deepEqual(h.controller.current().history, [{ id: 'legacy', intention: 'Before upgrade', durationMs: 15 * 60000, completedAt: completed.completedAt }])
  assert.equal(h.writes.length, 1)
  assert.equal(h.completed.length, 0)
  h.controller.current()
  assert.equal(h.writes.length, 1)
  const oldCompletedAt = new Date(2026, 9, 17, 23, 59).getTime()
  const old = harness({ storage: new Map([[createFocusAccountKey(accountA), { ...completed, completedAt: oldCompletedAt }]]), initialNow: now })
  assert.deepEqual(old.controller.current().history, [{ id: 'legacy', intention: 'Before upgrade', durationMs: 15 * 60000, completedAt: oldCompletedAt }])
  old.controller.current()
  assert.equal(old.writes.length, 1)
})

test('overdue hidden sessions and restart restoration record history without completion notifications', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime() })
  const started = h.update('start', { minutes: 15, intention: 'Account A only' })
  h.controller.setContext(accountB)
  h.advance(20 * 60000)
  assert.deepEqual(h.controller.current().history, [])
  const returned = h.controller.setContext(accountA)
  assert.equal(returned.history.length, 1)
  assert.equal(returned.history[0].completedAt, started.state.endsAt)
  assert.equal(h.completed.length, 0)
  const second = h.update('start', { minutes: 25, intention: 'Finish while closed' })
  h.controller.dispose()
  const restarted = harness({ storage: h.storage, initialNow: h.now() + 30 * 60000 })
  assert.equal(restarted.controller.current().history.length, 2)
  assert.equal(restarted.controller.current().history[0].completedAt, second.state.endsAt)
  assert.equal(restarted.completed.length, 0)
  assert.equal(restarted.writes.length, 1)
})

test('switching away and disposing silently record any already elapsed account', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime() })
  h.update('start', { minutes: 15 })
  h.advance(20 * 60000, { fire: false })
  h.controller.setContext(accountB)
  assert.equal(h.storage.get(createFocusAccountKey(accountA)).history.length, 1)
  h.update('start', { minutes: 15 })
  h.controller.setContext(accountA)
  h.advance(20 * 60000, { fire: false })
  h.controller.dispose()
  assert.equal(h.storage.get(createFocusAccountKey(accountB)).history.length, 1)
  assert.equal(h.completed.length, 0)
})

test('late settlement keeps the actual completion date across local midnight', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 23, 40).getTime() })
  const started = h.update('start', { minutes: 15 })
  h.advance(40 * 60000, { fire: false })
  const completed = h.controller.current().history[0]
  assert.equal(completed.completedAt, started.state.endsAt)
  assert.equal(new Date(completed.completedAt).getDate(), 24)
  assert.equal(new Date(h.now()).getDate(), 25)
  const older = harness({ storage: h.storage, initialNow: new Date(2026, 10, 1, 0, 1).getTime() })
  assert.deepEqual(older.controller.current().history, [completed])
  assert.equal(older.writes.length, 0)
  older.controller.current()
  assert.equal(older.writes.length, 0)
})

test('history validation rejects invalid records and deduplicates ids while keeping valid older dates', () => {
  const now = new Date(2026, 10, 3, 12).getTime()
  const oldest = new Date(2026, 9, 28, 0).getTime()
  const entry = { id: 'latest', intention: 'Valid', durationMs: 15 * 60000, completedAt: now - 1000 }
  const history = [
    { ...entry, completedAt: now - 2000 },
    { ...entry, id: 'oldest', completedAt: oldest },
    { ...entry, id: 'expired', completedAt: oldest - 1 },
    { ...entry, id: 'invalid-date', completedAt: 9e15 },
    { ...entry, id: 'infinite', completedAt: Infinity },
    { ...entry, id: 'not-a-number', completedAt: NaN },
    { ...entry, id: 'date-string', completedAt: new Date(now).toISOString() },
    { ...entry, id: 'duration-string', durationMs: '900000' },
    { ...entry, id: 'wrong-duration', durationMs: 60000 },
    { ...entry, id: 'wrong-intention', intention: null },
    { ...entry, id: '   ' },
    null, {}, entry,
  ]
  const h = harness({ storage: new Map([[createFocusAccountKey(accountA), { ...emptyFocusSession(), history }]]), initialNow: now })
  assert.deepEqual(h.controller.current().history, [entry, { ...entry, id: 'oldest', completedAt: oldest }, { ...entry, id: 'expired', completedAt: oldest - 1 }])
  assert.equal(h.writes.length, 1)
  h.controller.current()
  assert.equal(h.writes.length, 1)
  for (const badHistory of [null, {}, 'invalid']) {
    const invalid = harness({ storage: new Map([[createFocusAccountKey(accountA), { ...emptyFocusSession(), history: badHistory }]]), initialNow: now })
    assert.deepEqual(invalid.controller.current().history, [])
    assert.equal(invalid.writes.length, 1)
  }
})

test('history keeps only the latest 200 completions and does not rewrite them as time passes', () => {
  const now = new Date(2026, 9, 24, 12).getTime()
  const history = Array.from({ length: 205 }, (_, index) => ({ id: `history-${index}`, intention: '', durationMs: 25 * 60000, completedAt: now - index * 1000 })).reverse()
  const h = harness({ storage: new Map([[createFocusAccountKey(accountA), { ...emptyFocusSession(), history }]]), initialNow: now })
  const retained = h.controller.current().history
  assert.equal(retained.length, 200)
  assert.equal(retained[0].id, 'history-0')
  assert.equal(retained.at(-1).id, 'history-199')
  assert.equal(h.writes.length, 1)
  h.controller.current()
  assert.equal(h.writes.length, 1)
  h.advance(8 * 24 * 60 * 60000)
  assert.deepEqual(h.controller.current().history, retained)
  assert.equal(h.writes.length, 1)
  h.controller.current()
  assert.equal(h.writes.length, 1)
})

test('history stays isolated by account, server and pet and is empty after logout', () => {
  const h = harness({ initialNow: new Date(2026, 9, 24, 12).getTime() })
  const contexts = [accountA, accountB, { ...accountA, server: 'https://another.test/api/v1' }, { ...accountA, petType: 'cat' }, { ...accountA, petType: 'dog' }]
  for (const [index, context] of contexts.entries()) {
    assert.deepEqual(h.controller.setContext(context).history, [])
    h.update('start', { minutes: 15, intention: `Private ${index}` })
    h.advance(15 * 60000)
    assert.equal(h.controller.current().history.length, 1)
    assert.equal(h.controller.current().history[0].intention, `Private ${index}`)
  }
  for (const [index, context] of contexts.entries()) {
    const history = h.controller.setContext(context).history
    assert.equal(history.length, 1)
    assert.equal(history[0].intention, `Private ${index}`)
  }
  assert.deepEqual(h.controller.setContext({ ...accountA, hasSession: false }).history, [])
  assert.deepEqual(h.update('start', { minutes: 15 }).history, [])
  assert.deepEqual(h.controller.setContext({ ...accountA, petType: 'rabbit' }).history, [])
})
