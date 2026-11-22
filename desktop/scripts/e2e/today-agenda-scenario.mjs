import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship, createReminderRecord } from './fixtures.mjs'
import { expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = Object.freeze({ id: 874, username: 'today-agenda-owner', email: 'today-agenda@example.test', password: 'today-agenda-fixture-874' })
const AGENDA = '[data-e2e="today-reminder-agenda"]'
const ITEM = '[data-e2e="today-agenda-item"]'
const EARLIER = '[data-e2e="today-agenda-earlier"]'
const SERIES = '/api/v1/reminder-series'

function getFixtureSchedule(main) {
  // A day ahead keeps the real pet timer from consuming the test rows before the user acts.
  return main.evaluate(`(() => {
    const day = new Date()
    day.setDate(day.getDate() + 2)
    const at = (hour) => new Date(new Date(day).setHours(hour, 0, 0, 0)).toISOString()
    const prior = new Date(day)
    prior.setDate(prior.getDate() - 1)
    prior.setHours(18, 0, 0, 0)
    return {
      now: Date.parse(at(12)), delivered: at(9), scheduled: at(14), projected: at(16), earlier: prior.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  })()`)
}

function showAgendaDay(main, now) {
  return main.evaluate(`(() => {
    const original = Date.now
    window.restoreAgendaClock = () => { Date.now = original; delete window.restoreAgendaClock }
    Date.now = () => ${JSON.stringify(now)}
    window.dispatchEvent(new Event('focus'))
  })()`)
}

function readAgendaRows(main) {
  return main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(ITEM)}), (node) => ({
    status: node.dataset.status, destination: node.dataset.destination,
    time: node.querySelector('time')?.dateTime, text: node.textContent,
  }))`)
}

export async function todayAgendaScenario(context) {
  const { main } = context.pages
  const { stub } = context
  const clock = await getFixtureSchedule(main)
  const relation = createRelationship(OWNER, 'pig')
  const record = (title, remindAt, petType = 'pig') => createReminderRecord({
    user: OWNER, petType, id: stub.fixture.nextReminderId++, title, remindAt: new Date(remindAt),
  })
  const delivered = record('已提醒待完成', clock.delivered)
  delivered.triggered_at = clock.delivered
  const scheduled = record('下午记得喝水', clock.scheduled)
  const earlier = record('昨天还没有做完', clock.earlier)
  const otherPet = record('猫咪独有的提醒', clock.scheduled, 'cat')
  const projected = {
    id: 8741, user_id: OWNER.id, pet_type: 'pig', title: '每日傍晚休息',
    status: 'active', recurrence_type: 'daily', timezone: clock.timezone,
    local_hour: 16, local_minute: 0, weekdays: [], next_occurrence_at: clock.projected,
  }
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relation]]), sessions: [], documents: [],
    reminders: [delivered, scheduled, earlier, otherPet],
  })
  const restoreSeries = stub.overrideResponse('GET', SERIES, 200, [projected])
  try {
    await resetToLoggedOut(context)
    await loginAs(context, OWNER)
    await expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id
      && snapshot.renderer?.[0]?.relationshipId === relation.id, 'today agenda reads the active account and pet')
    await main.waitForSelector(`${AGENDA}[data-state="empty"]`)

    const refreshStart = stub.requests.length
    await showAgendaDay(main, clock.now)
    await main.waitForSelector(`${AGENDA}[data-state="ready"]`)
    const rows = await readAgendaRows(main)
    const expected = [
      { status: 'delivered', destination: 'delivered', time: clock.delivered, title: delivered.title },
      { status: 'scheduled', destination: 'upcoming', time: clock.scheduled, title: scheduled.title },
      { status: 'projected', destination: 'recurring', time: clock.projected, title: projected.title },
    ]
    assertEqual(rows.length, expected.length, 'Out-of-scope or earlier reminder appeared as a today row')
    for (const [index, item] of expected.entries()) {
      assertEqual(rows[index].status, item.status, 'Unexpected today status or sort order')
      assertEqual(rows[index].destination, item.destination, 'Today row points to the wrong manager')
      assertEqual(rows[index].time, item.time, 'Today row shows a different scheduled instant')
      assert(rows[index].text.includes(item.title), 'Today row shows the wrong reminder title')
    }
    assert(await main.evaluate(`!document.querySelector(${JSON.stringify(AGENDA)}).textContent.includes(${JSON.stringify(otherPet.title)})`), 'Today agenda includes a different pet’s reminder')
    await waitFor(() => stub.requests.slice(refreshStart).some((request) => request.method === 'GET' && request.pathname === SERIES), {
      description: 'a device calendar change refreshes the existing reminder sources',
    })

    const navigationStart = stub.requests.length
    for (const [control, section] of [
      [`${ITEM}[data-status="scheduled"]`, 'upcoming-reminders'],
      [`${ITEM}[data-status="projected"]`, 'recurring-reminders'],
      [EARLIER, 'upcoming-reminders'],
      [`${ITEM}[data-status="delivered"]`, 'delivered-reminders'],
    ]) {
      await main.click(control)
      await waitFor(() => main.evaluate(`document.activeElement?.id === ${JSON.stringify(section)}`), { description: `agenda focuses ${section}` })
    }
    assert(!stub.requests.slice(navigationStart).some((request) => request.method === 'POST' && request.pathname.startsWith('/api/v1/reminders')), 'Navigation mutated reminders')

    await main.click(REQUIRED_SELECTORS.pendingReminderComplete.replace('{id}', String(delivered.id)))
    await waitFor(() => delivered.status === 'completed', { description: 'manager records completion through the API' })
    await waitFor(async () => (await readAgendaRows(main)).map(({ status }) => status).join(',') === 'scheduled,projected', {
      description: 'completion updates today’s agenda without manual refresh',
    })
    const completion = `/api/v1/reminders/${delivered.id}/complete`
    assertEqual(stub.requests.slice(navigationStart).filter((request) => request.method === 'POST' && request.pathname === completion).length, 1,
      'Completing the delivered reminder issued more than one request')
    await main.evaluate(`document.querySelector(${JSON.stringify(AGENDA)}).scrollIntoView({ block: 'center' })`)
    const screenshot = await main.screenshot(join(context.artifactPath, 'today-agenda.png'))
    return { deviceDayRefresh: true, sortedAndScoped: true, earlierRoutesToManager: true, allTodayRoutesFocused: true, liveCompletion: true, screenshot }
  } finally {
    restoreSeries()
    await main.evaluate("window.restoreAgendaClock?.(); window.dispatchEvent(new Event('focus'))")
  }
}
