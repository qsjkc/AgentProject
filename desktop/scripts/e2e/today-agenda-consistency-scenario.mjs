import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship, createReminderRecord } from './fixtures.mjs'
import { expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 877, username: 'agenda-consistency', email: 'agenda-consistency@example.test', password: 'agenda-consistency-fixture-877' }
const AGENDA = '[data-e2e="today-reminder-agenda"]'
const ITEM = '[data-e2e="today-agenda-item"]'
const SERIES = '/api/v1/reminder-series'
const REMINDERS = '/api/v1/reminders'

function getSchedule(main) {
  // Only Today sees the simulated local date. The real pet clock cannot deliver the occurrence.
  return main.evaluate(`(() => {
    const today = new Date()
    today.setDate(today.getDate() + 2)
    today.setHours(16, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const now = new Date(today).setHours(12)
    return { now, occurrence: today.toISOString(), next: tomorrow.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  })()`)
}

function setAgendaClock(main, now) {
  return main.evaluate(`(() => {
    const original = Date.now
    window.restoreAgendaConsistencyClock = () => { Date.now = original; delete window.restoreAgendaConsistencyClock }
    Date.now = () => ${JSON.stringify(now)}
  })()`)
}

function waitForRow(main, instant, status) {
  return waitFor(() => main.evaluate(`(() => {
    const agenda = document.querySelector(${JSON.stringify(AGENDA)})
    const items = Array.from(agenda?.querySelectorAll(${JSON.stringify(ITEM)}) || [])
    const [item] = items
    return agenda?.dataset.state === 'ready' && items.length === 1 && item.dataset.status === ${JSON.stringify(status)}
      && item.querySelector('time')?.dateTime === ${JSON.stringify(instant)} ? item.textContent : null
  })()`), { description: `one ${status} agenda row at ${instant}` })
}

function observeAgenda(main, instant) {
  return main.evaluate(`(() => {
    const selector = ${JSON.stringify(AGENDA)}
    const evidence = { empty: false, duplicate: false }
    const inspect = (records) => {
      const agenda = document.querySelector(selector)
      evidence.empty ||= agenda?.dataset.state === 'empty' || records.some((record) => (
        record.attributeName === 'data-state' && record.oldValue === 'empty' && record.target.matches(selector)
      ))
      const times = Array.from(agenda?.querySelectorAll(${JSON.stringify(`${ITEM} time`)}) || [])
      evidence.duplicate ||= times.filter(({ dateTime }) => dateTime === ${JSON.stringify(instant)}).length > 1
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.getElementById('companion-today'), {
      subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'], attributeOldValue: true,
    })
    window.readAgendaConsistencyEvidence = () => { inspect(observer.takeRecords()); return evidence }
    window.stopAgendaConsistencyObserver = () => {
      observer.disconnect()
      delete window.readAgendaConsistencyEvidence
      delete window.stopAgendaConsistencyObserver
    }
  })()`)
}

function isAggregatePendingRead({ method, pathname, search }) {
  if (method !== 'GET' || pathname !== REMINDERS) return false
  const params = new URLSearchParams(search)
  return params.get('pet_type') === 'pig' && params.get('status') === 'pending' && !params.has('triggered')
}

export async function todayAgendaConsistencyScenario(context) {
  const { main } = context.pages
  const { stub } = context
  const clock = await getSchedule(main)
  const series = {
    id: 8771, user_id: OWNER.id, pet_type: 'pig', title: '每天整理读书笔记',
    status: 'active', recurrence_type: 'daily', timezone: clock.timezone,
    local_hour: 16, local_minute: 0, weekdays: [], next_occurrence_at: clock.occurrence, next_sequence: 2,
  }
  const relationship = createRelationship(OWNER, 'pig')
  const reminders = []
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [], reminders,
  })
  const restoreSeries = stub.overrideResponse('GET', SERIES, 200, [series])
  const holds = []
  try {
    await resetToLoggedOut(context)
    await loginAs(context, OWNER)
    await expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id
      && snapshot.account?.petType === 'pig' && snapshot.renderer?.[0]?.relationshipId === relationship.id,
    'Today agenda uses the fixture account and pet')
    await main.waitForSelector(`${AGENDA}[data-state="empty"]`)
    await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
    await main.waitForSelector(`${REQUIRED_SELECTORS.mainTabKnowledge}[aria-pressed="true"]`)
    await setAgendaClock(main, clock.now)
    await main.click('[data-e2e="main-open-today"]')
    assert((await waitForRow(main, clock.occurrence, 'projected')).includes(series.title), 'Today did not show the planned occurrence')
    await observeAgenda(main, clock.occurrence)

    const requestsStart = stub.requests.length
    // Agenda and the recurring manager can both read this path. Neither may read the old series after invalidation.
    holds.push(stub.holdNext('GET', SERIES), stub.holdNext('GET', SERIES))
    let held = false
    void holds[0].arrived.then(() => { held = true })
    await main.evaluate("window.dispatchEvent(new Event('detachym:reminder-series-changed'))")
    await waitFor(() => held, { description: 'a series response is held during Today refresh' })

    // Advance the cursor and insert its instance together, as the recurrence worker does in a single transaction.
    const occurrence = createReminderRecord({
      id: stub.fixture.nextReminderId++, user: OWNER, title: series.title, remindAt: new Date(clock.occurrence),
    })
    Object.assign(occurrence, { series_id: series.id, recurrence_type: 'daily', occurrence_sequence: series.next_sequence, creation_source: 'recurrence' })
    const releaseIndex = stub.requests.length
    assertEqual(stub.requests.slice(requestsStart, releaseIndex).filter(isAggregatePendingRead).length, 0,
      'Today read pending reminders before the series response was released')
    reminders.push(occurrence)
    series.next_occurrence_at = clock.next
    series.next_sequence += 1
    for (const hold of holds) hold.release()

    assert((await waitForRow(main, clock.occurrence, 'scheduled')).includes(series.title), 'Materialization changed the reminder shown in Today')
    assert(stub.requests.slice(releaseIndex).some(isAggregatePendingRead), 'Today did not read the pending snapshot after the series barrier')
    const evidence = await main.evaluate('window.readAgendaConsistencyEvidence()')
    assertEqual(evidence.empty, false, 'Today briefly claimed it had no reminders during materialization')
    assertEqual(evidence.duplicate, false, 'Today showed both the projection and the materialized reminder')
    const writes = stub.requests.slice(requestsStart).filter(({ method, pathname }) => !['GET', 'HEAD', 'OPTIONS'].includes(method)
      && [REMINDERS, SERIES].some((route) => pathname === route || pathname.startsWith(`${route}/`)))
    assertEqual(writes.length, 0, 'Refreshing the agenda modified reminders through the API')
    return { serializedPendingRead: true, oneOccurrenceAtSameInstant: true, noFalseEmpty: true, reminderWrites: writes.length }
  } finally {
    for (const hold of holds) hold.release()
    restoreSeries()
    await main.evaluate("window.stopAgendaConsistencyObserver?.(); window.restoreAgendaConsistencyClock?.(); window.dispatchEvent(new Event('focus'))")
  }
}
