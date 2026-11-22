import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import {
  REQUIRED_SELECTORS,
  ensureBaseBridge,
  expectSnapshot,
  loginAs,
  resetToLoggedOut,
} from './p1k-scenarios.mjs'

const HISTORY_USERS = Object.freeze({
  completed: Object.freeze({ id: 303, username: 'focus-history-completed', email: 'focus-history-completed@example.test', password: 'focus-history-password-303' }),
  empty: Object.freeze({ id: 404, username: 'focus-history-empty', email: 'focus-history-empty@example.test', password: 'focus-history-password-404' }),
})
const PANEL = '[data-e2e="focus-panel"]'
const HISTORY = '[data-e2e="focus-history"]'
const PRESETS = `${PANEL} .focus-durations button`
const focusState = (status) => `${PANEL}[data-focus-status="${status}"]`

export async function prepareFocusHistoryFixture({ userDataPath, apiBaseUrl, now = Date.now() }) {
  const entry = {
    id: 'e2e-legacy-completed-focus',
    intention: '从旧版本找回的一小段阅读',
    durationMs: 45 * 60_000,
    completedAt: now,
  }
  const olderEntry = {
    id: 'e2e-older-completed-focus',
    intention: '整理书桌',
    durationMs: 15 * 60_000,
    completedAt: now - 2 * 24 * 60 * 60_000,
  }
  const key = JSON.stringify([apiBaseUrl.replace(/\/+$/, ''), HISTORY_USERS.completed.id, 'pig'])
  // createStore() in electron/main.cjs uses electron-store's default name,
  // config.json. This fresh TEMP profile is seeded before Electron starts.
  // The current legacy completion has not been added to its saved history yet.
  const storePath = join(userDataPath, 'config.json')
  await writeFile(storePath, `${JSON.stringify({
    focusSessions: {
      [key]: { ...entry, status: 'completed', revision: 1, remainingMs: 0, endsAt: null, history: [olderEntry] },
    },
  }, null, 2)}\n`, { flag: 'wx' })
  return {
    evidence: 'legacy-completed-fixture-restoration',
    naturalTimerCompletionExercised: false,
    storePath,
    key,
    entry,
    olderEntry,
  }
}

function addHistoryAccounts(context) {
  // Other suite scenarios replace the stub fixture. Register these dedicated
  // accounts only when this scenario starts, without changing A/B focus state.
  for (const user of Object.values(HISTORY_USERS)) {
    context.stub.fixture.accounts.set(user.id, {
      user,
      token: createJwt(user),
      preferences: createPreferences(user),
      relationshipByPet: new Map(['pig', 'cat', 'dog'].map((petType) => [petType, createRelationship(user, petType)])),
      sessions: [],
      documents: [],
      reminders: [],
    })
  }
}

