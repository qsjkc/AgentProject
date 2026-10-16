import { assert, assertEqual, waitFor } from './assertions.mjs'
import { USERS, createRelationship, createStubFixture } from './fixtures.mjs'
import {
  REQUIRED_SELECTORS,
  callE2e,
  ensureBaseBridge,
  expectSnapshot,
  hideMainPanel,
  loginAs,
  resetToLoggedOut,
} from './p1k-scenarios.mjs'

const focusPanel = '[data-e2e="focus-panel"]'
const focusState = (status) => `${focusPanel}[data-focus-status="${status}"]`
const requestBody = (request) => {
  try { return JSON.parse(request.body) } catch { return {} }
}

async function selectPet(context, petType) {
  await callE2e(context.pages.main, 'showWindow', 'main-panel')
  // The dashboard mounts before the login relationship capability is adopted.
  // Wait for that initial handoff (and any preceding switch) before asking the
  // real selector to start a new account-scoped request.
  await expectSnapshot(context.pages.main, (snapshot) => (
    snapshot.account?.userId === USERS.A.id
    && snapshot.relationship?.pet_type === snapshot.account?.petType
    && snapshot.relationship?.user_id === USERS.A.id
    && snapshot.renderer?.[0]?.relationshipId === snapshot.relationship?.id
    && snapshot.relationshipCapabilityAdopted === true
  ), 'current relationship ready before switching pets')
  await waitFor(() => context.pages.main.evaluate(`(() => {
    const target = document.querySelector('[data-e2e="pet-option-${petType}"]')
    return target && !target.disabled
      && Boolean(document.querySelector('[data-e2e="pet-relationship-summary"]'))
      && !document.querySelector('.main-companion-sync')
  })()`), { description: `${petType} selector ready after relationship sync` })
  await context.pages.main.click(`[data-e2e="pet-option-${petType}"]`)
  await expectSnapshot(context.pages.main, (snapshot) => (
    snapshot.account?.petType === petType
    && snapshot.relationship?.pet_type === petType
    && snapshot.relationship?.id === createRelationship(USERS.A, petType).id
    && snapshot.renderer?.[0]?.relationshipId === snapshot.relationship.id
  ), `${petType} selected and relationship hydrated`)
  await expectSnapshot(context.pages.pet, (snapshot) => (
    snapshot.account?.petType === petType
    && snapshot.onboarding?.pet_type === petType
    && snapshot.onboarding?.relationship_id === createRelationship(USERS.A, petType).id
    && snapshot.renderer?.[0]?.onboardingCurrent === true
  ), `${petType} desktop onboarding context hydrated`)
}

async function verifyCompanionPanels(context, petType) {
  const main = context.pages.main
  await main.waitForSelector(REQUIRED_SELECTORS.relationshipSummary)
  await main.waitForSelector('[data-e2e="pet-daily-summary"]')
  await main.waitForSelector('[data-e2e="pet-weekly-summary"][aria-busy="false"]')
  await main.waitForSelector(`[data-item-id="${petType}_basic_scarf"]`)
  await main.waitForSelector(focusPanel)
  for (const summary of ['daily-summary', 'weekly-summary']) {
    assert(context.stub.requests.some((request) => (
      request.method === 'GET' && request.pathname === `/api/v1/pets/${petType}/${summary}`
    )), `${petType} ${summary} was not fetched`)
  }
  assert(!await main.evaluate(`Boolean(document.querySelector('.pet-weekly-error'))`), `${petType} weekly review failed`)
  await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
  await main.click('[data-e2e="open-focus"]')
  await main.waitForSelector(focusPanel)
}

