import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { callE2e, expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 881, username: 'focus-notification-owner', email: 'focus-notification-owner@example.test', password: 'focus-notification-fixture-881' }
const FOCUS_PANEL = '#companion-focus'
const focusStatus = (status) => `${FOCUS_PANEL}[data-focus-status="${status}"][aria-busy="false"]`
const CONFIRM_STEP = '[data-e2e="focus-complete-step"]'
const TODAY_STEP = '[data-e2e="daily-step"]'
const AUTH_ME = '/api/v1/auth/me'

function focusCheckpoint(context) {
  const key = JSON.stringify([context.stub.apiBaseUrl.replace(/\/+$/, ''), OWNER.id, 'pig'])
  const filename = join(context.userDataPath, 'config.json')
  return {
    async read() {
      const config = JSON.parse(await readFile(filename, 'utf8'))
      return config.focusSessions?.[key]
    },
    async shortenPause() {
      const config = JSON.parse(await readFile(filename, 'utf8'))
      const original = config.focusSessions?.[key]
      assertEqual(original?.status, 'paused', 'Shortening requires the real paused checkpoint')
      original.remainingMs = 750
      const staged = join(context.userDataPath, 'config.focus-notification-e2e.json')
      await writeFile(staged, JSON.stringify(config), { flag: 'wx' })
      await rename(staged, filename)
      return original
    },
  }
}

async function finishTimer(context, checkpoint, { leaveChat = false } = {}) {
  const { main, pet } = context.pages
  await main.waitForSelector(focusStatus('running'))
  await main.click('[data-e2e="focus-toggle"]')
  await main.waitForSelector(focusStatus('paused'))
  const paused = await checkpoint.shortenPause()
  await main.click('[data-e2e="focus-toggle"]')
  if (leaveChat) {
    await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
    await main.waitForSelector(`${REQUIRED_SELECTORS.mainTabKnowledge}[aria-pressed="true"]`)
    assertEqual(await callE2e(main, 'hideWindow', 'main-panel'), true, 'The main panel was not hidden')
  }
  const completed = await waitFor(async () => {
    const state = await checkpoint.read()
    return state?.id === paused.id && state.status === 'completed' ? state : null
  }, { description: 'the exact Focus timer completes through Electron' })
  assertEqual(completed.revision, paused.revision + 2, 'Focus resumed and completed exactly once')
  await expectSnapshot(pet, (snapshot) => snapshot.focusCompletionClickPending, 'a completion callback is attached')
  return completed
}

export async function focusCompletionNotificationScenario(context) {
  const { main, pet } = context.pages
  const relationship = createRelationship(OWNER)
  context.stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await main.waitForSelector(focusStatus('idle'))

  const title = '整理读完的那一页'
  const checkpoint = focusCheckpoint(context)
  await main.input('[data-e2e="daily-step-input"]', title)
  await main.click('[data-e2e="daily-step-save"]')
  await main.click('[data-e2e="daily-step-focus"]')
  await waitFor(() => main.evaluate(`document.querySelector('[data-e2e="focus-intention"]')?.value === ${JSON.stringify(title)}`),
    { description: 'the original Today step is linked to this timer' })
  await main.click('[data-e2e="focus-start"]')
  const finished = await finishTimer(context, checkpoint, { leaveChat: true })
  assert(finished.stepOrigin, 'The finished checkpoint lost its linked Today step')

  const held = context.stub.holdNext('GET', AUTH_ME)
  let authStarted = false
  void held.arrived.then(() => { authStarted = true })
  try {
    await main.reload()
    await waitFor(() => authStarted, { description: 'the reloaded main renderer is waiting for its account' })
    assertEqual(await callE2e(pet, 'clickFocusCompletionNotification'), true, 'The native callback fixture did not emit a click')
    await expectSnapshot(pet, (snapshot) => snapshot.windows.mainPanel.visible && snapshot.companionNavigationPending,
      'the callback opened the window and queued navigation before renderer readiness')
  } finally {
    held.release()
  }
  await main.waitForSelector(focusStatus('completed'))
  await waitFor(() => main.evaluate(`document.activeElement === document.getElementById('companion-focus')`),
    { description: 'the completion callback focuses the Focus panel after renderer reload' })
  await expectSnapshot(main, (snapshot) => !snapshot.companionNavigationPending, 'the exact completion navigation is acknowledged')
  const shown = await checkpoint.read()
  assertEqual(shown.id, finished.id, 'Opening a completion replaced the timer')
  assertEqual(shown.revision, finished.revision, 'Opening a completion mutated the timer')
  await main.waitForSelector(`${TODAY_STEP}[data-state="planned"]`)
  await main.waitForSelector(CONFIRM_STEP)
  assertEqual(await callE2e(pet, 'clickFocusCompletionNotification'), false, 'The same callback navigated more than once')
  await main.click(CONFIRM_STEP)
  await main.waitForSelector(`${TODAY_STEP}[data-state="completed"]`)

  await main.click('[data-e2e="focus-reset"]')
  await main.waitForSelector(focusStatus('idle'))
  await main.click('[data-e2e="focus-start"]')
  const old = await finishTimer(context, checkpoint)
  await main.waitForSelector(focusStatus('completed'))
  await main.click('[data-e2e="focus-reset"]')
  await main.waitForSelector(focusStatus('idle'))
  await main.click('[data-e2e="focus-start"]')
  await main.waitForSelector(focusStatus('running'))
  const replacement = await checkpoint.read()
  assert(old.id !== replacement.id, 'The replacement timer must be a separate session')
  await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
  await main.waitForSelector(`${REQUIRED_SELECTORS.mainTabKnowledge}[aria-pressed="true"]`)
  assertEqual(await callE2e(main, 'hideWindow', 'main-panel'), true, 'The main panel was not hidden for the stale-click proof')
  assertEqual(await callE2e(pet, 'clickFocusCompletionNotification'), true, 'The stale callback was not exercised')
  const afterStaleClick = await callE2e(pet, 'snapshot')
  assertEqual(afterStaleClick.windows.mainPanel.visible, false, 'An old completion click reopened the main window')
  assertEqual(afterStaleClick.companionNavigationPending, false, 'An old completion queued a shortcut')
  assertEqual((await checkpoint.read()).id, replacement.id, 'An old completion interfered with the replacement timer')
  assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.mainTabKnowledge)}).getAttribute('aria-pressed')`), 'true',
    'An old completion click replaced the Knowledge tab')

  await callE2e(main, 'showWindow', 'main-panel')
  await main.click('[data-e2e="open-focus"]')
  await main.waitForSelector(focusStatus('running'))
  await main.click('[data-e2e="focus-end"]')
  await main.waitForSelector(focusStatus('idle'))
  return { queuedAcrossRendererReload: true, sameCompletionIdAndRevision: true, explicitStepConfirmation: true, staleNotificationIgnored: true }
}
