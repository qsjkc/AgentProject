import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { expectSnapshot, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = Object.freeze({ id: 875, username: 'today-recurring-owner', email: 'today-recurring@example.test', password: 'today-recurring-fixture-875' })
const DEVICE_ZONE = 'America/New_York'
const WALL_TIME = '08:45'
const LANGUAGE = '.main-header-language select'
const TOGGLE = '[data-e2e="today-reminder-toggle"]'
const FORM = '[data-e2e="today-reminder-form"]'
const TITLE = '[data-e2e="today-reminder-title"]'
const REPEAT = '[data-e2e="today-reminder-repeat"]'
const REPEAT_TIME = '[data-e2e="today-reminder-repeat-time"]'
const FIRST_TIME = '[data-e2e="today-reminder-first"] time'
const SAVE = '[data-e2e="today-reminder-save"]'
const CONFIRMED_TIME = '[data-e2e="today-reminder-success"] time'

function readControl(main, selector, property = 'value') {
  return main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.[${JSON.stringify(property)}]`)
}

function setControl(main, selector, value) {
  return main.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, ${JSON.stringify(value)})
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

function simulateFridayAfternoon(main) {
  // Choose a full week ahead so the ordinary pet clock never sees the test reminder as due.
  // Only this renderer changes clocks and the real login finishes first.
  return main.evaluate(`(() => {
    const friday = new Date()
    friday.setDate(friday.getDate() + (5 - friday.getDay() + 7) % 7 + 7)
    friday.setHours(16, 15, 0, 0)
    const monday = new Date(friday)
    monday.setDate(monday.getDate() + 3)
    monday.setHours(8, 45, 0, 0)
    const original = Date.now
    window.restoreRecurringReminderClock = () => { Date.now = original; delete window.restoreRecurringReminderClock }
    Date.now = () => friday.getTime()
    window.dispatchEvent(new Event('focus'))
    return { first: monday.toISOString(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  })()`)
}

export async function todayRecurringReminderScenario(context) {
  const { main } = context.pages
  const { stub } = context
  const relationship = createRelationship(OWNER, 'pig')
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id
    && snapshot.renderer?.[0]?.relationshipId === relationship.id, 'recurring composer uses the signed-in pet')

  const initialLanguage = await readControl(main, LANGUAGE)
  const requestsStart = stub.requests.length
  const posts = () => stub.requests.slice(requestsStart).filter((request) => request.method === 'POST' && request.pathname === '/api/v1/reminders')
  const title = '工作日晨间喝水'
  await main.send('Emulation.setTimezoneOverride', { timezoneId: DEVICE_ZONE })
  try {
    const schedule = await simulateFridayAfternoon(main)
    assertEqual(schedule.zone, DEVICE_ZONE, 'Renderer did not adopt the test device zone')
    await setControl(main, LANGUAGE, 'zh-CN')
    await waitFor(async () => (await readControl(main, TOGGLE, 'textContent'))?.trim() === '添加提醒', { description: 'Chinese reminder entry' })
    await main.click(TOGGLE)
    await main.waitForSelector(`#companion-today ${FORM} ${REPEAT}`)
    assertEqual(await readControl(main, REPEAT), 'once', 'Reminder composer did not default to once')
    await main.waitForSelector(`${REPEAT} option[value="weekdays"]`, { visible: false })
    assertEqual((await readControl(main, `${REPEAT} option[value="weekdays"]`, 'textContent')).trim(), '每周一至周五', 'Missing Chinese weekday label')
    await main.input(TITLE, title)

    await setControl(main, REPEAT, 'daily')
    await main.waitForSelector(REPEAT_TIME)
    assertEqual(await readControl(main, TITLE), title, 'Switching to every day discarded the title')
    await setControl(main, REPEAT, 'weekdays')
    await waitFor(async () => (await readControl(main, REPEAT)) === 'weekdays', { description: 'weekdays explicitly selected' })
    assertEqual(await readControl(main, TITLE), title, 'Switching to weekdays discarded the title')
    await setControl(main, REPEAT_TIME, WALL_TIME)

    await setControl(main, LANGUAGE, 'en')
    await waitFor(async () => /weekday/i.test(await readControl(main, `${REPEAT} option[value="weekdays"]`, 'textContent')),
      { description: 'English weekday label' })
    await waitFor(async () => (await readControl(main, FIRST_TIME, 'dateTime')) === schedule.first,
      { description: 'Friday afternoon previews Monday at the requested local time' })
    assert((await readControl(main, FIRST_TIME, 'textContent')).includes('8:45'), 'The first date preview shows a different wall time')
    assertEqual(posts().length, 0, 'Opening, changing frequency, or picking a time submitted the reminder')

    await main.click(SAVE)
    await main.waitForSelector(CONFIRMED_TIME)
    assertEqual(posts().length, 1, 'Explicit confirmation did not issue exactly one reminder POST')
    const request = JSON.parse(posts()[0].body)
    assertEqual(request.title, title, 'Saved recurring reminder lost its title')
    assertEqual(request.pet_type, 'pig', 'Saved recurring reminder used the wrong pet')
    assertEqual(request.recurrence_type, 'weekdays', 'API request did not preserve weekdays')
    assertEqual(request.recurrence_timezone, DEVICE_ZONE, 'API request did not preserve the actual device zone')
    assertEqual(request.email_enabled, false, 'Recurring reminder enabled email without consent')
    assertEqual(request.remind_at, schedule.first, 'API request did not preserve the first Monday instant')
    assertEqual(await readControl(main, CONFIRMED_TIME, 'dateTime'), schedule.first, 'Success did not confirm the first Monday instant')
    assert((await readControl(main, CONFIRMED_TIME, 'textContent')).includes('8:45'), 'The success message shows a different wall time')

    // The browser stub verifies the wire contract and result rendering. Real series lifecycle is a backend acceptance case.
    const screenshot = await main.screenshot(join(context.artifactPath, 'today-recurring-reminder-saved.png'))
    return { retainedTitle: true, explicitSave: true, weekdayRollForward: true, deviceZone: DEVICE_ZONE, wallTime: WALL_TIME, confirmationMatches: true, screenshot }
  } finally {
    await main.evaluate("window.restoreRecurringReminderClock?.(); window.dispatchEvent(new Event('focus'))")
    await main.send('Emulation.setTimezoneOverride', { timezoneId: '' })
    await setControl(main, LANGUAGE, initialLanguage)
  }
}
