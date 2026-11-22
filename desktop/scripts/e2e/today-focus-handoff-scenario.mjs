import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { callE2e, expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 876, username: 'today-focus-owner', email: 'today-focus-owner@example.test', password: 'today-focus-fixture-876' }
const TODAY = '#companion-today'
const FOCUS_PANEL = '#companion-focus'
const ACTIVE = `${TODAY} [data-e2e="today-focus-active"]`
const ACTION = `${TODAY} [data-e2e="today-focus-action"]`
const CHAT_DRAFT = '[data-e2e="main-chat-input"]'

function hasFocus(main, selector) {
  return main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)
}

function expectFocus(main, selector) {
  return waitFor(() => hasFocus(main, selector), { description: `keyboard focus on ${selector}` })
}

async function waitForScope(main, petType, relationship) {
  await expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id
    && snapshot.account?.petType === petType
    && snapshot.renderer?.[0]?.userId === OWNER.id
    && snapshot.renderer?.[0]?.relationshipId === relationship.id, `${petType} scope is ready for the focus handoff`)
}

async function expectActive(main, status, intention) {
  const selector = `${ACTIVE}[data-focus-status="${status}"]`
  await main.waitForSelector(selector)
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(intention)})`),
    { description: `Today shows the ${status} focus intention` })
}

async function expectPausedTimers(main) {
  const timers = await waitFor(() => main.evaluate(`(() => {
    const today = document.querySelector(${JSON.stringify(`${ACTIVE}[data-focus-status="paused"] [data-e2e="today-focus-time"]`)})
    const focus = document.querySelector(${JSON.stringify(`${FOCUS_PANEL}[data-focus-status="paused"] [data-e2e="focus-time"]`)})
    if (!today || !focus) return null
    return { today: today.textContent.trim(), focus: focus.textContent.trim(),
      role: today.getAttribute('role'), live: today.getAttribute('aria-live') }
  })()`), { description: 'the paused Today and focus timers are both rendered' })
  assert(/^\d{2}:[0-5]\d$/.test(timers.today), 'Today should show the remaining focus time as MM:SS')
  assertEqual(timers.today, timers.focus, 'The Today clock differs from the paused focus timer')
  assertEqual(timers.role, 'timer', 'The Today clock should expose a timer role')
  assertEqual(timers.live, 'off', 'The Today clock should keep live announcements off')
  return timers.today
}

function expectNoActive(main, petType) {
  return waitFor(() => main.evaluate(`(() => {
    const panel = document.querySelector(${JSON.stringify(FOCUS_PANEL)})
    return panel?.dataset.petType === ${JSON.stringify(petType)} && panel.dataset.focusStatus === 'idle'
      && !document.querySelector(${JSON.stringify(ACTIVE)})
  })()`), { description: `Today has no active focus in the idle ${petType} scope` })
}

function observeFocusState(main) {
  return main.evaluate(`(() => {
    // Observe real Electron broadcasts without acquiring a capability or mutating focus.
    const unsubscribe = window.desktopBridge.onFocusSessionChanged(({ userId, petType, state }) => {
      if (userId === ${OWNER.id} && petType === 'pig') window.todayFocusState = state
    })
    window.stopTodayFocusObservation = () => {
      unsubscribe()
      delete window.todayFocusState
      delete window.stopTodayFocusObservation
    }
  })()`)
}

async function readFocusState(main) {
  const state = await main.evaluate('window.todayFocusState')
  assert(state, 'No authoritative focus state was broadcast')
  return state
}

async function selectPet(main, petType, relationship) {
  const selector = `[data-e2e="pet-option-${petType}"]`
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.disabled === false`),
    { description: `${petType} selector is enabled` })
  await main.click(selector)
  await waitForScope(main, petType, relationship)
}

export async function todayFocusHandoffScenario(context) {
  const { main } = context.pages
  const relationships = new Map(['pig', 'cat'].map((petType) => [petType, createRelationship(OWNER, petType)]))
  context.stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: relationships, sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await waitForScope(main, 'pig', relationships.get('pig'))
  await expectNoActive(main, 'pig')
  await observeFocusState(main)
  try {
    return await verifyFocusHandoff(context, relationships)
  } finally {
    await main.evaluate('window.stopTodayFocusObservation?.()')
  }
}

