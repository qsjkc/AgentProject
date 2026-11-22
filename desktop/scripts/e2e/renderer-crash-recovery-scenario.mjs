import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { callE2e, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 884, username: 'renderer-recovery-owner', email: 'renderer-recovery-owner@example.test', password: 'renderer-recovery-fixture-884' }

async function reopenAfterCrash({ page, controller, role, visibility, open, selector }) {
  await page.evaluate('window.__rendererRecoveryOldDocument = true')
  assertEqual(await callE2e(controller, 'hideWindow', role), true, `${role} fixture window did not hide`)

  let crashed = false
  let reloaded = false
  const offCrash = page.on('Inspector.targetCrashed', () => { crashed = true })
  const offReload = page.on('Inspector.targetReloadedAfterCrash', () => { reloaded = true })
  try {
    await page.send('Inspector.enable')
    // The renderer terminates before the crashing command can reply.
    void page.send('Page.crash', {}, { timeoutMs: 5_000 }).catch(() => {})
    await waitFor(() => crashed, { timeoutMs: 5_000, description: `${role} renderer process to crash` })

    assertEqual(await controller.evaluate(`window.desktopBridge.getRuntimeState().then(state => state.windows.${visibility})`), false,
      `${role} became visible before being opened`)
    assert(!reloaded, `${role} renderer reloaded before being opened`)
    assert(await controller.evaluate(open), `${role} open action failed after the renderer crash`)

    await waitFor(() => page.evaluate(`Boolean(window.desktopBridge && !window.__rendererRecoveryOldDocument
      && document.querySelector(${JSON.stringify(selector)}))`, { timeoutMs: 1000 }), {
      timeoutMs: 10_000,
      description: `${role} renderer to restore its UI through the normal open action`,
    })
    assertEqual(await page.evaluate(`window.desktopBridge.getRuntimeState().then(state => state.windows.${visibility})`), true,
      `${role} was not visible after opening`)
    assertEqual(await page.evaluate('window.desktopBridge.getSessionSnapshot().then(session => session?.generation)'),
      await controller.evaluate('window.desktopBridge.getSessionSnapshot().then(session => session?.generation)'),
      `${role} recovery lost the current session`)
  } finally {
    offCrash()
    offReload()
  }
}

export async function rendererCrashRecoveryScenario(context) {
  const { main, pet, quick } = context.pages
  const relationship = createRelationship(OWNER)
  context.stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)

  await reopenAfterCrash({
    page: pet, controller: main, role: 'pet', visibility: 'petVisible',
    open: 'window.desktopBridge.showPet()', selector: REQUIRED_SELECTORS.petSurface,
  })
  assertEqual(await pet.evaluate('window.desktopBridge.openToday()'), true, 'Restored pet renderer could not make a trusted Today request')

  await reopenAfterCrash({
    page: main, controller: pet, role: 'main-panel', visibility: 'mainPanelVisible',
    open: 'window.desktopBridge.openMainPanel()', selector: REQUIRED_SELECTORS.mainDashboard,
  })
  assertEqual(await pet.evaluate('window.desktopBridge.openToday()'), true, 'Restored main panel could not acknowledge a trusted Today request')

  await reopenAfterCrash({
    page: quick, controller: pet, role: 'quick-chat', visibility: 'quickChatVisible',
    open: 'window.desktopBridge.toggleQuickChat()', selector: REQUIRED_SELECTORS.quickChatInput,
  })
  assertEqual(await quick.evaluate('window.desktopBridge.openToday()'), true, 'Restored Quick Chat could not make a trusted Today request')
  assertEqual(await pet.evaluate('window.desktopBridge.toggleQuickChat()'), false, 'Toggling the restored visible Quick Chat did not hide it')

  return { recovered: ['pet', 'main-panel', 'quick-chat'] }
}
