import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship, createReminderRecord } from './fixtures.mjs'
import { expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 878, username: 'agenda-row-target', email: 'agenda-row-target@example.test', password: 'agenda-row-target-fixture-878' }
const AGENDA = '[data-e2e="today-reminder-agenda"]'
const ITEM = `${AGENDA} [data-e2e="today-agenda-item"]`
const DELIVERED = '#delivered-reminders'
const UPCOMING = '#upcoming-reminders'
const RECURRING = '#recurring-reminders'
const REMINDERS_API = '/api/v1/reminders'
const SERIES_API = '/api/v1/reminder-series'

function getSchedule(main) {
  // Keep fixture times in the future for the pet process while testing a specific device-local day.
  return main.evaluate(`(() => {
    const day = new Date()
    day.setDate(day.getDate() + 2)
    const at = (hour) => new Date(new Date(day).setHours(hour, 0, 0, 0)).toISOString()
    const prior = new Date(day)
    prior.setDate(prior.getDate() - 1)
    prior.setHours(18, 0, 0, 0)
    return { now: Date.parse(at(12)), delivered: at(9), projected: at(14), later: at(16),
      earlier: prior.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  })()`)
}

function showAgendaDay(main, now) {
  return main.evaluate(`(() => {
    const original = Date.now
    window.restoreAgendaRowTargetClock = () => { Date.now = original; delete window.restoreAgendaRowTargetClock }
    Date.now = () => ${JSON.stringify(now)}
    window.dispatchEvent(new Event('focus'))
  })()`)
}

function agendaItem(id, status) {
  return `${ITEM}[data-status="${status}"][data-target-id="${id}"]`
}

function reminderRow(section, id) {
  return `${section} [data-reminder-row-id="${id}"]`
}

async function clickAndFocus(main, control, target) {
  await main.click(control)
  await waitFor(() => main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(target)})`),
    { description: `agenda focuses ${target}` })
}

export async function todayAgendaRowTargetScenario(context) {
  const { main } = context.pages
  const { stub } = context
  const clock = await getSchedule(main)
  const relationship = createRelationship(OWNER, 'pig')
  const record = (title, time) => createReminderRecord({
    id: stub.fixture.nextReminderId++, user: OWNER, title, remindAt: new Date(time),
  })
  const sharedTitle = '喝杯温水'
  const first = record(sharedTitle, clock.delivered)
  const second = record(sharedTitle, clock.delivered)
  first.triggered_at = clock.delivered
  second.triggered_at = clock.delivered
  const scheduled = record('晚一点整理书桌', clock.later)
  const earlier = record('之前留下的提醒', clock.earlier)
  const series = {
    id: 8781, user_id: OWNER.id, pet_type: 'pig', title: '每天读两页', status: 'active',
    recurrence_type: 'daily', timezone: clock.timezone, local_hour: 14, local_minute: 0, weekdays: [],
    next_occurrence_at: clock.projected,
  }
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [],
    reminders: [first, second, scheduled, earlier],
  })
  const restoreSeries = stub.overrideResponse('GET', SERIES_API, 200, [series])
  try {
    await resetToLoggedOut(context)
    await loginAs(context, OWNER)
    await expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id
      && snapshot.account?.petType === 'pig' && snapshot.renderer?.[0]?.relationshipId === relationship.id,
    'Today reminder navigation uses the signed-in account and pet')
    await main.waitForSelector(`${AGENDA}[data-state="empty"]`)
    await showAgendaDay(main, clock.now)
    await main.waitForSelector(agendaItem(series.id, 'projected'))
    const visibleIds = await main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(ITEM)}), (item) => item.dataset.targetId)`)
    assertEqual(visibleIds.length, 3, 'Today did not limit the first view to three reminders')
    assertEqual(visibleIds[2], String(series.id), 'The future series should follow both delivered reminders')
    assertEqual(visibleIds.slice(0, 2).sort().join(','), [first.id, second.id].map(String).sort().join(','),
      'Today did not show both reminders with the same title and time')
    await main.waitForSelector(reminderRow(DELIVERED, first.id))
    await main.waitForSelector(reminderRow(DELIVERED, second.id))
    const managerOrder = await main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${DELIVERED} [data-reminder-row-id]`)}),
      (row) => Number(row.dataset.reminderRowId))`)
    assertEqual(managerOrder.length, 2, 'The delivered manager did not show both same-title fixture reminders')
    const selected = [first, second].find(({ id }) => id === managerOrder[1])
    assert(selected, 'Could not identify the second same-title row by ID')
    const remaining = selected === first ? second : first

    const requestStart = stub.requests.length
    const reminderWrites = () => stub.requests.slice(requestStart).filter(({ method, pathname }) =>
      !['GET', 'HEAD', 'OPTIONS'].includes(method) && [REMINDERS_API, SERIES_API].some((route) => pathname === route || pathname.startsWith(`${route}/`)))
    await clickAndFocus(main, `${AGENDA} [data-e2e="today-agenda-more"]`, UPCOMING)
    await clickAndFocus(main, `${AGENDA} [data-e2e="today-agenda-earlier"]`, UPCOMING)
    const seriesRow = `${RECURRING} [data-reminder-series-id="${series.id}"]`
    await main.waitForSelector(seriesRow)
    await clickAndFocus(main, agendaItem(series.id, 'projected'), seriesRow)

    const selectedRow = reminderRow(DELIVERED, selected.id)
    await clickAndFocus(main, agendaItem(selected.id, 'delivered'), selectedRow)
    assertEqual(reminderWrites().length, 0, 'Agenda navigation changed reminder data')
    const complete = REQUIRED_SELECTORS.pendingReminderComplete.replace('{id}', String(selected.id))
    await main.click(`${selectedRow} ${complete}`)
    await waitFor(() => selected.status === 'completed', { description: 'the selected reminder is completed through the API' })
    await waitFor(() => main.evaluate(`(() => {
      const has = (selector) => Boolean(document.querySelector(selector))
      return !has(${JSON.stringify(selectedRow)}) && !has(${JSON.stringify(agendaItem(selected.id, 'delivered'))})
        && has(${JSON.stringify(reminderRow(DELIVERED, remaining.id))}) && has(${JSON.stringify(agendaItem(remaining.id, 'delivered'))})
    })()`), { description: 'the other same-title reminder stays in Today and in the manager' })
    assertEqual(remaining.status, 'pending', 'Completing the selected reminder changed the other same-title record')

    const newVisibleItem = agendaItem(scheduled.id, 'scheduled')
    await main.waitForSelector(newVisibleItem)
    await clickAndFocus(main, newVisibleItem, reminderRow(UPCOMING, scheduled.id))
    const writes = reminderWrites()
    assertEqual(writes.length, 1, 'Only the explicit completion may change a reminder')
    assertEqual(writes[0].method, 'POST', 'Completion must use the existing POST action')
    assertEqual(writes[0].pathname, `${REMINDERS_API}/${selected.id}/complete`, 'Completion targeted the wrong reminder ID')
    return { sameTitleIdentity: true, selectedCompletionOnly: true, projectedSeriesFocus: true, upcomingRowFocus: true, aggregateSectionFocus: true }
  } finally {
    restoreSeries()
    await main.evaluate("window.restoreAgendaRowTargetClock?.(); window.dispatchEvent(new Event('focus'))")
  }
}