async function verifyFocusHandoff(context, relationships) {
  const { main, pet } = context.pages
  const intention = '继续整理桌上的读书笔记'
  const draft = '这句话还没发出去'
  await main.input('[data-e2e="focus-intention"]', intention)
  await main.click('[data-e2e="focus-start"]')
  await expectActive(main, 'running', intention)
  const started = await readFocusState(main)
  assertEqual(started.status, 'running', 'Focus did not start')
  await main.click(ACTION)
  await expectFocus(main, FOCUS_PANEL)
  const viewed = await readFocusState(main)
  assertEqual(viewed.id, started.id, 'Viewing running focus changed the session ID')
  assertEqual(viewed.revision, started.revision, 'Viewing running focus changed its revision')

  await main.click('[data-e2e="focus-toggle"]')
  await expectActive(main, 'paused', intention)
  const paused = await readFocusState(main)
  assertEqual(paused.status, 'paused', 'Focus did not pause')
  const pausedClock = await expectPausedTimers(main)
  await main.input(CHAT_DRAFT, draft)
  await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
  await main.waitForSelector(`${REQUIRED_SELECTORS.mainTabKnowledge}[aria-pressed="true"]`)
  await main.evaluate('window.desktopBridge.hideMainPanel()')
  await expectSnapshot(main, (snapshot) => snapshot.windows?.mainPanel?.visible === false, 'main panel is natively hidden')
  await callE2e(pet, 'showWindow', 'pet')
  await pet.click('[data-e2e="pet-open-today"]')
  await expectSnapshot(main, (snapshot) => snapshot.windows?.mainPanel?.visible === true
    && snapshot.account?.userId === OWNER.id && snapshot.account?.petType === 'pig', 'pet opens Today in the same scope')
  await expectFocus(main, TODAY)
  await expectActive(main, 'paused', intention)
  const reopened = await readFocusState(main)
  assertEqual(reopened.id, paused.id, 'Opening Today replaced paused focus')
  assertEqual(reopened.revision, paused.revision, 'Opening Today mutated paused focus')
  assertEqual(reopened.remainingMs, paused.remainingMs, 'Opening Today advanced paused focus')
  assertEqual(await expectPausedTimers(main), pausedClock, 'Reopening Today changed the displayed paused time')
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(CHAT_DRAFT)})?.value`), draft, 'Opening Today lost the chat draft')
  const screenshot = await main.screenshot(join(context.artifactPath, 'today-focus-paused.png'))

  await selectPet(main, 'cat', relationships.get('cat'))
  await expectNoActive(main, 'cat')
  await selectPet(main, 'pig', relationships.get('pig'))
  await expectActive(main, 'paused', intention)
  const restored = await readFocusState(main)
  assertEqual(restored.id, paused.id, 'Switching back did not restore paused focus')
  assertEqual(restored.revision, paused.revision, 'Switching pets mutated paused focus')

  await main.click(ACTION)
  await expectActive(main, 'running', intention)
  await expectFocus(main, FOCUS_PANEL)
  const resumed = await readFocusState(main)
  assertEqual(resumed.status, 'running', 'Today did not resume focus')
  assertEqual(resumed.id, paused.id, 'Today started a different session on resume')
  assertEqual(resumed.revision, paused.revision + 1, 'Today did not resume focus exactly once')
  assertEqual(resumed.intention, paused.intention, 'Today changed the focus intention on resume')
  assertEqual(resumed.durationMs, paused.durationMs, 'Today changed the focus duration on resume')

  await main.click('[data-e2e="focus-end"]')
  await expectNoActive(main, 'pig')
  return { runningNavigation: true, hiddenPanelPreservesPause: true, pausedTimersMatch: true, sameSessionResumes: true, petIsolation: true, clearsAfterEnd: true, screenshot }
}
