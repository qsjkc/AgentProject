import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { callE2e, expectSnapshot, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = Object.freeze({ id: 873, username: 'today-reminder-owner', email: 'today-reminder@example.test', password: 'today-reminder-fixture-873' })
const PET = 'dog'
const REMINDERS = '/api/v1/reminders'
const LANGUAGE = '.main-header-language select'
const TOGGLE = '[data-e2e="today-reminder-toggle"]'
const FORM = '[data-e2e="today-reminder-form"]'
const TITLE = '[data-e2e="today-reminder-title"]'
const TIME = '[data-e2e="today-reminder-custom-time"]'
const SAVE = '[data-e2e="today-reminder-save"]'
const ERROR = '[data-e2e="today-reminder-error"]'
const SUCCESS = '[data-e2e="today-reminder-success"]'

function readControl(main, selector, property) {
  return main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.[${JSON.stringify(property)}]`)
}

function setLanguage(main, language) {
  return main.evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(LANGUAGE)})
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(control, ${JSON.stringify(language)})
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

function setFutureTime(main) {
  return main.evaluate(`(() => {
    const date = new Date(Date.now() + 2 * 60 * 60_000)
    const pad = value => String(value).padStart(2, '0')
    const local = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    const input = document.querySelector(${JSON.stringify(TIME)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, local)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { local, iso: new Date(local).toISOString() }
  })()`)
}

export async function todayReminderScenario(context) {
  const { main, pet } = context.pages
  const { stub } = context
  const relationship = createRelationship(OWNER, PET)
  const account = {
    user: OWNER,
    token: createJwt(OWNER),
    preferences: createPreferences(OWNER, PET),
    relationshipByPet: new Map([[PET, relationship]]),
    sessions: [],
    documents: [],
    reminders: [],
  }
  stub.fixture.accounts.set(OWNER.id, account)
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await expectSnapshot(main, (snapshot) => (
    snapshot.account?.userId === OWNER.id
    && snapshot.account?.petType === PET
    && snapshot.renderer?.[0]?.relationshipId === relationship.id
  ), 'Today reminder uses the signed-in dog relationship')
  const initialLanguage = await readControl(main, LANGUAGE, 'value')
  const requestStart = stub.requests.length
  const posts = () => stub.requests.slice(requestStart).filter((request) => request.method === 'POST' && request.pathname === REMINDERS)
  const title = '散步前带上水杯'
  try {
    await setLanguage(main, 'zh-CN')
    await waitFor(async () => (await readControl(main, TOGGLE, 'textContent'))?.trim() === '添加提醒', { description: 'Chinese Today reminder action' })
    await main.click(TOGGLE)
    await main.waitForSelector(`#companion-today ${FORM}`)
    assertEqual((await readControl(main, SAVE, 'textContent')).trim(), '保存提醒', 'Missing Chinese save label')
    assertEqual(await readControl(main, '[data-e2e="today-reminder-delay-15"]', 'checked'), true, 'Default delay is not fifteen minutes')
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(TITLE)})?.labels?.length > 0`), 'Reminder title input has no associated label')

    await setLanguage(main, 'en')
    await waitFor(async () => (await readControl(main, FORM, 'ariaLabel')) === 'Add reminder'
      && (await readControl(main, SAVE, 'textContent'))?.trim() === 'Save reminder', { description: 'English Today reminder controls' })
    await main.input(TITLE, title)
    await main.click('[data-e2e="today-reminder-delay-custom"]')
    await main.waitForSelector(TIME)
    const time = await setFutureTime(main)
    assertEqual(posts().length, 0, 'Opening or editing a reminder submitted it')

    const restoreFailure = stub.overrideResponse('POST', REMINDERS, 503, { detail: 'Temporary reminder service outage' })
    try {
      await main.click(SAVE)
      await main.waitForSelector(ERROR)
      assertEqual(posts().length, 1, 'Failed save did not make exactly one explicit request')
      assertEqual(account.reminders.length, 0, 'Failed save persisted a reminder')
      assertEqual(await readControl(main, TITLE, 'value'), title, 'API failure cleared the reminder title')
      assertEqual(await readControl(main, TIME, 'value'), time.local, 'API failure cleared the selected local time')
    } finally {
      restoreFailure()
    }

    // Establish a fresh pet poll before saving so the creation-triggered read can be distinguished from the periodic read.
    await callE2e(pet, 'flushReminderPoll')
    const held = stub.holdNext('POST', REMINDERS)
    let retry
    try {
      await main.click(SAVE)
      retry = await waitFor(() => posts()[1], { description: 'explicit retry reaches the reminders API' })
      await main.waitForSelector(`${SAVE}[disabled]`)
      await main.click(SAVE)
    } finally {
      held.release()
    }

    await main.waitForSelector(SUCCESS)
    assertEqual(await main.evaluate(`!document.querySelector(${JSON.stringify(FORM)})`), true, 'Successful save left the reminder form open')
    assertEqual(await readControl(main, `${SUCCESS} time`, 'dateTime'), time.iso, 'Today confirmation shows a different scheduled instant')
    const reminder = account.reminders[0]
    assert(reminder, 'Successful reminder was not persisted for the authorized account')
    assertEqual(reminder.user_id, OWNER.id, 'Reminder was saved to another account')
    assertEqual(reminder.pet_type, PET, 'Reminder was saved for the wrong pet')
    assertEqual(reminder.title, title, 'Saved reminder changed the title')
    assertEqual(reminder.remind_at, time.iso, 'Saved reminder changed the selected local time')
    assertEqual(reminder.email_enabled, false, 'Today reminder unexpectedly enabled email')
    const body = JSON.parse(retry.body)
    assertEqual(body.title, title, 'Reminder title did not reach the API')
    assertEqual(body.remind_at, time.iso, 'Reminder time did not reach the API as the exact instant')

    const row = `[data-e2e-upcoming-reminder-id="${reminder.id}"]`
    await main.waitForSelector(row)
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(row)})?.textContent.includes(${JSON.stringify(title)})`), 'Upcoming list did not show the saved reminder')
    await waitFor(() => stub.requests.slice(retry.sequence).some((request) => {
      const query = new URLSearchParams(request.search)
      return request.method === 'GET' && request.pathname === REMINDERS
        && query.get('pet_type') === PET && query.get('triggered') === 'false' && query.has('due_before')
    }), { timeoutMs: 5000, description: 'saving a Today reminder refreshes the pet’s upcoming schedule' })
    assertEqual(posts().length, 2, 'Duplicate click made another reminder POST')
    assertEqual(account.reminders.length, 1, 'Duplicate click persisted an extra reminder')
    assert(!stub.requests.slice(requestStart).some((request) => request.method === 'POST' && request.pathname === '/api/v1/chat/message'), 'Today reminder was sent to model chat')

    const screenshot = await main.screenshot(join(context.artifactPath, 'today-reminder-saved.png'))
    return { bilingual: true, explicitSave: true, accountScoped: true, retriedDraft: true, duplicateBlocked: true, listUpdated: true, petScheduleRefreshed: true, reminderId: reminder.id, screenshot }
  } finally {
    await setLanguage(main, initialLanguage)
  }
}