async function exerciseCareAndReminder(context, petType) {
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const beforeCare = context.stub.requests.length
  await hideMainPanel(context)
  await callE2e(context.pages.pet, 'showWindow', 'pet')
  await context.pages.pet.click(REQUIRED_SELECTORS.petCarePat)
  await waitFor(() => context.stub.requests.slice(beforeCare).some((request) => (
    request.method === 'POST'
    && request.pathname === `/api/v1/pets/${petType}/relationship/rewards`
    && requestBody(request).action === 'pat'
  )), { description: `${petType} care reward from the actual toolbar` })
  const patRequests = context.stub.requests.slice(beforeCare).filter((request) => (
    request.pathname.endsWith('/relationship/rewards') && requestBody(request).action === 'pat'
  ))
  assert(patRequests.every((request) => request.pathname === `/api/v1/pets/${petType}/relationship/rewards`), 'Care reward crossed pets', { patRequests })
  await expectSnapshot(context.pages.pet, (snapshot) => (
    snapshot.onboarding?.pet_type === petType
    && snapshot.onboarding?.observed_capability_ids?.includes('pet_interaction')
  ), `${petType} care observation recorded`)

  await callE2e(context.pages.main, 'showWindow', 'main-panel')
  await context.pages.main.waitForSelector(REQUIRED_SELECTORS.onboardingReminderCreate)
  const outfit = `[data-item-id="${petType}_basic_scarf"]`
  const heldRefresh = context.stub.holdNext('GET', `/api/v1/pets/${petType}/relationship`)
  let refreshArrived = false
  void heldRefresh.arrived.then(() => { refreshArrived = true })
  let reminder
  try {
    await context.pages.main.click(REQUIRED_SELECTORS.onboardingReminderCreate)
    reminder = await waitFor(() => account.reminders.find((item) => item.pet_type === petType), {
      description: `${petType} onboarding reminder creation`,
    })
    await waitFor(() => refreshArrived, { description: `${petType} post-reminder relationship refresh` })
    assert(await context.pages.main.evaluate(`document.querySelector(${JSON.stringify(outfit)})?.disabled`),
      'Outfit allowed a write while the reminder was replacing its relationship capability')
    const requestsBeforeClick = context.stub.requests.length
    await context.pages.main.click(outfit)
    assert(!context.stub.requests.slice(requestsBeforeClick).some((request) => request.pathname.endsWith('/relationship/outfit')),
      'A disabled outfit control still issued a mutation')
  } finally {
    heldRefresh.release()
  }
  await waitFor(() => context.pages.main.evaluate(`document.querySelector(${JSON.stringify(outfit)})?.disabled === false`),
    { description: `${petType} outfit ready after relationship cache transition` })
  await context.pages.main.click(outfit)
  await waitFor(() => context.stub.requests.slice(beforeCare).some((request) => (
    request.method === 'POST'
    && request.pathname === `/api/v1/pets/${petType}/relationship/rewards`
    && requestBody(request).action === 'dress_up'
  )), { description: `${petType} outfit save continues to its reward with the new capability` })
  await waitFor(() => context.pages.main.evaluate(`(() => {
    const option = document.querySelector(${JSON.stringify(outfit)})
    return option?.getAttribute('aria-pressed') === 'true'
      && option.closest('.outfit-panel')?.querySelector('.outfit-clear-button')?.disabled === false
  })()`), { description: `${petType} outfit save and reward settle visibly` })
  assert(Math.abs(Date.parse(reminder.remind_at) - Date.now() - 60_000) < 15_000,
    'Sample reminder is not approximately one minute ahead', { petType, reminder })
  assertEqual(reminder.user_id, USERS.A.id, 'Sample reminder belongs to the wrong account')
  const createdRequests = context.stub.requests.slice(beforeCare).filter((request) => (
    request.method === 'POST' && request.pathname === '/api/v1/reminders'
  ))
  assertEqual(createdRequests.length, 1, 'Onboarding created duplicate reminders')
  assertEqual(requestBody(createdRequests[0]).pet_type, petType, 'Onboarding posted the wrong pet_type')

  reminder.remind_at = new Date(Date.now() - 1_000).toISOString()
  await callE2e(context.pages.pet, 'flushReminderPoll')
  await context.pages.main.click(REQUIRED_SELECTORS.pendingReminderRefresh)
  const complete = REQUIRED_SELECTORS.pendingReminderComplete.replace('{id}', String(reminder.id))
  await context.pages.main.waitForSelector(complete)
  await context.pages.main.click(complete)
  const completed = await expectSnapshot(context.pages.main, (snapshot) => (
    snapshot.onboarding?.pet_type === petType && snapshot.onboarding?.status === 'completed'
  ), `${petType} onboarding completion`)
  return { reminderId: reminder.id, onboarding: completed.onboarding }
}

