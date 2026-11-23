import { setTimeout as delay } from 'node:timers/promises'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship, createReminderRecord } from './fixtures.mjs'
import { callE2e, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 884, username: 'renderer-recovery-owner', email: 'renderer-recovery-owner@example.test', password: 'renderer-recovery-fixture-884' }

function crash(page) {
  // The renderer terminates before the crashing command can reply.
  void page.send('Page.crash', {}, { timeoutMs: 5_000 }).catch(() => {})
}

function isPetReminderRead({ method, pathname, search }) {
  const params = new URLSearchParams(search)
  return method === 'GET' && pathname === '/api/v1/reminders' && params.has('due_before') && params.get('triggered') === 'false'
}

async function recoverVisibleReminder({ pages: { main, pet }, stub }, account, requestStart) {
  await waitFor(() => stub.requests.slice(requestStart).some(isPetReminderRead),
    { description: 'the visible pet starts its reminder scheduler' })
  const visible = () => main.evaluate('window.desktopBridge.getRuntimeState().then(state => state.windows.petVisible)')
  const bounds = () => main.evaluate('window.desktopBridge.getPetBounds().then(JSON.stringify)')
  const initialBounds = await bounds()
  assertEqual(await visible(), true, 'The pet must be visible before its renderer crashes')
  const generation = await main.evaluate('window.desktopBridge.getSessionSnapshot().then(session => session?.generation)')
  const before = await callE2e(main, 'snapshot')
  const reminder = createReminderRecord({
    user: OWNER, id: stub.fixture.nextReminderId++, title: '桌宠恢复后接着提醒',
    remindAt: new Date(Date.now() - 2000),
  })
  await pet.evaluate('window.__rendererRecoveryOldDocument = true')

  let crashed = false
  let reloads = 0
  const offCrash = pet.on('Inspector.targetCrashed', () => {
    crashed = true
    account.reminders = [reminder]
  })
  const offReload = pet.on('Inspector.targetReloadedAfterCrash', () => { reloads += 1 })
  try {
    await pet.send('Inspector.enable')
    crash(pet)
    await waitFor(() => crashed, { description: 'the visible pet renderer crash' })
    await waitFor(() => pet.evaluate(`Boolean(window.desktopBridge && !window.__rendererRecoveryOldDocument
      && document.visibilityState === 'visible' && document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.petSurface)}))`, { timeoutMs: 1000 }),
    { description: 'the visible pet renderer to recover automatically' })
    await waitFor(() => reminder.triggered_at, { description: 'the recovered pet to deliver the overdue reminder' })
    const acknowledgments = stub.requests.filter((request) => request.method === 'POST'
      && request.pathname === `/api/v1/reminders/${reminder.id}/trigger`)
    assertEqual(reloads, 1, 'Expected one automatic recovery for the visible pet')
    assertEqual(await visible(), true, 'The pet should still be visible after recovery')
    assertEqual(await bounds(), initialBounds, 'Automatic recovery moved or resized the pet')
    assertEqual(await pet.evaluate('window.desktopBridge.getSessionSnapshot().then(session => session?.generation)'),
      generation, 'Automatic recovery changed the session generation')
    assertEqual(acknowledgments.length, 1, 'Expected one acknowledgment for the visible reminder')
    assertEqual(new URLSearchParams(acknowledgments[0].search).get('expected_remind_at'), reminder.remind_at,
      'Visible recovery acknowledged a different scheduled occurrence')
    assertEqual((await callE2e(main, 'snapshot')).reminderNotificationAttempts - before.reminderNotificationAttempts,
      1, 'Expected one accepted native submission for the visible reminder')
    return { automaticReloads: 1, nativeSubmissions: 1, acknowledgments: 1, keptWindowBounds: true }
  } finally {
    offCrash()
    offReload()
  }
}