async function waitForAccount(context, user, petType = 'pig') {
  await expectSnapshot(context.pages.main, (snapshot) => (
    snapshot.account?.userId === user.id
    && snapshot.account?.petType === petType
    && snapshot.relationship?.user_id === user.id
    && snapshot.relationship?.pet_type === petType
    && snapshot.renderer?.[0]?.relationshipId === createRelationship(user, petType).id
    && snapshot.relationshipCapabilityAdopted === true
  ), `focus history account ${user.id}/${petType} ready`)
  await waitFor(() => context.pages.main.evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(PANEL)})
    return panel?.getAttribute('data-pet-type') === ${JSON.stringify(petType)}
      && panel.getAttribute('aria-busy') === 'false'
      && !panel.querySelector('[role="alert"]')
  })()`), { description: `focus history ${user.id}/${petType} has loaded` })
}

async function switchAccount(context, user) {
  await context.pages.main.click(REQUIRED_SELECTORS.logout)
  await loginAs(context, user)
  await waitForAccount(context, user)
}

async function selectPet(context, user, petType) {
  const selector = `[data-e2e="pet-option-${petType}"]`
  await waitFor(() => context.pages.main.evaluate(`(() => {
    const option = document.querySelector(${JSON.stringify(selector)})
    return option && !option.disabled && !document.querySelector('.main-companion-sync')
  })()`), { description: `${petType} selector ready for focus history` })
  await context.pages.main.click(selector)
  await waitForAccount(context, user, petType)
}

async function readHistory(main, fixture) {
  return main.evaluate(`(() => {
    const current = new Date()
    const today = ${JSON.stringify([fixture.entry, fixture.olderEntry])}.filter(({ completedAt }) => {
      const completed = new Date(completedAt)
      return completed.getFullYear() === current.getFullYear()
        && completed.getMonth() === current.getMonth() && completed.getDate() === current.getDate()
    })
    const list = document.querySelector('[data-e2e="focus-history-list"]')
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      todayCount: Number(document.querySelector('[data-e2e="focus-history-today-count"]')?.textContent),
      todayMinutes: Number(document.querySelector('[data-e2e="focus-history-today-minutes"]')?.textContent),
      expectedTodayCount: today.length,
      expectedTodayMinutes: today.reduce((minutes, entry) => minutes + entry.durationMs / 60000, 0),
      entries: Array.from(list?.querySelectorAll('[data-e2e-focus-history-id]') || [], (node) => ({
        id: node.getAttribute('data-e2e-focus-history-id'),
        text: node.textContent,
        completedAt: node.querySelector('time')?.getAttribute('datetime'),
      })),
      empty: Boolean(document.querySelector('[data-e2e="focus-history-empty"]')),
    }
  })()`)
}

async function assertCompletedHistory(main, fixture, description) {
  await main.waitForSelector(HISTORY)
  await main.waitForSelector(`[data-e2e-focus-history-id="${fixture.entry.id}"]`)
  const history = await readHistory(main, fixture)
  assertEqual(history.todayCount, history.expectedTodayCount, `${description}: wrong local-day completion count`)
  assertEqual(history.todayMinutes, history.expectedTodayMinutes, `${description}: wrong local-day minutes`)
  const expected = [fixture.entry, fixture.olderEntry]
  assertEqual(history.entries.length, expected.length, `${description}: a completion was lost or duplicated`)
  for (const [index, entry] of expected.entries()) {
    assertEqual(history.entries[index].id, entry.id, `${description}: wrong completion order`)
    assertEqual(history.entries[index].completedAt, new Date(entry.completedAt).toISOString(), `${description}: completion time changed`)
    assert(history.entries[index].text.includes(entry.intention), `${description}: completion intention was lost`)
  }
  assertEqual(history.empty, false, `${description}: populated history shows its empty state`)
  return history
}

async function assertEmptyHistory(main, fixture, description) {
  await main.waitForSelector('[data-e2e="focus-history-empty"]')
  const history = await readHistory(main, fixture)
  assertEqual(history.todayCount, 0, `${description}: another account or pet leaked its count`)
  assertEqual(history.todayMinutes, 0, `${description}: another account or pet leaked its minutes`)
  assertEqual(history.entries.length, 0, `${description}: another account or pet leaked its entries`)
}

async function assertStoredHistory(fixture, status) {
  return waitFor(async () => {
    const config = JSON.parse(await readFile(fixture.storePath, 'utf8'))
    const stored = config.focusSessions?.[fixture.key]
    const expected = [fixture.entry, fixture.olderEntry]
    if (stored?.status !== status || stored.history?.length !== expected.length) return null
    for (const [index, entry] of expected.entries()) {
      for (const [field, value] of Object.entries(entry)) {
        assertEqual(stored.history[index][field], value, `Persisted focus completion changed ${field}`)
      }
    }
    return stored
  }, { description: `focus ${status} and both completions saved together to electron-store` })
}

async function assertSelectedPreset(main, minutes, description) {
  await main.waitForSelector(`${focusState('idle')}[aria-busy="false"] .focus-durations [aria-pressed="true"]`)
  const selected = await main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${PRESETS}[aria-pressed="true"]`)}),
    (button) => Number.parseInt(button.textContent, 10))`)
  assertEqual(selected.length, 1, `${description}: expected exactly one selected preset`)
  assertEqual(selected[0], minutes, `${description}: wrong selected preset`)
}

async function selectPreset(main, minutes) {
  const index = await main.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(PRESETS)}))
    .findIndex((button) => Number.parseInt(button.textContent, 10) === ${minutes})`)
  assert(index >= 0, `Focus preset ${minutes} is missing`)
  await main.click(`${PRESETS}:nth-of-type(${index + 1})`)
}