async function verifyScarfAndPauseFocus(context, petType) {
  const main = context.pages.main
  const outfit = `[data-item-id="${petType}_basic_scarf"]`
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(outfit)})?.getAttribute('aria-pressed') === 'true'`), {
    description: `${petType} scarf visibly equipped`,
  })
  assertEqual(context.stub.fixture.accounts.get(USERS.A.id).relationshipByPet.get(petType).outfit.equipped_outfits.neck,
    `${petType}_basic_scarf`, 'Equipped outfit was saved to the wrong relationship')
  await main.waitForSelector(focusState('idle'))
  await main.input('[data-e2e="focus-intention"]', `${petType} exclusive focus`)
  await main.click('[data-e2e="focus-start"]')
  await main.waitForSelector(focusState('running'))
  await main.click('[data-e2e="focus-toggle"]')
  await main.waitForSelector(focusState('paused'))
  return main.evaluate(`document.querySelector('[data-e2e="focus-time"]')?.textContent`)
}

async function verifyChatReminderRefresh(context, petType) {
  const main = context.pages.main
  const outfit = `[data-item-id="${petType}_basic_scarf"]`
  const clear = '.outfit-clear-button'
  await waitFor(() => main.evaluate(`document.querySelector('${clear}')?.disabled === false`),
    { description: 'previous outfit operation settled' })
  await main.click(clear)
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(outfit)})?.disabled === false`),
    { description: 'scarf removed before chat reminder' })
  await main.input('[data-e2e="main-chat-input"]', '十分钟后提醒我看看窗外')
  const before = context.stub.requests.length
  const heldRefresh = context.stub.holdNext('GET', `/api/v1/pets/${petType}/relationship`)
  let arrived = false
  void heldRefresh.arrived.then(() => { arrived = true })
  try {
    await main.click('[data-e2e="main-chat-send"]')
    await waitFor(() => arrived, { description: 'chat reminder post-create relationship refresh' })
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(outfit)})?.disabled`),
      'Chat reminder released outfit controls before its relationship cache settled')
    assert(await main.evaluate("/发送中|Sending/.test(document.querySelector('[data-e2e=main-chat-send]')?.textContent)"),
      'Chat reminder left its sending state before its relationship cache settled')
  } finally {
    heldRefresh.release()
  }
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(outfit)})?.disabled === false`),
    { description: 'chat reminder releases outfit controls after adopting its new capability' })
  await main.click(outfit)
  await waitFor(() => context.stub.requests.slice(before).some((request) => (
    request.method === 'POST'
    && request.pathname === `/api/v1/pets/${petType}/relationship/rewards`
    && requestBody(request).action === 'dress_up'
  )), { description: 'outfit reward after chat reminder refresh' })
  await waitFor(() => main.evaluate(`document.querySelector('${clear}')?.disabled === false`),
    { description: 'outfit completes after chat reminder capability transition' })
  assertEqual(context.stub.requests.slice(before).filter((request) => (
    request.method === 'POST' && request.pathname === '/api/v1/reminders'
  )).length, 1, 'Chat reminder synchronization created duplicate reminders')

  await main.input('[data-e2e="main-chat-input"]', '十一分钟后提醒我旧账号刷新边界')
  const staleRefresh = context.stub.holdNext('GET', `/api/v1/pets/${petType}/relationship`)
  let staleArrived = false
  void staleRefresh.arrived.then(() => { staleArrived = true })
  let requestId
  try {
    await main.click('[data-e2e="main-chat-send"]')
    await waitFor(() => staleArrived, { description: 'account A reminder relationship response held' })
    requestId = main.diagnostics.network.findLast((entry) => (
      entry.method === 'Network.requestWillBeSent'
      && entry.request?.url.endsWith(`/pets/${petType}/relationship`)
    ))?.requestId
    assert(requestId, 'Missing held relationship network request')
    await main.click(REQUIRED_SELECTORS.logout)
    await loginAs(context, USERS.B)
    await expectSnapshot(main, (snapshot) => (
      snapshot.account?.userId === USERS.B.id && snapshot.relationship?.user_id === USERS.B.id
      && snapshot.renderer?.[0]?.relationshipId === createRelationship(USERS.B).id
    ), 'account B settled while account A response remains held')
  } finally {
    staleRefresh.release()
  }
  await waitFor(() => main.diagnostics.network.some((entry) => (
    entry.requestId === requestId && entry.method === 'Network.responseReceived'
  )), { description: 'released account A response arrives after account switch' })
  await main.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const afterSwitch = await callE2e(main, 'snapshot')
  assertEqual(afterSwitch.relationship?.user_id, USERS.B.id, 'Late account A refresh contaminated account B')
  assertEqual(afterSwitch.relationship?.pet_type, 'pig', 'Late dog refresh contaminated account B default pet')
  assert(!afterSwitch.activityJournal?.some((entry) => entry.userId === USERS.A.id
    && entry.afterAccountSwitch && entry.path === `/pets/${petType}/relationship`),
  'Late account A relationship response was accepted after switching accounts')
  return { heldRefreshBlockedOutfit: true, saveAndRewardAfterRefresh: true, lateAccountResponseRejected: true }
}