async function recoverHiddenReminder({ pages: { main, pet }, stub }, account, requestStart) {
  await waitFor(() => stub.requests.slice(requestStart).some(isPetReminderRead),
    { description: 'the signed-in pet starts its reminder scheduler' })
  const reminder = createReminderRecord({
    user: OWNER, id: stub.fixture.nextReminderId++, title: '桌宠隐藏时也要送达的提醒',
    remindAt: new Date(Date.now() - 2000),
  })
  const acknowledgments = () => stub.requests.filter((request) => request.method === 'POST'
    && request.pathname === `/api/v1/reminders/${reminder.id}/trigger`)
  const before = await callE2e(main, 'snapshot')
  const generation = await main.evaluate('window.desktopBridge.getSessionSnapshot().then(session => session?.generation)')
  const isPetVisible = () => main.evaluate('window.desktopBridge.getRuntimeState().then(state => state.windows.petVisible)')
  assertEqual(await callE2e(main, 'hideWindow', 'pet'), true, 'Pet fixture window did not hide')
  await waitFor(() => pet.evaluate("document.visibilityState === 'hidden'"), { description: 'pet hidden before crashing' })
  await pet.evaluate('window.__rendererRecoveryOldDocument = true')

  let crashes = 0
  let reloads = 0
  const firstRead = stub.holdNext('GET', '/api/v1/reminders', null, isPetReminderRead)
  const offCrash = pet.on('Inspector.targetCrashed', () => {
    crashes += 1
    if (crashes === 1) {
      account.reminders = [reminder]
      firstRead.release()
    }
  })
  const offReload = pet.on('Inspector.targetReloadedAfterCrash', () => { reloads += 1 })
  const expectHiddenPetReady = () => waitFor(() => pet.evaluate(`Boolean(window.desktopBridge && !window.__rendererRecoveryOldDocument
    && document.visibilityState === 'hidden' && document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.petSurface)}))`, { timeoutMs: 1000 }),
  { description: 'the recovered pet renderer while its window stays hidden' })
  try {
    await pet.send('Inspector.enable')
    crash(pet)
    await waitFor(() => crashes === 1, { description: 'the hidden pet renderer crashes after the reminder is armed' })
    await waitFor(() => reminder.triggered_at, { description: 'the overdue reminder is acknowledged without opening the crashed pet' })
    await expectHiddenPetReady()
    assertEqual(reloads, 1, 'Expected one initial automatic recovery')
    assertEqual(await isPetVisible(), false, 'Reminder recovery revealed the hidden pet')
    assertEqual(acknowledgments().length, 1, 'Expected one acknowledgment for the hidden reminder')
    assertEqual(new URLSearchParams(acknowledgments()[0].search).get('expected_remind_at'), reminder.remind_at,
      'Hidden recovery acknowledged a different scheduled occurrence')
    assertEqual((await callE2e(main, 'snapshot')).reminderNotificationAttempts - before.reminderNotificationAttempts,
      1, 'Expected one accepted native submission for the hidden reminder')

    await pet.evaluate('window.__rendererRecoveryOldDocument = true')
    crash(pet)
    await waitFor(() => crashes === 2, { description: 'a second crash in the same recovery burst' })
    await delay(500)
    assertEqual(reloads, 1, 'A repeated crash restarted the hidden renderer again automatically')
    assertEqual(await callE2e(main, 'simulateSystemResume'), true, 'System resume did not run')
    await expectHiddenPetReady()
    assertEqual(reloads, 2, 'A later resume should recover the capped renderer once')
    assertEqual(await isPetVisible(), false, 'Resume revealed the hidden pet')
    assertEqual(await pet.evaluate('window.desktopBridge.getSessionSnapshot().then(session => session?.generation)'),
      generation, 'Background recovery changed the session generation')
    assertEqual(acknowledgments().length, 1, 'Later resume tried to acknowledge the delivered reminder again')
    assertEqual((await callE2e(main, 'snapshot')).reminderNotificationAttempts - before.reminderNotificationAttempts,
      1, 'Later resume resubmitted the delivered native notification')
    await callE2e(main, 'showWindow', 'pet')
    assertEqual(await isPetVisible(), true, 'The recovered pet did not open normally')
    return { automaticReloads: 1, resumeReloads: 1, nativeSubmissions: 1, acknowledgments: 1, stayedHidden: true }
  } finally {
    firstRead.release()
    offCrash()
    offReload()
  }
}

async function reopenAfterCrash({ page, controller, role, visibility, open, selector }) {
  await page.evaluate('window.__rendererRecoveryOldDocument = true')
  assertEqual(await callE2e(controller, 'hideWindow', role), true, `${role} fixture window did not hide`)

  let crashed = false
  let reloaded = false
  const offCrash = page.on('Inspector.targetCrashed', () => { crashed = true })
  const offReload = page.on('Inspector.targetReloadedAfterCrash', () => { reloaded = true })
  try {
    await page.send('Inspector.enable')
    crash(page)
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
  const { main, quick } = context.pages
  const relationship = createRelationship(OWNER)
  const account = {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', relationship]]), sessions: [], documents: [], reminders: [],
  }
  context.stub.fixture.accounts.set(OWNER.id, account)
  const requestStart = context.stub.requests.length
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)

  const visibleReminder = await recoverVisibleReminder(context, account, requestStart)
  // Recreate the fixture window so the hidden case starts outside the visible case's crash cooldown.
  const oldPetTarget = context.targets.get('pet.html').id
  context.pages.pet.close()
  context.clientsByTargetId.delete(oldPetTarget)
  assertEqual(await callE2e(main, 'destroyWindow', 'pet'), true, 'The visible pet fixture did not close')
  const hiddenRequestStart = context.stub.requests.length
  assertEqual(await callE2e(main, 'recreateWindow', 'pet'), true, 'The hidden pet fixture did not start')
  const pet = await waitFor(async () => {
    await context.refreshTargets({ requireComplete: false })
    return context.targets.get('pet.html')?.id !== oldPetTarget && context.pages.pet
  }, { description: 'a fresh pet renderer for the hidden case' })
  const hiddenReminder = await recoverHiddenReminder(context, account, hiddenRequestStart)
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

  return { recovered: ['pet', 'main-panel', 'quick-chat'], visibleReminder, hiddenReminder }
}
