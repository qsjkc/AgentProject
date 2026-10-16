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
  await context.pages.main.click(REQUIRED_SELECTORS.onboardingReminderCreate)
  const reminder = await waitFor(() => account.reminders.find((item) => item.pet_type === petType), {
    description: `${petType} onboarding reminder creation`,
  })
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

async function equipScarfAndPauseFocus(context, petType) {
  const main = context.pages.main
  const outfit = `[data-item-id="${petType}_basic_scarf"]`
  await main.click(outfit)
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
    results[petType].pausedTime = await equipScarfAndPauseFocus(context, petType)
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
  return { pets: results, petSwitchIsolation: true, actualToolbar: true, realOnboardingReminderFlow: true, localStubOnly: true }
}
