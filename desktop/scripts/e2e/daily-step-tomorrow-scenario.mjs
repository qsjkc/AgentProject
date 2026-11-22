import { assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { expectSnapshot, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 880, username: 'tomorrow-step-owner', email: 'tomorrow-step-owner@example.test', password: 'tomorrow-step-fixture-880' }
const TODAY = '#companion-today [data-e2e="daily-step"]'
const TODAY_INPUT = `${TODAY} [data-e2e="daily-step-input"]`
const TODAY_TITLE = `${TODAY} [data-e2e="daily-step-title"]`
const TOMORROW = `${TODAY} [data-e2e="daily-step-tomorrow"]`
const TOMORROW_INPUT = `${TODAY} [data-e2e="daily-step-tomorrow-input"]`
const TOMORROW_SAVE = `${TODAY} [data-e2e="daily-step-tomorrow-save"]`
const TOMORROW_CANCEL = `${TODAY} [data-e2e="daily-step-tomorrow-cancel"]`
const TOMORROW_TITLE = `${TODAY} [data-e2e="daily-step-tomorrow-title"]`
const TOMORROW_REMOVE = `${TODAY} [data-e2e="daily-step-tomorrow-remove"]`
const HISTORY = `${TODAY} [data-e2e="daily-step-history"]`
const HISTORY_ROWS = `${HISTORY} [data-e2e="daily-step-history-row"]`

function localDates(main) {
  return main.evaluate(`(() => {
    const stamp = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
    const day = new Date()
    const today = stamp(day)
    day.setDate(day.getDate() + 1)
    return { today, tomorrow: stamp(day), nextNoon: day.setHours(12, 0, 0, 0) }
  })()`)
}

function simulateNextDay(main, now) {
  return main.evaluate(`(() => {
    const originalNow = Date.now
    window.restoreTomorrowStepClock = () => { Date.now = originalNow; delete window.restoreTomorrowStepClock }
    Date.now = () => ${JSON.stringify(now)}
    window.dispatchEvent(new Event('focus'))
  })()`)
}

function waitForScope(main, petType) {
  return expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id
    && snapshot.account?.petType === petType && snapshot.renderer?.[0]?.userId === OWNER.id
    && snapshot.renderer?.[0]?.petType === petType && snapshot.renderer?.[0]?.relationshipId === createRelationship(OWNER, petType).id,
  `the daily step uses account ${OWNER.id}/${petType}`)
}

async function selectPet(main, petType) {
  const selector = `[data-e2e="pet-option-${petType}"]`
  await main.click(`${selector}:enabled`)
  await waitForScope(main, petType)
}

function expectTodayStep(main, state, title = null) {
  return waitFor(() => main.evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(TODAY)})
    const title = document.querySelector(${JSON.stringify(TODAY_TITLE)})?.textContent.trim() ?? null
    return panel?.dataset.state === ${JSON.stringify(state)} && title === ${JSON.stringify(title)}
  })()`), { description: `the current day is ${state}${title ? ` with ${title}` : ''}` })
}

function expectTomorrowTitle(main, title) {
  return waitFor(() => main.evaluate(`(document.querySelector(${JSON.stringify(TOMORROW_TITLE)})?.textContent.trim() ?? null) === ${JSON.stringify(title)}`),
    { description: title ? `tomorrow shows ${title}` : 'tomorrow has no saved title' })
}

async function readHistory(main) {
  await main.waitForSelector(`${HISTORY} > summary`)
  if (!await main.evaluate(`document.querySelector(${JSON.stringify(HISTORY)})?.open`)) await main.click(`${HISTORY} > summary`)
  await main.waitForSelector(`${HISTORY}[open] [data-e2e="daily-step-history-row"]`)
  return main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(HISTORY_ROWS)}), (row) => ({
    date: row.querySelector('time')?.dateTime, text: row.textContent,
  }))`)
}

