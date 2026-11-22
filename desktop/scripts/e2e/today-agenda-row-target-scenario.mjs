import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship, createReminderRecord } from './fixtures.mjs'
import { expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 878, username: 'agenda-row-target', email: 'agenda-row-target@example.test', password: 'agenda-row-target-fixture-878' }
const AGENDA = '[data-e2e="today-reminder-agenda"]'
const ITEM = `${AGENDA} [data-e2e="today-agenda-item"]`
const MORE = `${AGENDA} [data-e2e="today-agenda-more"]`
const EARLIER = `${AGENDA} [data-e2e="today-agenda-earlier"]`
const EARLIER_GROUP = `${AGENDA} [data-e2e="today-agenda-earlier-group"]`
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
    const priorAt = (hour) => new Date(new Date(prior).setHours(hour, 0, 0, 0)).toISOString()
    return { now: Date.parse(at(12)), firstDelivered: at(8), delivered: at(9), nextDelivered: at(10), projected: at(14), later: at(16),
      earlierDelivered: priorAt(16), earlierRecurring: priorAt(17), earlier: priorAt(18), anotherEarlier: priorAt(19),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
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

function visibleAgendaIds(main) {
  return main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(ITEM)}))
    .filter((item) => item.checkVisibility()).map((item) => item.dataset.targetId)`)
}

async function pressKey(main, key, keyCode) {
  const event = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await main.send('Input.dispatchKeyEvent', key === 'Enter'
    ? { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...event }
    : { type: 'rawKeyDown', ...event })
  await main.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
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
  const firstDelivered = record('早餐后开窗', clock.firstDelivered)
  firstDelivered.triggered_at = clock.firstDelivered
  const nextDelivered = record('检查书包', clock.nextDelivered)
  nextDelivered.triggered_at = clock.nextDelivered
  const scheduled = record('晚一点整理书桌', clock.later)
  const earlier = record('之前留下的提醒', clock.earlier)
  const anotherEarlier = record('之前还没收好的书', clock.anotherEarlier)
  const earlierDelivered = record('昨天已提醒', clock.earlierDelivered)
  earlierDelivered.triggered_at = clock.earlierDelivered
  const earlierRecurring = record('昨天读两页', clock.earlierRecurring)
  const series = {
    id: 8781, user_id: OWNER.id, pet_type: 'pig', title: '每天读两页', status: 'active',
    recurrence_type: 'daily', timezone: clock.timezone, local_hour: 14, local_minute: 0, weekdays: [],
    next_occurrence_at: clock.projected,
  }
  earlierRecurring.series_id = series.id
  earlierRecurring.recurrence_type = series.recurrence_type
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [],
    reminders: [first, second, firstDelivered, nextDelivered, scheduled, earlier, anotherEarlier, earlierRecurring, earlierDelivered],
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
    await main.waitForSelector(MORE)
    const visibleIds = await visibleAgendaIds(main)
    assertEqual(visibleIds.length, 3, 'Today did not limit the first view to three reminders')
    assertEqual(visibleIds[0], String(firstDelivered.id), 'The earliest reminder should remain first')
    assertEqual(visibleIds.slice(1).sort().join(','), [first.id, second.id].map(String).sort().join(','),
      'Today did not show both reminders with the same title and time')
    await main.waitForSelector(reminderRow(DELIVERED, first.id))
    await main.waitForSelector(reminderRow(DELIVERED, second.id))
    const managerOrder = await main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${DELIVERED} [data-reminder-row-id]`)}),
      (row) => Number(row.dataset.reminderRowId))`)
    const sameTitleRows = managerOrder.filter((id) => id === first.id || id === second.id)
    assertEqual(sameTitleRows.length, 2, 'The delivered manager did not show both same-title fixture reminders')
    const selected = [first, second].find(({ id }) => id === sameTitleRows[1])
    assert(selected, 'Could not identify the second same-title row by ID')
    const remaining = selected === first ? second : first

    const requestStart = stub.requests.length
    const reminderWrites = () => stub.requests.slice(requestStart).filter(({ method, pathname }) =>
      !['GET', 'HEAD', 'OPTIONS'].includes(method) && [REMINDERS_API, SERIES_API].some((route) => pathname === route || pathname.startsWith(`${route}/`)))
    await main.evaluate(`document.querySelector(${JSON.stringify(MORE)}).focus()`)
    await pressKey(main, 'Enter', 13)
    await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(MORE)}).parentElement.open`),
      { description: 'keyboard expands more reminders in place' })
    const expandedIds = await visibleAgendaIds(main)
    assertEqual(expandedIds.join(','), [...visibleIds, nextDelivered.id, series.id, scheduled.id].join(','),
      'Expanded Today lost the order of delivered, recurring, or upcoming reminders')
    const overflowDeliveredItem = agendaItem(nextDelivered.id, 'delivered')
    const overflowDeliveredRow = reminderRow(DELIVERED, nextDelivered.id)
    await pressKey(main, 'Tab', 9)
    await waitFor(() => main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(overflowDeliveredItem)})`),
      { description: 'Tab reaches the first newly revealed reminder' })
    await pressKey(main, 'Enter', 13)
    await waitFor(() => main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(overflowDeliveredRow)})`),
      { description: 'keyboard opens the exact delivered row from the expanded list' })

    const seriesRow = `${RECURRING} [data-reminder-series-id="${series.id}"]`
    await main.waitForSelector(seriesRow)
    await clickAndFocus(main, agendaItem(series.id, 'projected'), seriesRow)
    await clickAndFocus(main, agendaItem(scheduled.id, 'scheduled'), reminderRow(UPCOMING, scheduled.id))

    await main.evaluate(`document.querySelector(${JSON.stringify(MORE)}).focus()`)
    await pressKey(main, 'Enter', 13)
    await waitFor(() => main.evaluate(`!document.querySelector(${JSON.stringify(MORE)}).parentElement.open`),
      { description: 'the same control collapses the additional reminders' })
    assertEqual((await visibleAgendaIds(main)).join(','), visibleIds.join(','), 'Collapsing changed the three visible reminders')
    await pressKey(main, 'Tab', 9)
    await waitFor(() => main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(EARLIER)})`),
      { description: 'Tab skips closed reminder rows' })
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(EARLIER)}).textContent.includes('4')`),
      'Earlier total does not include all unfinished categories')
    await pressKey(main, 'Enter', 13)
    await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(EARLIER)}).parentElement.open`),
      { description: 'keyboard expands mixed earlier reminders' })
    const earlierGroups = await main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(EARLIER_GROUP)}))
      .filter((node) => node.checkVisibility()).map((node) => ({ destination: node.dataset.destination, text: node.textContent }))`)
    const expectedGroups = [['delivered', DELIVERED, 1], ['recurring', RECURRING, 1], ['upcoming', UPCOMING, 2]]
    assertEqual(earlierGroups.length, expectedGroups.length, 'The disclosure did not show all earlier categories')
    for (const [index, [destination, target, count]] of expectedGroups.entries()) {
      assertEqual(earlierGroups[index].destination, destination, 'Earlier categories are not sorted by their oldest reminder')
      assert(earlierGroups[index].text.endsWith(`(${count})`), 'The earlier group shows the wrong count', earlierGroups[index])
      const group = `${EARLIER_GROUP}[data-destination="${destination}"]`
      await main.evaluate(`document.querySelector(${JSON.stringify(EARLIER)}).focus()`)
      for (let tab = 0; tab <= index; tab += 1) await pressKey(main, 'Tab', 9)
      await waitFor(() => main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(group)})`),
        { description: `Tab reaches the earlier ${destination} group` })
      await pressKey(main, 'Enter', 13)
      await waitFor(() => main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(target)})`),
        { description: `earlier group focuses ${target}` })
    }

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

    assertEqual((await visibleAgendaIds(main)).join(','), visibleIds.filter((id) => id !== String(selected.id)).concat(String(nextDelivered.id)).join(','),
      'The next reminder did not enter the compact list after completion')
    const writes = reminderWrites()
    assertEqual(writes.length, 1, 'Only the explicit completion may change a reminder')
    assertEqual(writes[0].method, 'POST', 'Completion must use the existing POST action')
    assertEqual(writes[0].pathname, `${REMINDERS_API}/${selected.id}/complete`, 'Completion targeted the wrong reminder ID')
    return { sameTitleIdentity: true, selectedCompletionOnly: true, projectedSeriesFocus: true, upcomingRowFocus: true, aggregateSectionFocus: true, keyboardDisclosure: true, mixedOverflowOrder: true, mixedEarlierGroups: true }
  } finally {
    restoreSeries()
    await main.evaluate("window.restoreAgendaRowTargetClock?.(); window.dispatchEvent(new Event('focus'))")
  }
}
