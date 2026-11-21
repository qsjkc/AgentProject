import { join } from 'node:path'

import { assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'
import { startStubServer } from './stub-server.mjs'

const OWNER = { id: 871, username: 'daily-step-owner', email: 'daily-step-owner@example.test', password: 'daily-step-fixture-871' }
const OTHER = { id: 872, username: 'daily-step-other', email: 'daily-step-other@example.test', password: 'daily-step-fixture-872' }
const FOCUS_PANEL = '[data-e2e="focus-panel"]'
const FOCUS_INTENTION = '[data-e2e="focus-intention"]'
const STEP_TITLE = '[data-e2e="daily-step-title"]'

function addDailyStepAccounts(stub) {
  for (const user of [OWNER, OTHER]) {
    stub.fixture.accounts.set(user.id, {
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

async function waitForScope(main, user, petType) {
  await expectSnapshot(main, (snapshot) => (
    snapshot.account?.userId === user.id
    && snapshot.account?.petType === petType
    && snapshot.renderer?.[0]?.userId === user.id
    && snapshot.renderer?.[0]?.relationshipId === createRelationship(user, petType).id
  ), `daily step account ${user.id}/${petType} ready`)
}

async function expectStep(main, state, title = null) {
  await main.waitForSelector(`[data-e2e="daily-step"][data-state="${state}"]`)
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(STEP_TITLE)})?.textContent.trim() ?? null`), title,
    `Unexpected step title in the ${state} state`)
}

async function selectPet(main, petType) {
  const selector = `[data-e2e="pet-option-${petType}"]`
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.disabled === false`), {
    description: `${petType} selection ready`,
  })
  await main.click(selector)
  await waitForScope(main, OWNER, petType)
}

async function switchAccount(context, user, stub = context.stub) {
  const main = context.pages.main
  await main.click(REQUIRED_SELECTORS.logout)
  await loginAs({ pages: context.pages, stub }, user)
  await waitForScope(main, user, 'pig')
  assertEqual(await main.evaluate('window.desktopBridge.getApiBaseUrl()'), stub.apiBaseUrl, 'Incorrect daily step service')
}

export async function dailyStepScenario(context) {
  const main = context.pages.main
  const title = '读完两页书'
  addDailyStepAccounts(context.stub)
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await waitForScope(main, OWNER, 'pig')
  await expectStep(main, 'empty')

  await main.input('[data-e2e="daily-step-input"]', title)
  await main.click('[data-e2e="daily-step-save"]')
  await expectStep(main, 'planned', title)
  await main.click('[data-e2e="daily-step-focus"]')
  await main.waitForSelector(`${FOCUS_PANEL}[data-focus-status="idle"]`)
  const readIntention = () => main.evaluate(`document.querySelector(${JSON.stringify(FOCUS_INTENTION)})?.value`)
  await waitFor(async () => await readIntention() === title, {
    description: 'daily step prefilled into the focus intention',
  })
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(FOCUS_PANEL)})?.dataset.focusStatus`), 'idle',
    'Opening focus started a session before confirmation')

  const ownIntention = '已经写好的专注计划'
  await main.input(FOCUS_INTENTION, ownIntention)
  await main.click('[data-e2e="daily-step-focus"]')
  await main.waitForSelector('[data-e2e="focus-apply-step"]')
  assertEqual(await readIntention(), ownIntention, 'Opening focus overwrote an existing intention draft')
  await main.click('[data-e2e="focus-apply-step"]')
  assertEqual(await readIntention(), title, 'Explicitly applying the daily step did not replace the focus intention')
  await main.click('[data-e2e="focus-start"]')
  await main.waitForSelector(`${FOCUS_PANEL}[data-focus-status="running"]`)
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(FOCUS_PANEL)})?.textContent.includes(${JSON.stringify(title)})`),
    true, 'The running focus session lost the daily step intention')
  await main.click('[data-e2e="focus-end"]')
  await main.waitForSelector(`${FOCUS_PANEL}[data-focus-status="idle"]`)
  await expectStep(main, 'planned', title)

  await main.click('[data-e2e="daily-step-complete"]')
  await expectStep(main, 'completed', title)
  await main.reload()
  await waitForScope(main, OWNER, 'pig')
  await expectStep(main, 'completed', title)
  await main.click('[data-e2e="daily-step-undo"]')
  await expectStep(main, 'planned', title)
  await main.click('[data-e2e="daily-step-complete"]')
  await expectStep(main, 'completed', title)
  await main.evaluate(`document.querySelector('[data-e2e="daily-step"]').scrollIntoView({ block: 'center' })`)
  const screenshot = join(context.artifactPath, 'daily-step-completed.png')
  await main.screenshot(screenshot)

  await selectPet(main, 'cat')
  await expectStep(main, 'empty')
  await selectPet(main, 'pig')
  await expectStep(main, 'completed', title)
  await switchAccount(context, OTHER)
  await expectStep(main, 'empty')
  await switchAccount(context, OWNER)
  await expectStep(main, 'completed', title)

  const alternate = await startStubServer({ fixture: context.stub.fixture })
  try {
    await switchAccount(context, OWNER, alternate)
    await expectStep(main, 'empty')
    await switchAccount(context, OWNER)
    await expectStep(main, 'completed', title)
  } finally {
    await alternate.close()
  }

  try {
    // Advance only the main renderer's clock and use its ordinary focus event.
    await main.evaluate(`(() => {
      const originalNow = Date.now
      const tomorrow = new Date(originalNow())
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(12, 0, 0, 0)
      window.restoreDailyStepClock = () => { Date.now = originalNow; delete window.restoreDailyStepClock }
      Date.now = () => tomorrow.getTime()
      window.dispatchEvent(new Event('focus'))
    })()`)
    await expectStep(main, 'empty')
  } finally {
    await main.evaluate("window.restoreDailyStepClock?.(); window.dispatchEvent(new Event('focus'))")
  }
  await expectStep(main, 'completed', title)

  await main.click('[data-e2e="daily-step-edit"]')
  await main.click('[data-e2e="daily-step-remove"]')
  await expectStep(main, 'empty')
  assertEqual(context.stub.requests.some((request) => request.body.includes(title)), false,
    'The local daily step title was sent to the service')

  return {
    manualStart: true,
    preservesExistingIntention: true,
    manualCompletion: true,
    undo: true,
    rendererReload: true,
    petIsolation: true,
    accountIsolation: true,
    serverIsolation: true,
    simulatedCalendarChange: true,
    localTitle: true,
    removed: true,
    screenshot,
  }
}