export async function dailyStepTomorrowScenario(context) {
  const { main } = context.pages
  const { stub } = context
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map(['pig', 'cat'].map((petType) => [petType, createRelationship(OWNER, petType)])),
    sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await waitForScope(main, 'pig')
  await expectTodayStep(main, 'empty')

  const current = '整理今天的读书笔记'
  const initialPlan = '写三行随笔'
  const revisedPlan = '写下一段随笔'
  const calendar = await localDates(main)
  await main.input(TODAY_INPUT, current)
  await main.click(`${TODAY} [data-e2e="daily-step-save"]`)
  await expectTodayStep(main, 'planned', current)
  await main.click(`${TODAY} [data-e2e="daily-step-complete"]`)
  await expectTodayStep(main, 'completed', current)

  const requestsStart = stub.requests.length
  await main.click(TOMORROW)
  await main.waitForSelector(TOMORROW_INPUT)
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(TOMORROW_INPUT)})?.value`), '',
    'The tomorrow editor inherited the completed title')
  await main.input(TOMORROW_INPUT, initialPlan)
  await main.click(TOMORROW_CANCEL)
  await expectTomorrowTitle(main, null)
  await main.click(TOMORROW)
  await main.input(TOMORROW_INPUT, initialPlan)
  await main.click(TOMORROW_SAVE)
  await expectTomorrowTitle(main, initialPlan)
  await main.waitForSelector(`${TODAY} time[datetime="${calendar.tomorrow}"]`)
  await expectTodayStep(main, 'completed', current)

  await main.click(TOMORROW)
  await main.waitForSelector(TOMORROW_INPUT)
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(TOMORROW_INPUT)})?.value`), initialPlan,
    'Editing tomorrow did not open the saved title')
  await main.input(TOMORROW_INPUT, revisedPlan)
  await main.click(TOMORROW_SAVE)
  await expectTomorrowTitle(main, revisedPlan)
  await expectTodayStep(main, 'completed', current)

  await main.click(TOMORROW_REMOVE)
  await expectTomorrowTitle(main, null)
  await expectTodayStep(main, 'completed', current)
  await main.click(TOMORROW)
  await main.input(TOMORROW_INPUT, revisedPlan)
  await main.click(TOMORROW_SAVE)
  await expectTomorrowTitle(main, revisedPlan)

  await main.reload()
  await waitForScope(main, 'pig')
  await expectTodayStep(main, 'completed', current)
  await expectTomorrowTitle(main, revisedPlan)
  await selectPet(main, 'cat')
  await expectTodayStep(main, 'empty')
  await expectTomorrowTitle(main, null)
  await selectPet(main, 'pig')
  await expectTodayStep(main, 'completed', current)
  await expectTomorrowTitle(main, revisedPlan)

  try {
    await simulateNextDay(main, calendar.nextNoon)
    await expectTodayStep(main, 'planned', revisedPlan)
    await expectTomorrowTitle(main, null)
    const previous = await readHistory(main)
    assertEqual(previous.length, 1, 'Planning tomorrow changed the earlier completion history')
    assertEqual(previous[0].date, calendar.today, 'The old completion moved away from its original local day')
    assertEqual(previous[0].text.includes(current), true, 'The old completion lost its original title')
    await main.click(`${TODAY} [data-e2e="daily-step-complete"]`)
    await expectTodayStep(main, 'completed', revisedPlan)
    const completed = await readHistory(main)
    assertEqual(completed.length, 2, 'Completing the new day should retain both completed steps')
    assertEqual(completed.some(({ date, text }) => date === calendar.today && text.includes(current)), true,
      'Completing the new day changed the original completion')
    assertEqual(completed.some(({ date, text }) => date === calendar.tomorrow && text.includes(revisedPlan)), true,
      'The plan did not complete on its intended local day')
  } finally {
    await main.evaluate("window.restoreTomorrowStepClock?.(); window.dispatchEvent(new Event('focus'))")
  }

  const reminderPosts = stub.requests.slice(requestsStart).filter(({ method, pathname }) => method === 'POST'
    && (pathname.startsWith('/api/v1/reminders') || pathname.startsWith('/api/v1/reminder-series')))
  assertEqual(reminderPosts.length, 0, 'Local tomorrow planning sent a reminder POST')
  return { explicitCreateEditRemove: true, survivesReload: true, petIsolation: true, localRolloverAndHistory: true, reminderPosts: 0 }
}