export async function petParityScenario(context) {
  assertEqual(new URL(context.stub.apiBaseUrl).hostname, '127.0.0.1', 'Pet parity must use the local stub')
  await ensureBaseBridge(context)
  // Only this in-memory stub fixture is replaced. The runner already isolates
  // Electron userData and forces all three renderers to the local API origin.
  context.stub.fixture = createStubFixture()
  await resetToLoggedOut(context)
  await loginAs(context, USERS.A)
  const results = {}
  for (const petType of ['cat', 'dog']) {
    await selectPet(context, petType)
    await verifyCompanionPanels(context, petType)
    await context.pages.main.waitForSelector(focusState('idle'))
    assertEqual(await context.pages.main.evaluate(`document.querySelector('[data-e2e="focus-intention"]')?.value`), '',
      `${petType} inherited another pet's focus intention`)
    const before = await callE2e(context.pages.main, 'snapshot')
    assert(before.onboarding?.status !== 'completed', `${petType} inherited completed onboarding`)
    results[petType] = await exerciseCareAndReminder(context, petType)
    results[petType].pausedTime = await verifyScarfAndPauseFocus(context, petType)
    await context.pages.main.screenshot(`${context.artifactPath}/${petType}-parity.png`)
  }
  assert(results.cat.reminderId !== results.dog.reminderId, 'Cat and dog shared the same sample reminder')
  for (const petType of ['cat', 'dog']) {
    await selectPet(context, petType)
    await context.pages.main.waitForSelector(focusState('paused'))
    const restored = await callE2e(context.pages.main, 'snapshot')
    assertEqual(restored.onboarding?.status, 'completed', `${petType} onboarding completion was lost`)
    assertEqual(restored.onboarding?.relationship_id, results[petType].onboarding.relationship_id,
      `${petType} resumed another relationship's onboarding`)
    assertEqual(await context.pages.main.evaluate(`document.querySelector('[data-e2e="focus-time"]')?.textContent`),
      results[petType].pausedTime, `${petType} paused focus did not survive pet switching`)
    assert(await context.pages.main.evaluate(`document.querySelector(${JSON.stringify(focusPanel)})?.textContent.includes(${JSON.stringify(`${petType} exclusive focus`)})`),
      `${petType} restored another pet's focus intention`)
    assertEqual(restored.relationship?.outfit?.equipped_outfits?.neck, `${petType}_basic_scarf`,
      `${petType} restored another pet's outfit`)
    await context.pages.main.click('[data-e2e="focus-end"]')
    await context.pages.main.waitForSelector(focusState('idle'))
  }
  const chatReminderRefresh = await verifyChatReminderRefresh(context, 'dog')
  return { pets: results, petSwitchIsolation: true, actualToolbar: true, realOnboardingReminderFlow: true, chatReminderRefresh, localStubOnly: true }
}
