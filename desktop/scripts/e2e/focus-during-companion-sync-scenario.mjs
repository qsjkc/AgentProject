import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 879, username: 'focus-during-companion-sync', email: 'focus-during-companion-sync@example.test', password: 'focus-companion-sync-fixture-879' }
const ME = '/api/v1/auth/me'
const RELATIONSHIP = '/api/v1/pets/pig/relationship'
const FOCUS_PANEL = '#companion-focus'
const TODAY_ACTIVE = '#companion-today [data-e2e="today-focus-active"]'
const TODAY_ACTION = '#companion-today [data-e2e="today-focus-action"]'
const COMPANION_RETRY = '[data-e2e="companion-sync-retry"]'
const WEEKLY = '[data-e2e="pet-weekly-summary"]'
const REMINDER_AGENDA = '[data-e2e="today-reminder-agenda"]'

function focusState(status) {
  return `${FOCUS_PANEL}[data-focus-status="${status}"]`
}

function readTimer(main) {
  return main.evaluate('document.querySelector(\'[data-e2e="focus-time"]\')?.textContent')
}

function observeFocus(main) {
  return main.evaluate(`(() => {
    const unsubscribe = window.desktopBridge.onFocusSessionChanged(({ userId, petType, state }) => {
      if (userId === ${OWNER.id} && petType === 'pig') window.companionSyncFocusState = state
    })
    window.stopCompanionSyncFocusObservation = () => {
      unsubscribe()
      delete window.companionSyncFocusState
      delete window.stopCompanionSyncFocusObservation
    }
  })()`)
}

function waitForFocusState(main, status) {
  return waitFor(() => main.evaluate(`window.companionSyncFocusState?.status === ${JSON.stringify(status)}
    ? window.companionSyncFocusState : null`), { description: `Electron broadcasts ${status} for the fixture focus session` })
}

export async function focusDuringCompanionSyncScenario(context) {
  const { main } = context.pages
  const { stub } = context
  const relationship = createRelationship(OWNER, 'pig')
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await main.waitForSelector(focusState('idle'))
  await observeFocus(main)

  const intention = '恢复后继续整理阅读摘记'
  let restoreRelationship = () => {}
  try {
    await main.input('[data-e2e="focus-intention"]', intention)
    await main.click('[data-e2e="focus-start"]')
    await main.waitForSelector(focusState('running'))
    await main.click('[data-e2e="focus-toggle"]')
    await main.waitForSelector(focusState('paused'))
    const paused = await waitForFocusState(main, 'paused')
    const pausedTime = await readTimer(main)
    assert(pausedTime, 'Paused focus did not show its remaining time')

    const refreshStart = stub.requests.length
    restoreRelationship = stub.overrideResponse('GET', RELATIONSHIP, 503, { detail: 'Temporary companion record outage' })
    await main.reload()
    await main.waitForSelector(REQUIRED_SELECTORS.mainDashboard)
    await main.waitForSelector(COMPANION_RETRY)
    await expectSnapshot(main, (snapshot) => snapshot.account?.userId === OWNER.id && snapshot.account?.petType === 'pig'
      && snapshot.renderer?.[0]?.authenticated === true && snapshot.renderer?.[0]?.userId === OWNER.id,
    'the account and selected pig remain verified despite the companion relationship failure')
    const recoveryReads = stub.requests.slice(refreshStart).filter(({ method }) => method === 'GET')
    assert(recoveryReads.some(({ pathname }) => pathname === ME), 'The renderer did not verify its saved account again')
    assert(recoveryReads.some(({ pathname }) => pathname === RELATIONSHIP), 'The renderer did not encounter the companion outage')
    assert(await main.evaluate(`!document.querySelector(${JSON.stringify(`${WEEKLY}, ${REMINDER_AGENDA}, #delivered-reminders, #recurring-reminders`)})`),
      'Cloud companion management opened before relationship sync succeeded')

    await main.waitForSelector(focusState('paused'))
    const pausedHandoff = `${TODAY_ACTIVE}[data-focus-status="paused"]`
    await main.waitForSelector(pausedHandoff)
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(pausedHandoff)})?.textContent.includes(${JSON.stringify(intention)})`),
      'Today lost the paused intention during the relationship outage')
    assertEqual(await readTimer(main), pausedTime, 'Reloading during companion failure advanced paused time')
    await observeFocus(main)

    await main.click(TODAY_ACTION)
    await main.waitForSelector(focusState('running'))
    await waitFor(() => main.evaluate(`document.activeElement?.matches(${JSON.stringify(FOCUS_PANEL)})`),
      { description: 'the Today action focuses the resumed timer' })
    const resumed = await waitForFocusState(main, 'running')
    assertEqual(resumed.id, paused.id, 'The Today action replaced the paused session')
    assertEqual(resumed.revision, paused.revision + 1, 'The Today action did not resume the original session exactly once')
    assertEqual(resumed.intention, paused.intention, 'Resuming during companion failure changed the focus intention')
    assertEqual(resumed.durationMs, paused.durationMs, 'Resuming during companion failure changed the session duration')
    await main.waitForSelector(COMPANION_RETRY)

    restoreRelationship()
    await main.click(COMPANION_RETRY)
    await main.waitForSelector(`${WEEKLY}[aria-busy="false"]`)
    await main.waitForSelector('#delivered-reminders')
    await main.waitForSelector(REMINDER_AGENDA)
    assert(await main.evaluate(`!document.querySelector(${JSON.stringify(COMPANION_RETRY)})`), 'The recovered relationship still shows a retry banner')
    await main.waitForSelector(focusState('running'))
    await main.click('[data-e2e="focus-end"]')
    await main.waitForSelector(focusState('idle'))
    return { verifiedAccount: true, pausedFocusRetained: true, sameSessionResumedOnce: true, cloudManagementRecovered: true }
  } finally {
    restoreRelationship()
    await main.evaluate('window.stopCompanionSyncFocusObservation?.()')
  }
}