export async function focusHistoryScenario(context) {
  const fixture = context.focusHistoryFixture
  assert(fixture?.entry && fixture?.olderEntry && fixture?.storePath, 'Focus history requires its pre-start TEMP profile fixture')
  await ensureBaseBridge(context)
  addHistoryAccounts(context)
  await resetToLoggedOut(context)
  await loginAs(context, HISTORY_USERS.completed)
  await waitForAccount(context, HISTORY_USERS.completed)
  const main = context.pages.main
  const latestMinutes = fixture.entry.durationMs / 60_000
  await main.waitForSelector(focusState('completed'))
  const restored = await assertCompletedHistory(main, fixture, 'completed fixture restoration')
  await assertStoredHistory(fixture, 'completed')
  await main.evaluate(`document.querySelector(${JSON.stringify(PANEL)}).scrollIntoView({ block: 'center' })`)
  const restoredScreenshot = join(context.artifactPath, 'focus-history-restored-completed.png')
  await main.screenshot(restoredScreenshot)

  await main.click('[data-e2e="focus-back-today"]')
  assertEqual(await main.evaluate('document.activeElement.id'), 'companion-today', 'Completed focus did not return keyboard focus to Today')
  const nextStep = '给绿植浇水'
  await main.input('[data-e2e="daily-step-input"]', nextStep)
  await main.click('[data-e2e="daily-step-save"]')
  await main.click('[data-e2e="daily-step-focus"]')
  await main.waitForSelector('[data-e2e="focus-prepare-step"]')
  await main.waitForSelector(focusState('completed'))
  await main.click('[data-e2e="focus-prepare-step"]')
  await main.waitForSelector(focusState('idle'))
  assertEqual(await main.evaluate("document.querySelector('[data-e2e=focus-intention]').value"), nextStep, 'Choosing the next focus did not retain the daily step')
  await assertCompletedHistory(main, fixture, 'reset keeps completed history')
  await assertSelectedPreset(main, latestMinutes, 'reset after startup from a saved completion')
  await assertStoredHistory(fixture, 'idle')
  await main.reload()
  await waitForAccount(context, HISTORY_USERS.completed)
  await main.waitForSelector(focusState('idle'))
  await assertCompletedHistory(main, fixture, 'renderer reload keeps completed history')
  await assertSelectedPreset(main, latestMinutes, 'renderer reload after reset')

  const chosenMinutes = 25
  await selectPreset(main, chosenMinutes)
  await assertSelectedPreset(main, chosenMinutes, 'explicit duration choice')
  await main.input('[data-e2e="focus-intention"]', '提前结束的专注不能计入成果')
  await main.click('[data-e2e="focus-start"]')
  await main.waitForSelector(focusState('running'))
  const running = await assertStoredHistory(fixture, 'running')
  assertEqual(running.durationMs, chosenMinutes * 60_000, 'Starting a session did not use the explicitly selected preset')
  await main.click('[data-e2e="focus-end"]')
  await main.waitForSelector(focusState('idle'))
  await assertCompletedHistory(main, fixture, 'early finish does not increase history')
  await assertStoredHistory(fixture, 'idle')

  await selectPet(context, HISTORY_USERS.completed, 'cat')
  await main.waitForSelector(focusState('idle'))
  await assertEmptyHistory(main, fixture, 'cat history isolation')
  await assertSelectedPreset(main, 25, 'cat falls back without pig history')
  await selectPet(context, HISTORY_USERS.completed, 'pig')
  await assertCompletedHistory(main, fixture, 'pig history after pet switch')
  await assertSelectedPreset(main, latestMinutes, 'pig preset restored after pet switch')
  await switchAccount(context, HISTORY_USERS.empty)
  await main.waitForSelector(focusState('idle'))
  await assertEmptyHistory(main, fixture, 'second account history isolation')
  await assertSelectedPreset(main, 25, 'second account falls back without the first account history')
  await switchAccount(context, HISTORY_USERS.completed)
  const returned = await assertCompletedHistory(main, fixture, 'original account history restored')
  await assertSelectedPreset(main, latestMinutes, 'original account preset restored')
  await assertStoredHistory(fixture, 'idle')
  await main.evaluate(`document.querySelector(${JSON.stringify(PANEL)}).scrollIntoView({ block: 'center' })`)
  const retainedScreenshot = join(context.artifactPath, 'focus-history-retained.png')
  await main.screenshot(retainedScreenshot)

  return {
    evidence: fixture.evidence,
    naturalTimerCompletionExercised: false,
    persistedFixtureMigration: true,
    resetRetainsHistory: true,
    rendererReloadRetainsHistory: true,
    restoredFocusPresetMinutes: latestMinutes,
    explicitFocusPresetMinutes: chosenMinutes,
    otherScopesFallbackPresetMinutes: 25,
    earlyFinishExcluded: true,
    accountIsolation: true,
    petIsolation: true,
    restored,
    returned,
    screenshots: [restoredScreenshot, retainedScreenshot],
  }
}
