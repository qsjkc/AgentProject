import { readFile } from 'node:fs/promises'
import { assert, assertEqual, assertIncludes, waitFor } from './assertions.mjs'
import {
  CAPABILITY_TTL_MS,
  E2E_PROTOCOL_VERSION,
  USERS,
  createJwt,
  createRelationship,
  createReminderRecord,
} from './fixtures.mjs'

export const REQUIRED_E2E_BRIDGE_API = Object.freeze({
  protocolVersion: E2E_PROTOCOL_VERSION,
  methods: Object.freeze([
    'describe',
    'reset',
    'snapshot',
    'showWindow',
    'setReminderNotificationOutcome',
    'setReminderNotificationReplyHold',
    'prepareOnboarding',
    'expireOperationCapabilities',
    'switchAccount',
    'destroyWindow',
    'recreateWindow',
    'setMainPanelIntentAckMode',
    'broadcastRelationshipTo',
    'flushReminderPoll',
    'simulateSystemResume',
    'triggerRelationshipRefresh',
  ]),
})

// These intentionally require stable renderer-owned attributes. The E2E runner does
// not fall back to translated copy or element order because that would create false
// positives after harmless layout/copy changes.
export const REQUIRED_SELECTORS = Object.freeze({
  loginApiBaseUrl: '[data-e2e="login-api-base-url"]',
  loginUsername: '[data-e2e="login-username"]',
  loginPassword: '[data-e2e="login-password"]',
  loginSubmit: '[data-e2e="login-submit"]',
  logout: '[data-e2e="logout"]',
  mainDashboard: '[data-e2e="main-dashboard"]',
  mainTabKnowledge: '[data-e2e="main-tab-knowledge"]',
  petOptionPig: '[data-e2e="pet-option-pig"]',
  petSurface: '[data-e2e="pet-surface"]',
  petCarePat: '[data-action="pat"]',
  petMeetGuide: '[data-e2e="p1k-guide-meet_pet"]',
  petRelationshipGuide: '[data-e2e="p1k-guide-relationship"]',
  openRelationship: '[data-e2e="p1k-open-relationship"]',
  relationshipSummary: '[data-e2e="pet-relationship-summary"]',
  onboardingReminderCreate: '[data-e2e="p1k-create-reminder"]',
  openOnboarding: '[data-e2e="open-onboarding"]',
  pendingReminderRefresh: '[data-e2e="pending-reminder-refresh"]',
  pendingReminderItem: '[data-e2e-reminder-id="{id}"]',
  pendingReminderComplete: '[data-e2e-reminder-complete="{id}"]',
  quickChatInput: '[data-e2e="quick-chat-input"]',
  quickChatSend: '[data-e2e="quick-chat-send"]',
  quickChatAssistantMessage: '[data-e2e="quick-chat-assistant-message"]',
})

function selectorFor(template, id) {
  return template.replace('{id}', String(id))
}

function withTimeout(promise, timeoutMs, description) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

async function bridgeShape(client) {
  return client.evaluate(`(() => {
    const e2e = window.desktopBridge?.e2e;
    return {
      desktopBridge: Boolean(window.desktopBridge),
      e2e: Boolean(e2e),
      protocolVersion: e2e?.protocolVersion ?? null,
      methods: e2e ? Object.keys(e2e).filter((key) => typeof e2e[key] === 'function') : [],
    };
  })()`)
}

export async function requireE2eBridge(client, role, methods = REQUIRED_E2E_BRIDGE_API.methods) {
  const shape = await bridgeShape(client)
  if (!shape.e2e) {
    throw new Error(
      `Missing dev-only window.desktopBridge.e2e bridge in ${role}. `
      + 'The CDP runner is ready, but main/preload hooks have not been implemented.',
    )
  }
  assertEqual(
    shape.protocolVersion,
    REQUIRED_E2E_BRIDGE_API.protocolVersion,
    `Unsupported desktopBridge.e2e protocol in ${role}`,
  )
  for (const method of methods) {
    assertIncludes(shape.methods, method, `Missing desktopBridge.e2e.${method}() in ${role}`)
  }
  return shape
}

export async function callE2e(client, method, ...args) {
  const encodedMethod = JSON.stringify(method)
  const encodedArgs = JSON.stringify(args)
  return client.evaluate(`(async () => {
    const bridge = window.desktopBridge?.e2e;
    if (!bridge) throw new Error('desktopBridge.e2e is unavailable');
    const method = ${encodedMethod};
    if (typeof bridge[method] !== 'function') throw new Error('desktopBridge.e2e.' + method + ' is unavailable');
    return bridge[method](...${encodedArgs});
  })()`)
}

export async function expectSnapshot(client, predicate, description, timeoutMs = 10_000) {
  let lastSnapshot = null
  try {
    return await waitFor(async () => {
      lastSnapshot = await callE2e(client, 'snapshot')
      return predicate(lastSnapshot) ? lastSnapshot : null
    }, { timeoutMs, description })
  } catch (error) {
    error.details = { ...error.details, lastSnapshot }
    throw error
  }
}

export async function ensureBaseBridge(context) {
  await Promise.all([
    requireE2eBridge(context.pages.pet, 'pet'),
    requireE2eBridge(context.pages.quick, 'quick-chat'),
    requireE2eBridge(context.pages.main, 'main-panel'),
  ])
}

export async function resetToLoggedOut(context) {
  await callE2e(context.pages.main, 'reset', {
    protocolVersion: E2E_PROTOCOL_VERSION,
    account: null,
    relationship: null,
    onboarding: { reset: true },
  })
  await callE2e(context.pages.main, 'showWindow', 'main-panel')
  await context.pages.main.reload()
}

export async function loginAs(context, user) {
  const main = context.pages.main
  await main.input(REQUIRED_SELECTORS.loginApiBaseUrl, context.stub.apiBaseUrl)
  await main.input(REQUIRED_SELECTORS.loginUsername, user.username)
  await main.input(REQUIRED_SELECTORS.loginPassword, user.password)
  await main.click(REQUIRED_SELECTORS.loginSubmit)
  await main.waitForSelector(REQUIRED_SELECTORS.mainDashboard, { timeoutMs: 15_000 })
}

async function resetAuthenticated(context, user = USERS.A) {
  await callE2e(context.pages.main, 'reset', {
    protocolVersion: E2E_PROTOCOL_VERSION,
    account: { token: createJwt(user), userId: user.id, petType: 'pig' },
    relationship: createRelationship(user),
    onboarding: { reset: true },
  })
  await Promise.all([
    callE2e(context.pages.main, 'showWindow', 'main-panel'),
    callE2e(context.pages.pet, 'showWindow', 'pet'),
  ])
  await Promise.all([context.pages.main.reload(), context.pages.pet.reload()])
  await context.pages.main.waitForSelector(REQUIRED_SELECTORS.mainDashboard, { timeoutMs: 15_000 })
}

async function switchAccountViaUi(context, user) {
  await callE2e(context.pages.main, 'showWindow', 'main-panel')
  await context.pages.main.click(REQUIRED_SELECTORS.logout)
  await loginAs(context, user)
  await expectSnapshot(context.pages.main, (snapshot) => (
    snapshot.renderer?.[0]?.userId === user.id
    && snapshot.renderer?.[0]?.relationshipId === createRelationship(user).id
  ), 'new account dashboard hydration')
}

export async function hideMainPanel(context) {
  await context.pages.main.evaluate('window.desktopBridge?.hideMainPanel?.()')
}

async function prepareRelationshipGuide(context) {
  await callE2e(context.pages.main, 'showWindow', 'main-panel')
  await context.pages.main.click(REQUIRED_SELECTORS.mainTabKnowledge)
  await waitFor(
    () => context.pages.main.evaluate(`!document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.relationshipSummary)})`),
    { description: 'relationship card unmount before isolated guide fixture' },
  )
  await hideMainPanel(context)
  await callE2e(context.pages.pet, 'prepareOnboarding', { scene: 'relationship' })
}

function withProactiveCompanionDisabled(scenario) {
  return async (context) => {
    const previous = await context.pages.main.evaluate('window.desktopBridge.getCompanionSettings()')
    try {
      // Intent scenarios need an isolated relationship guide. Disable greetings
      // before reset/reload: a real daily greeting can legitimately occupy the
      // bubble for five seconds and race the guide's selector deadline in CI.
      await context.pages.main.evaluate('window.desktopBridge.updateCompanionSettings({ mode: "off" })')
      return await scenario(context)
    } finally {
      await context.pages.main.evaluate(`window.desktopBridge.updateCompanionSettings(${JSON.stringify(previous)})`)
    }
  }
}

export async function targetsScenario(context) {
  const entries = [...context.targets.keys()].sort()
  assertEqual(entries.length, 3, 'Expected exactly three Detachym renderer targets')
  assertIncludes(entries, 'pet.html')
  assertIncludes(entries, 'quick-chat.html')
  assertIncludes(entries, 'main-panel.html')
  for (const client of Object.values(context.pages)) await client.waitForReady()
  const bridge = await Promise.all(Object.entries(context.pages).map(async ([role, client]) => [role, await bridgeShape(client)]))
  for (const [role, shape] of bridge) {
    assert(
      shape.desktopBridge,
      `Electron ${role} target loaded React, but preload did not expose window.desktopBridge`,
      shape,
    )
  }
  const initialPetResources = await context.pages.pet.evaluate("performance.getEntriesByType('resource').map((entry) => entry.name.split('/').pop())")
  assert(!initialPetResources.some((name) => name.startsWith('index.esm.min-')), 'The idle pet eagerly loaded the RTC SDK', initialPetResources)
  return { entries, bridge, initialPetResources }
}

export async function happyPathScenario(context) {
  await ensureBaseBridge(context)
  await resetToLoggedOut(context)
  await loginAs(context, USERS.A)

  await context.pages.main.click(REQUIRED_SELECTORS.petOptionPig)
  await expectSnapshot(context.pages.main, (snapshot) => snapshot.account?.petType === 'pig', 'pig selection')
  await expectSnapshot(
    context.pages.main,
    (snapshot) => snapshot.relationship?.user_id === USERS.A.id && snapshot.relationship?.pet_type === 'pig',
    'authenticated pig relationship',
  )
  await hideMainPanel(context)

  await expectSnapshot(
    context.pages.pet,
    (snapshot) => snapshot.onboarding?.presentation?.step_id === 'meet_pet',
    'meet-pet presentation claim',
  )
  await context.pages.pet.waitForSelector(REQUIRED_SELECTORS.petMeetGuide)
  // A surface click enters RTC. Exercise the real care interaction instead,
  // and let onboarding advance without replacing its persistent state.
  await context.pages.pet.click(REQUIRED_SELECTORS.petCarePat)
  const relationshipStep = await expectSnapshot(
    context.pages.pet,
    (snapshot) => snapshot.onboarding?.observedRelationship
      || snapshot.onboarding?.presentation?.step_id === 'relationship',
    'relationship discovery or presentation claim',
  )
  if (relationshipStep.onboarding.observedRelationship) {
    // The login dashboard can already expose the relationship card. Discovery
    // is monotonic, so a user who saw it must not be forced through it again.
    await callE2e(context.pages.main, 'showWindow', 'main-panel')
  } else {
    await context.pages.pet.waitForSelector(REQUIRED_SELECTORS.petRelationshipGuide)
    await context.pages.pet.click(REQUIRED_SELECTORS.openRelationship)
  }
  await context.pages.main.waitForSelector(REQUIRED_SELECTORS.relationshipSummary)

  await context.pages.main.waitForSelector(REQUIRED_SELECTORS.onboardingReminderCreate)
  await context.pages.main.click(REQUIRED_SELECTORS.onboardingReminderCreate)
  const reminder = await waitFor(
    () => context.stub.fixture.accounts.get(USERS.A.id).reminders[0] || null,
    { timeoutMs: 10_000, description: 'one-minute reminder creation' },
  )
  assert(
    Math.abs(Date.parse(reminder.remind_at) - Date.now() - 60_000) < 15_000,
    'P1-K reminder was not scheduled approximately one minute ahead',
    { remindAt: reminder.remind_at },
  )

  reminder.remind_at = new Date(Date.now() - 1_000).toISOString()
  await callE2e(context.pages.pet, 'flushReminderPoll')
  await context.pages.main.click(REQUIRED_SELECTORS.pendingReminderRefresh)
  await context.pages.main.waitForSelector(selectorFor(REQUIRED_SELECTORS.pendingReminderItem, reminder.id))
  await context.pages.main.click(selectorFor(REQUIRED_SELECTORS.pendingReminderComplete, reminder.id))
  await expectSnapshot(
    context.pages.main,
    (snapshot) => snapshot.onboarding?.status === 'completed',
    'P1-K completion',
  )
  return { reminderId: reminder.id }
}

export async function capabilityTtlScenario(context) {
  await ensureBaseBridge(context)
  await resetAuthenticated(context)
  const main = context.pages.main
  await main.waitForSelector(REQUIRED_SELECTORS.relationshipSummary)
  const completedRelationships = (snapshot) => (snapshot.activityJournal || []).filter((entry) => (
    entry.kind === 'request' && entry.userId === USERS.A.id && entry.path === '/pets/pig/relationship' && entry.ok
  ))
  const previousCompletions = completedRelationships(await callE2e(main, 'snapshot')).length
  const before = context.stub.requests.length
  const expiry = await callE2e(main, 'expireOperationCapabilities')
  assert(expiry?.expired > 0, 'E2E hook did not expire an operation capability', expiry)
  await callE2e(main, 'triggerRelationshipRefresh')
  await waitFor(
    () => context.stub.requests.slice(before).some((request) => request.pathname === '/api/v1/pets/pig/relationship'),
    { timeoutMs: CAPABILITY_TTL_MS, description: 'real relationship request after capability TTL' },
  )
  const snapshot = await expectSnapshot(
    main,
    (value) => completedRelationships(value).length > previousCompletions,
    'successful post-TTL request commit',
  )
  return { expiry, completedRequest: completedRelationships(snapshot).at(-1) }
}

export async function mainReloadDuringIntentScenario(context) {
  await ensureBaseBridge(context)
  await resetAuthenticated(context)
  await prepareRelationshipGuide(context)
  await callE2e(context.pages.main, 'setMainPanelIntentAckMode', 'hold')
  await context.pages.pet.waitForSelector(REQUIRED_SELECTORS.openRelationship)
  const click = context.pages.pet.click(REQUIRED_SELECTORS.openRelationship)
  await expectSnapshot(context.pages.main, (snapshot) => snapshot.intent?.pending === true, 'pending main-panel intent')
  await context.pages.main.reload()
  await callE2e(context.pages.main, 'setMainPanelIntentAckMode', 'normal')
  await click
  const snapshot = await expectSnapshot(
    context.pages.main,
    (value) => value.intent?.pending === false && value.intent?.lastResult === true,
    'intent recovery after main reload',
    15_000,
  )
  return { intent: snapshot.intent }
}

export async function accountSwitchRaceScenario(context) {
  await ensureBaseBridge(context)
  await resetAuthenticated(context, USERS.A)
  const hold = context.stub.holdNext('GET', '/api/v1/pets/pig/relationship')
  const request = callE2e(context.pages.main, 'triggerRelationshipRefresh')
  await withTimeout(hold.arrived, 10_000, 'delayed account A relationship request')
  await switchAccountViaUi(context, USERS.B)
  hold.release()
  await request
  const snapshot = await expectSnapshot(
    context.pages.main,
    (value) => value.account?.userId === USERS.B.id
      && value.relationship?.user_id === USERS.B.id
      && value.renderer?.[0]?.userId === USERS.B.id
      && value.renderer?.[0]?.relationshipId === createRelationship(USERS.B).id,
    'account B state after delayed account A response',
  )
  assert(
    !snapshot.activityJournal?.some((entry) => entry.userId === USERS.A.id
      && entry.afterAccountSwitch
      && (entry.kind === 'intent' || entry.path === '/pets/pig/relationship')),
    'The held account A relationship response completed after switching to account B',
    snapshot.activityJournal,
  )

  // HTTP-completion telemetry can arrive after the switch even when a response
  // finished beforehand. Assert the deliberately held response and the actual
  // React account/relationship state, rather than treating all telemetry as UI commits.

  await switchAccountViaUi(context, USERS.A)
  await prepareRelationshipGuide(context)
  await callE2e(context.pages.main, 'setMainPanelIntentAckMode', 'hold')
  await context.pages.pet.waitForSelector(REQUIRED_SELECTORS.openRelationship)
  await context.pages.pet.click(REQUIRED_SELECTORS.openRelationship)
  await expectSnapshot(
    context.pages.main,
    (value) => value.intent?.pending === true && value.intent?.contextUserId === 101,
    'delayed account A intent',
  )
  await switchAccountViaUi(context, USERS.B)
  await callE2e(context.pages.main, 'setMainPanelIntentAckMode', 'normal')
  const intentSnapshot = await expectSnapshot(
    context.pages.main,
    (value) => value.account?.userId === 202 && value.intent?.pending === false,
    'account B state after delayed account A intent',
  )
  assert(
    !intentSnapshot.activityJournal?.some((entry) => entry.kind === 'intent' && entry.userId === USERS.A.id && entry.afterAccountSwitch),
    'Delayed account A intent committed after switching to account B',
    intentSnapshot.activityJournal,
  )
  return {
    account: intentSnapshot.account,
    relationship: intentSnapshot.relationship,
    activityJournal: intentSnapshot.activityJournal,
  }
}

export async function targetRecreateScenario(context) {
  await ensureBaseBridge(context)
  const oldTargetId = context.targets.get('main-panel.html').id
  // Release the debugger connection owned by the target we are about to destroy.
  context.pages.main.close()
  context.clientsByTargetId.delete(oldTargetId)
  await callE2e(context.pages.pet, 'destroyWindow', 'main-panel')
  await waitFor(async () => {
    const refreshed = await context.refreshTargets({ requireComplete: false })
    return !refreshed.targets.has('main-panel.html')
  }, { timeoutMs: 10_000, description: 'main-panel target removal' })
  await callE2e(context.pages.pet, 'recreateWindow', 'main-panel')
  const refreshed = await waitFor(async () => {
    const next = await context.refreshTargets({ requireComplete: false })
    return next.targets.has('main-panel.html') ? next : null
  }, { timeoutMs: 15_000, description: 'main-panel target recreation' })
  await requireE2eBridge(refreshed.pages.main, 'main-panel')
  assert(refreshed.targets.get('main-panel.html').id !== oldTargetId, 'Expected a new renderer target')
  return { recreatedTargetId: refreshed.targets.get('main-panel.html').id }
}

async function ackFailureScenario(context, mode) {
  await ensureBaseBridge(context)
  await resetAuthenticated(context)
  await prepareRelationshipGuide(context)
  await callE2e(context.pages.main, 'setMainPanelIntentAckMode', mode)
  await context.pages.pet.waitForSelector(REQUIRED_SELECTORS.openRelationship)
  const startedAt = Date.now()
  await context.pages.pet.click(REQUIRED_SELECTORS.openRelationship)
  const snapshot = await expectSnapshot(
    context.pages.pet,
    (value) => value.onboarding?.presentation == null && value.onboarding?.observedRelationship !== true,
    `relationship guide rollback after ACK ${mode}`,
    mode === 'timeout' ? 8_000 : 3_000,
  )
  if (mode === 'timeout') {
    const elapsedMs = Date.now() - startedAt
    assert(elapsedMs >= 4_900 && elapsedMs < 7_500, 'Intent ACK timeout was not approximately five seconds', { elapsedMs })
  }
  return { mode, onboarding: snapshot.onboarding, elapsedMs: Date.now() - startedAt }
}

export const intentAckFalseScenario = (context) => ackFailureScenario(context, 'false')
export const intentAckTimeoutScenario = (context) => ackFailureScenario(context, 'timeout')

export async function quickBroadcastBeforeChatScenario(context) {
  await ensureBaseBridge(context)
  await resetAuthenticated(context)
  const quick = context.pages.quick
  const restorePreferences = context.stub.overrideResponse('GET', '/api/v1/users/me/preferences', 503, { detail: 'Temporary preference failure' })
  const reply = context.stub.holdNext('POST', '/api/v1/chat/message')
  try {
    await callE2e(quick, 'showWindow', 'quick-chat')
    await quick.evaluate('window.dispatchEvent(new Event("focus"))')
    await quick.waitForSelector('[data-e2e="quick-chat-sync-error"]')
    await callE2e(context.pages.main, 'broadcastRelationshipTo', 'quick-chat', createRelationship(USERS.A))
    const adopted = await expectSnapshot(
      quick,
      (value) => value.relationship?.user_id === 101 && value.relationshipCapabilityAdopted === true,
      'quick-chat relationship broadcast adoption',
    )
    await quick.input(REQUIRED_SELECTORS.quickChatInput, '你好，小猪')
    await quick.click(REQUIRED_SELECTORS.quickChatSend)
    await withTimeout(reply.arrived, 5000, 'quick-chat request after adopting the relationship')

    restorePreferences()
    await quick.evaluate('window.dispatchEvent(new Event("focus"))')
    await waitFor(() => quick.evaluate('!document.querySelector("[data-e2e=quick-chat-sync-error]")'), { description: 'preferences refresh completes while the reply is pending' })
    reply.release()
    await waitFor(() => quick.evaluate(`document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatAssistantMessage)})?.textContent.includes('E2E 小猪收到：你好，小猪')`), { description: 'quick reply survives the successful preferences refresh' })
    return { adoptedRelationship: adopted.relationship, replySurvivesPreferenceRecovery: true }
  } finally {
    restorePreferences()
    reply.release()
  }
}

export async function focusTogetherScenario(context) {
  await ensureBaseBridge(context)
  await resetAuthenticated(context)
  const main = context.pages.main
  const panel = '[data-e2e="focus-panel"]'
  const stateSelector = (status) => `${panel}[data-focus-status="${status}"]`
  const readTime = () => main.evaluate('document.querySelector(\'[data-e2e="focus-time"]\')?.textContent')
  await main.waitForSelector(stateSelector('idle'))
  await main.click('[data-e2e="main-tab-knowledge"]')
  await main.click('[data-e2e="open-focus"]')
  await main.waitForSelector(stateSelector('idle'))
  await main.input('[data-e2e="focus-intention"]', '只属于 A 的一小段专注')
  await main.click('[data-e2e="focus-start"]')
  await main.waitForSelector(stateSelector('running'))
  await main.click('[data-e2e="focus-toggle"]')
  await main.waitForSelector(stateSelector('paused'))
  const pausedTime = await readTime()
  await main.reload()
  await main.waitForSelector(stateSelector('paused'))
  assertEqual(await readTime(), pausedTime, 'Reload changed a paused focus session')
  await main.click('[data-e2e="focus-toggle"]')
  await main.waitForSelector(stateSelector('running'))
  await main.evaluate('window.desktopBridge.hideMainPanel()')
  await new Promise((resolve) => setTimeout(resolve, 1600))
  await main.evaluate('window.desktopBridge.openMainPanel()')
  await main.waitForSelector(stateSelector('running'))
  const runningTime = await readTime()
  assert(runningTime < pausedTime, 'The timer did not continue while its panel was closed', { pausedTime, runningTime })
  await main.click('[data-e2e="focus-toggle"]')
  await main.waitForSelector(stateSelector('paused'))
  const beforeSwitch = await readTime()

  await switchAccountViaUi(context, USERS.B)
  await main.waitForSelector(stateSelector('idle'))
  assertEqual(await main.evaluate('document.querySelector(\'[data-e2e="focus-intention"]\')?.value'), '', 'Account B inherited account A focus intention')
  await switchAccountViaUi(context, USERS.A)
  await main.waitForSelector(stateSelector('paused'))
  assertEqual(await readTime(), beforeSwitch, 'Account A did not recover its paused timer')
  assert(await main.evaluate('document.querySelector(\'[data-e2e="focus-panel"]\')?.textContent.includes("只属于 A 的一小段专注")'), 'Account A focus intention was lost')
  await waitFor(() => main.evaluate('!document.querySelector(\'[data-e2e="focus-panel"] [role="alert"]\')'), { timeoutMs: 3000, description: 'restored focus without a stale read error' })
  await waitFor(() => main.evaluate(`(() => {
    const weekly = document.querySelector('[data-e2e="pet-weekly-summary"]')
    return weekly && weekly.getAttribute('aria-busy') === 'false' && !weekly.querySelector('.pet-weekly-error')
  })()`), { timeoutMs: 3000, description: 'weekly memories loaded after account return' })
  await main.evaluate('document.querySelector(\'[data-e2e="focus-panel"]\')?.scrollIntoView({ block: "center" })')
  await main.screenshot(`${context.artifactPath}/focus-paused.png`)
  await main.click('[data-e2e="focus-end"]')
  await main.waitForSelector(stateSelector('idle'))
  const rewardsBefore = context.stub.requests.filter((request) => request.pathname.endsWith('/relationship/rewards')).length
  await main.click('[data-e2e="focus-start"]')
  await main.waitForSelector(stateSelector('running'))
  await main.click('[data-e2e="focus-end"]')
  await main.waitForSelector(stateSelector('idle'))
  const rewardsAfter = context.stub.requests.filter((request) => request.pathname.endsWith('/relationship/rewards')).length
  assertEqual(rewardsAfter, rewardsBefore, 'Early focus finish must not fabricate relationship rewards')
  const unauthorized = await context.pages.quick.evaluate('window.desktopBridge.updateFocusSession("start", { minutes: 15, expectedRevision: 0 }, {})')
  assertEqual(unauthorized.ok, false, 'A quick-chat renderer without an authorized context changed focus state')
  return { pausedTime, runningTime, accountIsolation: true, rendererReload: true, hiddenPanelTimer: true }
}

export async function newConversationScenario(context) {
  await resetAuthenticated(context)
  const main = context.pages.main
  await main.click('[data-e2e="new-chat"]')
  const firstMessage = '先聊一件事情'
  const hold = context.stub.holdNext('POST', '/api/v1/chat/message')
  await main.input('[data-e2e="main-chat-input"]', firstMessage)
  await main.click('[data-e2e="main-chat-send"]')
  await withTimeout(hold.arrived, 10_000, 'held first conversation message')
  await main.click('[data-e2e="new-chat"]')
  const secondMessage = '这是另一个独立话题'
  await main.input('[data-e2e="main-chat-input"]', secondMessage)
  const beforeRelease = context.stub.requests.length
  hold.release()
  await waitFor(() => {
    return context.stub.requests.slice(beforeRelease).some((request) => request.pathname === '/api/v1/chat/sessions')
  }, { description: 'first reply handled and session list refreshed' })
  assertEqual(await main.evaluate('document.querySelector(\'[data-e2e="main-chat-input"]\').value'), secondMessage, 'The old reply erased the new draft')
  assert(!await main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(firstMessage)})`), 'The old reply entered the new conversation')
  await main.click('[data-e2e="main-chat-send"]')
  await waitFor(() => main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(`E2E 小猪收到：${secondMessage}`)})`), { description: 'second conversation reply' })
  const firstSession = context.stub.fixture.accounts.get(USERS.A.id).sessions.find((session) => session.messages.some((message) => message.content === firstMessage))
  const secondSession = context.stub.fixture.accounts.get(USERS.A.id).sessions.find((session) => session.messages.some((message) => message.content === secondMessage))
  assert(firstSession && secondSession && firstSession.id !== secondSession.id, 'New conversation reused the old session')
  const requestBodies = context.stub.requests.filter((request) => request.pathname === '/api/v1/chat/message').map((request) => JSON.parse(request.body))
  assert(!requestBodies.find((body) => body.message === secondMessage)?.session_id, 'New conversation included the previous session id')
  await main.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 650, deviceScaleFactor: 1, mobile: false })
  let compactLayout
  try {
    compactLayout = await main.evaluate(`(() => {
      const panel = document.querySelector('.main-conversation-panel')
      const send = document.querySelector('[data-e2e="main-chat-send"]').getBoundingClientRect()
      return { width: innerWidth, contentWidth: document.documentElement.scrollWidth, panelWidth: panel.clientWidth, panelContentWidth: panel.scrollWidth, sendBottom: send.bottom, height: innerHeight }
    })()`)
    assert(compactLayout.contentWidth <= compactLayout.width, 'Compact main panel overflows horizontally', compactLayout)
    assert(compactLayout.panelContentWidth <= compactLayout.panelWidth, 'Compact conversation overflows horizontally', compactLayout)
    assert(compactLayout.sendBottom <= compactLayout.height, 'Compact layout hides the send button', compactLayout)
    await main.screenshot(`${context.artifactPath}/main-compact.png`)
  } finally {
    await main.send('Emulation.clearDeviceMetricsOverride')
  }
  return { firstSessionId: firstSession.id, secondSessionId: secondSession.id, staleReplyIgnored: true, draftPreserved: true, compactLayout }
}

export async function companionRecoveryScenario(context) {
  const restore = context.stub.overrideResponse('GET', '/api/v1/pets/pig/relationship', 503, { detail: 'Temporary companion outage' })
  try {
    await resetToLoggedOut(context)
    await loginAs(context, USERS.A)
    await context.pages.main.waitForSelector('[data-e2e="companion-sync-retry"]')
    assert(await context.pages.main.evaluate('Boolean(document.querySelector(\'[data-e2e="main-chat-input"]\'))'), 'Companion outage blocked the chat dashboard')
    assert(await context.pages.main.evaluate('window.desktopBridge.getSessionToken().then(Boolean)'), 'Companion outage discarded a valid login')
    restore()
    await context.pages.main.click('[data-e2e="companion-sync-retry"]')
    await waitFor(() => context.pages.main.evaluate(`(() => {
      const weekly = document.querySelector('[data-e2e="pet-weekly-summary"]')
      return weekly && weekly.getAttribute('aria-busy') === 'false' && !weekly.querySelector('.pet-weekly-error')
    })()`), { description: 'companion data recovers after a server failure' })
    assert(!await context.pages.main.evaluate('Boolean(document.querySelector(\'[data-e2e="companion-sync-retry"]\'))'), 'Successful retry left the companion failure visible')
    return { validLoginPreserved: true, chatAvailable: true, weeklyRecovered: true }
  } finally {
    restore()
  }
}

export async function petSwitchSyncScenario(context) {
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  account.preferences = { ...account.preferences, pet_type: 'cat' }
  await resetToLoggedOut(context)
  await loginAs(context, USERS.A)
  const settledPets = []
  for (const petType of ['cat', 'pig', 'dog', 'pig']) {
    if (settledPets.length) await context.pages.main.click(`[data-e2e="pet-option-${petType}"]`)
    await expectSnapshot(context.pages.main, (snapshot) => (
      snapshot.account?.petType === petType
      && snapshot.renderer?.[0]?.relationshipId === createRelationship(USERS.A, petType).id
    ), `${petType} relationship after pet switch`)
    await waitFor(() => context.pages.main.evaluate(`(() => {
      const selected = document.querySelector('[data-e2e="pet-option-${petType}"]')
      const agenda = document.querySelector('[data-e2e="today-reminder-agenda"]')
      return selected?.classList.contains('active') && !selected.disabled
        && Boolean(document.querySelector('[data-e2e="pet-relationship-summary"]'))
        && ['ready', 'empty'].includes(agenda?.dataset.state)
        && !document.querySelector('.main-companion-sync')
    })()`), { description: `${petType} companion cards and agenda ready without retry` })
    settledPets.push(petType)
  }
  await context.pages.main.waitForSelector('[data-e2e="focus-panel"][data-focus-status="idle"]')
  return { settledPets, accountUserId: USERS.A.id, retryRequired: false }
}

export async function reducedMotionScenario(context) {
  await resetAuthenticated(context)
  const pet = context.pages.pet
  try {
    await pet.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await waitFor(() => pet.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches && document.querySelector('.pet-image')?.dataset.animationFrame === '0'"), { description: 'reduced motion static pet' })
    await pet.click(REQUIRED_SELECTORS.petCarePat)
    await waitFor(() => pet.evaluate("!document.querySelector('[data-action=pat]').disabled && Boolean(document.querySelector('.pet-action-idle'))"), { description: 'reduced motion care action completes' })
    const quiet = await pet.evaluate(`new Promise((resolve) => {
      const image = document.querySelector('.pet-image')
      let changes = 0
      const observer = new MutationObserver(() => { changes += 1 })
      observer.observe(image, { attributes: true, attributeFilter: ['data-animation-frame'] })
      setTimeout(() => { observer.disconnect(); resolve({ changes, cssAnimation: getComputedStyle(document.querySelector('.pet-visual-stack')).animationName }) }, 750)
    })`)
    assertEqual(quiet.changes, 0, 'Reduced motion still advanced pet frames')
    assertEqual(quiet.cssAnimation, 'none', 'Reduced motion still animated the pet container')
    await pet.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await waitFor(() => pet.evaluate("Number(document.querySelector('.pet-image')?.dataset.animationFrame) > 0"), { description: 'animation resumes after live motion preference change' })
    return { staticFrames: true, careCompletes: true, livePreferenceRecovery: true }
  } finally {
    await pet.send('Emulation.setEmulatedMedia', { features: [] })
  }
}

export async function failedKnowledgeUploadScenario(context) {
  const main = context.pages.main
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  account.documents = []
  account.failNextUpload = true
  const initialDocuments = context.stub.holdNext('GET', '/api/v1/rag/documents')
  try {
    await resetAuthenticated(context)
    await withTimeout(initialDocuments.arrived, 5000, 'initial document list')
    await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
    assert(await main.evaluate("document.querySelector('[data-e2e=knowledge-upload]').disabled"), 'Initial document loading must disable competing uploads')
    initialDocuments.release()
    await waitFor(() => main.evaluate("document.querySelector('[data-e2e=knowledge-upload]')?.disabled === false && document.querySelector('.main-knowledge-panel')?.getAttribute('aria-busy') === 'false'"), { description: 'initial document loading releases upload control' })
  } finally {
    initialDocuments.release()
  }
  const hold = context.stub.holdNext('POST', '/api/v1/rag/upload')
  await main.evaluate(`(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['sample that fails indexing'], 'failed-knowledge.txt', { type: 'text/plain' }))
    const input = document.querySelector('[data-e2e="knowledge-upload"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await withTimeout(hold.arrived, 5000, 'held knowledge upload')
  assert(await main.evaluate("document.querySelector('[data-e2e=knowledge-upload]').disabled"), 'Upload allowed overlapping writes')
  hold.release()
  const failedDocument = await waitFor(() => account.documents.find((document) => document.status === 'failed'), { description: 'failed upload persisted by backend' })
  await main.waitForSelector(`[data-e2e-document-id="${failedDocument.id}"]`)
  await waitFor(() => main.evaluate("!document.querySelector('[data-e2e=knowledge-upload]').disabled"), { description: 'failed upload releases controls' })
  assert(await main.evaluate(`document.querySelector('[data-e2e-document-id="${failedDocument.id}"]').textContent.includes('索引失败')`), 'Failed document lacks actionable status')
  assert(await main.evaluate(`document.querySelector('[data-e2e-delete-document="${failedDocument.id}"]').getAttribute('aria-label').includes(${JSON.stringify(failedDocument.filename)})`), 'Delete action does not identify its document')
  await main.click(`[data-e2e-delete-document="${failedDocument.id}"]`)
  await waitFor(() => main.evaluate(`!document.querySelector('[data-e2e-document-id="${failedDocument.id}"]')`), { description: 'failed upload can be removed' })
  assertEqual(account.documents.length, 0, 'Deleting the failed document did not reclaim its slot')
  await waitFor(() => main.evaluate("document.querySelector('[data-e2e=knowledge-upload]')?.disabled === false"), { description: 'document deletion releases upload control' })
  await main.evaluate(`(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Start the day with one small task.'], 'companion-notes.md', { type: 'text/markdown' }))
    const input = document.querySelector('[data-e2e="knowledge-upload"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const indexedDocument = await waitFor(() => account.documents.find((document) => document.status === 'indexed'), { description: 'new upload indexes after recovery' })
  await main.waitForSelector(`[data-e2e-document-id="${indexedDocument.id}"]`)
  await waitFor(() => main.evaluate("!document.querySelector('[data-e2e=knowledge-refresh]').disabled"), { description: 'successful upload finishes' })
  await main.screenshot(`${context.artifactPath}/knowledge-recovery.png`)
  await main.click('[data-e2e="knowledge-refresh"]')
  await waitFor(() => main.evaluate("document.querySelector('.main-knowledge-panel').getAttribute('aria-busy') === 'false'"), { description: 'document refresh finishes' })
  return { initialDocumentLoadingBlocksUpload: true, failedUploadVisible: true, deleteReclaimsSlot: true, duplicateUploadBlocked: true, uploadRecovery: true }
}

export async function hiddenReminderDeadlineScenario(context) {
  await resetAuthenticated(context)
  const pet = context.pages.pet
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  account.reminders = []
  try {
    assertEqual(await callE2e(pet, 'setReminderNotificationOutcome', 'failed'), true, 'Fixture can decline notification submission')
    await callE2e(pet, 'hideWindow', 'pet')
    await waitFor(() => pet.evaluate("document.visibilityState === 'hidden'"), { description: 'pet hidden for declined notification' })
    const declined = createReminderRecord({
      user: USERS.A,
      id: context.stub.fixture.nextReminderId++, title: '系统拒绝的提醒',
      petType: 'pig', remindAt: new Date(Date.now() - 1000),
    })
    const requestsToTriggerDeclined = () => context.stub.requests.filter((request) => (
      request.method === 'POST' && request.pathname === `/api/v1/reminders/${declined.id}/trigger`
    )).length
    const before = await callE2e(pet, 'snapshot')
    account.reminders = [declined]
    await callE2e(pet, 'flushReminderPoll')
    const after = await callE2e(pet, 'snapshot')
    assert(after.reminderNotificationAttempts > before.reminderNotificationAttempts, 'Hidden pet did not attempt native submission')
    assert(!declined.triggered_at && declined.status === 'pending', 'Rejected native notification no longer waits for presentation')
    assertEqual(requestsToTriggerDeclined(), 0, 'Rejected native notification wrote a trigger')

    // Reopening a renderer starts a new poll controller. Native submission is still
    // declined here, so only the visible bubble can acknowledge this reminder.
    await callE2e(pet, 'showWindow', 'pet')
    await pet.reload()
    await waitFor(() => declined.triggered_at, { description: 'visible reminder acknowledges after native decline' })
    assert(await pet.evaluate(`document.querySelector('.pet-bubble')?.textContent.includes(${JSON.stringify(declined.title)})`), 'Recovery did not present the reminder bubble')
    assertEqual(requestsToTriggerDeclined(), 1, 'Visible recovery did not acknowledge exactly once')

    assertEqual(await callE2e(pet, 'setReminderNotificationOutcome', 'show'), true, 'Fixture can accept notification submission')
    const dueAt = Date.now() + 4000
    const reminders = [1, 2, 3].map((number) => createReminderRecord({
      user: USERS.A,
      id: context.stub.fixture.nextReminderId++, title: `准点提醒 ${number}`,
      petType: 'pig', remindAt: new Date(dueAt),
    }))
    const canceled = createReminderRecord({
      user: USERS.A,
      id: context.stub.fixture.nextReminderId++, title: '到期前取消的提醒',
      petType: 'pig', remindAt: new Date(dueAt),
    })
    account.reminders = [...reminders, canceled]
    await callE2e(pet, 'hideWindow', 'pet')
    await waitFor(() => pet.evaluate("document.visibilityState === 'hidden'"), { description: 'pet hidden before reminder deadline' })
    // Discover future deadlines once. From here onward only the real main-process
    // wakeup may deliver them; no clock changes or forced due-time polling.
    await callE2e(pet, 'flushReminderPoll')
    assert(reminders.every((reminder) => !reminder.triggered_at), 'A reminder was delivered before its deadline')
    canceled.status = 'canceled'
    await waitFor(() => reminders.every((reminder) => reminder.triggered_at), { timeoutMs: 9000, intervalMs: 100, description: 'hidden pet naturally delivers the due batch' })
    const deliveryLagsMs = reminders.map((reminder) => Date.parse(reminder.triggered_at) - dueAt)
    assert(deliveryLagsMs.every((lag) => lag >= 0 && lag <= 5000), 'Known deadlines were early or over five seconds late', deliveryLagsMs)
    assert(!canceled.triggered_at, 'The cached deadline delivered a canceled reminder')
    assert(reminders.every((reminder) => reminder.status === 'pending'), 'Delivery auto-completed reminders')
    for (const reminder of reminders) {
      assertEqual(context.stub.requests.filter((request) => request.pathname === `/api/v1/reminders/${reminder.id}/trigger`).length, 1, 'The local wakeup duplicated a successful trigger')
    }
    return {
      deliveryLagsMs,
      hidden: true,
      simulatedNativeSubmission: true,
      declinedNativeRemainedPending: true,
      visibleRecoveryTriggers: requestsToTriggerDeclined(),
      canceledRechecked: true,
      remindersRemainPending: true,
    }
  } finally {
    account.reminders = []
    await callE2e(pet, 'setReminderNotificationOutcome', 'show')
    await callE2e(pet, 'showWindow', 'pet')
  }
}

function observeReminderListUpdates(main) {
  return main.evaluate(`(() => {
    let updates = 0
    const unsubscribe = window.desktopBridge.onReminderListsChanged(() => { updates += 1 })
    window.readReminderUpdateCount = () => updates
    window.stopReminderUpdateObservation = () => {
      unsubscribe()
      delete window.readReminderUpdateCount
      delete window.stopReminderUpdateObservation
    }
  })()`)
}

export async function unmuteReminderScenario(context) {
  await resetAuthenticated(context)
  const { pet } = context.pages
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const originalReminders = account.reminders
  const originalMuted = (await callE2e(pet, 'snapshot')).notificationsMuted
  const toggle = () => callE2e(pet, 'clickTrayMuteNotifications')
  account.reminders = []
  try {
    if (!originalMuted) assertEqual(await toggle(), true, 'The actual tray mute callback is available')
    await expectSnapshot(pet, (snapshot) => snapshot.notificationsMuted === true, 'the tray persisted mute')
    await callE2e(pet, 'hideWindow', 'pet')
    await waitFor(() => pet.evaluate("document.visibilityState === 'hidden'"), { description: 'pet remains hidden for the muted reminder' })
    const reminder = createReminderRecord({
      user: USERS.A, id: context.stub.fixture.nextReminderId++, title: '取消静音后的待处理提醒',
      petType: 'pig', remindAt: new Date(Date.now() - 1000),
    })
    const before = await callE2e(pet, 'snapshot')
    const readStart = context.stub.requests.length
    account.reminders = [reminder]
    await callE2e(pet, 'flushReminderPoll')
    assert(context.stub.requests.slice(readStart).some((request) => request.method === 'GET'
      && request.pathname === '/api/v1/reminders' && new URLSearchParams(request.search).has('due_before')),
      'The hidden pet must read the due reminder before unmuting')
    assert(!reminder.triggered_at, 'The muted, hidden reminder was acknowledged without presentation')
    assertEqual((await callE2e(pet, 'snapshot')).reminderNotificationAttempts, before.reminderNotificationAttempts,
      'The muted channel submitted a native notification')

    const unmutedAt = Date.now()
    assertEqual(await toggle(), true, 'The actual tray unmute callback is available')
    await expectSnapshot(pet, (snapshot) => snapshot.notificationsMuted === false, 'the tray persisted unmute')
    await waitFor(() => reminder.triggered_at, { timeoutMs: 5000, description: 'unmute resumes a hidden reminder before regular reconciliation' })
    const latencyMs = Date.parse(reminder.triggered_at) - unmutedAt
    assert(latencyMs >= 0 && latencyMs <= 5000, 'The resumed reminder missed the five-second window', { latencyMs })
    assertEqual((await callE2e(pet, 'snapshot')).reminderNotificationAttempts - before.reminderNotificationAttempts, 1,
      'Unmute submitted the native notification more than once')
    assertEqual(context.stub.requests.filter((request) => request.method === 'POST'
      && request.pathname === `/api/v1/reminders/${reminder.id}/trigger`).length, 1, 'Unmute acknowledged the occurrence exactly once')
    assertEqual(reminder.status, 'pending', 'Unmute must keep the reminder available for explicit completion')
    assert(await pet.evaluate("document.visibilityState === 'hidden'"), 'The unmute check must not reveal the pet')
    return { actualTrayCallback: true, hidden: true, nativeSubmissions: 1, acknowledgments: 1, latencyMs }
  } finally {
    account.reminders = originalReminders
    if ((await callE2e(pet, 'snapshot')).notificationsMuted !== originalMuted) await toggle()
    await callE2e(pet, 'showWindow', 'pet')
  }
}

export async function reminderConfirmationRetryScenario(context) {
  await resetAuthenticated(context)
  const { main, pet } = context.pages
  await waitFor(() => pet.evaluate("document.visibilityState === 'visible'"), { description: 'pet visible for overdue reminder' })
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const previousReminders = account.reminders
  const today = new Date().setHours(0, 0, 0, 0)
  const reminder = createReminderRecord({
    user: USERS.A,
    id: context.stub.fixture.nextReminderId++,
    title: '等待确认的会话恢复提醒',
    remindAt: new Date(Math.max(today, Date.now() - 1000)),
  })
  const route = `/api/v1/reminders/${reminder.id}/trigger`
  const agendaItem = `[data-e2e="today-agenda-item"][data-target-id="${reminder.id}"]`
  const dueItem = `${agendaItem}[data-status="due"]`
  const deliveredItem = `${agendaItem}[data-status="delivered"]`
  const upcomingRow = `#upcoming-reminders [data-reminder-row-id="${reminder.id}"]`
  const deliveredRow = `#delivered-reminders [data-reminder-row-id="${reminder.id}"]`
  const tryPublishFrom = (page, role, otherServer = false) => page.evaluate(`(async () => {
    const bridge = window.desktopBridge
    const server = await bridge.getApiBaseUrl()
    const expected = { userId: ${USERS.A.id}, petType: 'pig', session: await bridge.getSessionSnapshot() }
    let unsubscribe
    const published = new Promise((resolve, reject) => {
      unsubscribe = bridge.onPetRelationshipChanged(({ authoritative }) => {
        if (!authoritative?.id) return resolve(null)
        bridge.publishReminderListsChanged({ ...expected, authoritative, server: ${otherServer} ? server + '/other' : server }).then(resolve, reject)
      })
    })
    try {
      if (!await bridge.e2e.broadcastRelationshipTo(${JSON.stringify(role)}, ${JSON.stringify(createRelationship(USERS.A))})) return null
      return await published
    } finally {
      unsubscribe()
    }
  })()`)
  const triggerAttempts = () => context.stub.requests.filter((request) => request.method === 'POST' && request.pathname === route).length
  const failedTrigger = context.stub.holdNext('POST', route, {
    statusCode: 503,
    payload: { detail: 'Temporary trigger confirmation failure' },
  })
  const successfulTrigger = context.stub.holdNext('POST', route)
  const { logPath } = await pet.evaluate('window.desktopBridge.getLogPaths()')
  const presentations = async () => (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    .filter((record) => record.payload?.event === 'reminder:presented' && record.payload.details?.reminderId === reminder.id)
    .map((record) => record.payload.details)
  account.reminders = [reminder]
  const firstPoll = callE2e(pet, 'flushReminderPoll')
  try {
    await withTimeout(failedTrigger.arrived, 15_000, 'first attempt to acknowledge overdue reminder')
    assert(await pet.evaluate(`document.querySelector('.pet-bubble')?.textContent.includes(${JSON.stringify(reminder.title)})`), 'The first overdue reminder did not display a bubble')
    await observeReminderListUpdates(main)
    await main.evaluate("window.dispatchEvent(new Event('detachym:reminders-changed'))")
    await main.waitForSelector(dueItem)
    await main.waitForSelector(upcomingRow)
    assertEqual(await tryPublishFrom(main, 'main-panel'), false, 'A main-panel capability cannot publish pet reminder acknowledgment')
    assertEqual(await tryPublishFrom(pet, 'pet', true), false, 'A pet capability cannot publish acknowledgment for another server')
    failedTrigger.release()
    await firstPoll
    assert(!reminder.triggered_at, 'The failed acknowledgment nevertheless triggered the reminder')
    assertEqual(await main.evaluate('window.readReminderUpdateCount()'), 0, 'Failed or unauthorized acknowledgments refreshed the main panel')
    assert(await main.evaluate(`Boolean(document.querySelector(${JSON.stringify(dueItem)}))`), 'Main lost the due reminder before acknowledgment')

    // Force a fresh renderer with the same profile before the acknowledgment retry.
    // The runner does not re-seed the login, local storage, or the reminder.
    await pet.reload()
    await withTimeout(successfulTrigger.arrived, 15_000, 'acknowledgment retry from the same profile')
    assert(await pet.evaluate(`!document.querySelector('.pet-bubble')?.textContent.includes(${JSON.stringify(reminder.title)})`), 'The acknowledgment retry replayed the reminder bubble')
    successfulTrigger.release()
    await waitFor(() => reminder.triggered_at, { description: 'overdue reminder acknowledgment persisted' })
    await callE2e(pet, 'flushReminderPoll')
    await waitFor(() => main.evaluate(`Boolean(document.querySelector(${JSON.stringify(deliveredItem)}))
      && Boolean(document.querySelector(${JSON.stringify(deliveredRow)}))
      && !document.querySelector(${JSON.stringify(upcomingRow)})`), {
      timeoutMs: 5000, description: 'the open main panel refreshes both reminder lists after pet acknowledgment',
    })
    assertEqual(await main.evaluate('window.readReminderUpdateCount()'), 1, 'The successful retry did not publish exactly one main-panel refresh')
    await main.click(deliveredItem)
    assert(await main.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(deliveredRow)})`), 'The refreshed Today item did not focus the delivered reminder')
    assertEqual(triggerAttempts(), 2, 'Exactly one retry should confirm the reminder')
    const receipts = await presentations()
    assertEqual(receipts.length, 1, 'The acknowledgment retry emitted another presentation')
    assert(receipts[0].bubbleShown && receipts[0].nativeShown, 'The first presentation did not cover both channels', receipts[0])
    return { triggerAttempts: triggerAttempts(), presentations: receipts.length, sameProfileReload: true, mainPanelRefreshed: true, unauthorizedRefreshRejected: true }
  } finally {
    failedTrigger.release()
    successfulTrigger.release()
    await firstPoll.catch(() => {})
    await main.evaluate('window.stopReminderUpdateObservation?.()').catch(() => {})
    account.reminders = previousReminders
  }
}

export async function quickChatReminderSyncScenario(context) {
  const { main, quick } = context.pages
  const { stub } = context
  const account = stub.fixture.accounts.get(USERS.A.id)
  const previousReminders = account.reminders
  const remindersPath = '/api/v1/reminders'
  const title = '检查窗边的花'
  const draft = `明天12:00提醒我${title}`
  let save
  let relationshipRefresh
  account.reminders = []
  try {
    await resetAuthenticated(context)
    await main.waitForSelector('[data-e2e="today-reminder-agenda"][data-state="empty"]')
    await main.waitForSelector('[data-e2e="upcoming-reminder-empty"]')
    await callE2e(quick, 'showWindow', 'quick-chat')
    await quick.reload()
    await quick.waitForSelector(REQUIRED_SELECTORS.quickChatInput)
    assertEqual(await main.evaluate('document.visibilityState'), 'visible', 'Quick Chat closed the main panel')
    await observeReminderListUpdates(main)

    save = stub.holdNext('POST', remindersPath)
    await quick.input(REQUIRED_SELECTORS.quickChatInput, draft)
    await quick.click(REQUIRED_SELECTORS.quickChatSend)
    const request = await withTimeout(save.arrived, 5000, 'held Quick Chat reminder creation')
    const submitted = JSON.parse(request.body)
    assertEqual(submitted.pet_type, 'pig', 'Quick Chat used an unrelated pet context')
    assertEqual(submitted.title, title, 'Quick Chat changed the reminder title')

    // Show the pending reminder's date in Today before the API saves it. The pet's real clock stays unchanged.
    const day = new Date(submitted.remind_at)
    const morning = new Date(day).setHours(9, 0, 0, 0)
    day.setHours(24, 0, 0, 0)
    const beforeCalendarChange = stub.requests.length
    await main.evaluate(`(() => {
      const realNow = Date.now
      window.restoreQuickReminderClock = () => { Date.now = realNow; delete window.restoreQuickReminderClock }
      Date.now = () => ${morning}
      window.dispatchEvent(new Event('focus'))
    })()`)
    await waitFor(() => stub.requests.slice(beforeCalendarChange).some(({ method, pathname, search }) => (
      method === 'GET' && pathname === remindersPath && new URLSearchParams(search).get('due_before') === day.toISOString()
    )), { description: 'the open agenda reads the submitted reminder’s local day' })
    await main.waitForSelector('[data-e2e="today-reminder-agenda"][data-state="empty"]')
    assertEqual(await main.evaluate('window.readReminderUpdateCount()'), 0, 'An uncommitted reminder refreshed the main panel')

    relationshipRefresh = stub.holdNext('GET', '/api/v1/pets/pig/relationship', {
      statusCode: 503, payload: { detail: 'Temporary relationship refresh failure' },
    })
    save.release()
    const persisted = await waitFor(() => account.reminders.find(({ source_text }) => source_text === draft), {
      timeoutMs: 5000, description: 'Quick Chat saves one owned reminder',
    })
    assertEqual(persisted.user_id, USERS.A.id, 'Quick Chat saved the reminder to another account')
    assertEqual(persisted.remind_at, submitted.remind_at, 'Quick Chat changed the reminder time')
    await withTimeout(relationshipRefresh.arrived, 5000, 'optional post-create relationship refresh')

    const agendaItem = `[data-e2e="today-agenda-item"][data-status="scheduled"][data-target-id="${persisted.id}"]`
    const upcomingRow = `#upcoming-reminders [data-reminder-row-id="${persisted.id}"]`
    await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(agendaItem)})?.textContent.includes(${JSON.stringify(title)})
      && document.querySelector(${JSON.stringify(upcomingRow)})?.textContent.includes(${JSON.stringify(title)})`), {
      timeoutMs: 5000, description: 'Today and Upcoming update while the optional relationship refresh is held',
    })
    assertEqual(await main.evaluate('window.readReminderUpdateCount()'), 1, 'The committed Quick Chat reminder must publish exactly one refresh')
    assert(await quick.evaluate(`document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatSend)}).disabled`), 'The relationship refresh was not still pending')
    relationshipRefresh.release()
    await waitFor(() => quick.evaluate(`!document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatSend)}).disabled
      && document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatAssistantMessage)})?.textContent.includes(${JSON.stringify(title)})`), {
      description: 'the confirmed Quick Chat message survives the relationship failure',
    })
    assertEqual(account.reminders.length, 1, 'Quick Chat created duplicate reminders')
    return { todayUpdated: true, upcomingUpdated: true, refreshBeforeRelationship: true, confirmationRetained: true, reminderId: persisted.id }
  } finally {
    save?.release()
    relationshipRefresh?.release()
    await main.evaluate('window.stopReminderUpdateObservation?.(); window.restoreQuickReminderClock?.()').catch(() => {})
    account.reminders = previousReminders
  }
}

export async function reminderNotificationReceiptRecoveryScenario(context) {
  await resetAuthenticated(context)
  const { main, pet } = context.pages
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const previousReminders = account.reminders
  account.reminders = []
  const reminder = createReminderRecord({
    user: USERS.A,
    id: context.stub.fixture.nextReminderId++, title: '系统接受后重载的提醒',
    remindAt: new Date(Date.now() - 1000),
  })
  const triggerAttempts = () => context.stub.requests.filter((request) => (
    request.method === 'POST' && request.pathname === `/api/v1/reminders/${reminder.id}/trigger`
  )).length

  try {
    await callE2e(main, 'hideWindow', 'pet')
    await waitFor(() => pet.evaluate("document.visibilityState === 'hidden'"), { description: 'pet hidden for first submission' })
    assertEqual(await callE2e(main, 'setReminderNotificationReplyHold', true), true, 'Fixture can hold a successful native reply')
    const before = (await callE2e(main, 'snapshot')).reminderNotificationAttempts
    account.reminders = [reminder]
    await pet.evaluate('void window.desktopBridge.e2e.flushReminderPoll()')
    const held = await expectSnapshot(main, (snapshot) => snapshot.reminderNotificationReplyHeld, 'accepted native notification with held IPC reply')
    assertEqual(held.reminderNotificationAttempts, before + 1, 'The held reply follows exactly one simulated native submission')
    const hasReceipt = await pet.evaluate(`JSON.parse(localStorage.getItem('detachym.pending-reminder-receipts.v1') || '[]')
      .some((record) => record[3] === ${reminder.id} && record[4] === ${JSON.stringify(reminder.remind_at)})`)
    assertEqual(hasReceipt, false, 'The renderer saved a receipt before receiving acceptance')
    assertEqual(triggerAttempts(), 0, 'The renderer triggered the reminder before receiving acceptance')

    await callE2e(main, 'setReminderNotificationOutcome', 'failed')
    await pet.reload()
    assert(await pet.evaluate("document.visibilityState === 'hidden'"), 'Pet became visible after reloading')
    await waitFor(() => reminder.triggered_at, { description: 'reloaded hidden pet acknowledges previously accepted notification' })
    await callE2e(pet, 'flushReminderPoll')
    const after = await callE2e(main, 'snapshot')
    assertEqual(after.reminderNotificationAttempts, held.reminderNotificationAttempts, 'Reload submitted the same notification twice')
    assertEqual(triggerAttempts(), 1, 'Reload did not trigger the reminder exactly once')
    assert(!await pet.evaluate(`document.querySelector('.pet-bubble')?.textContent.includes(${JSON.stringify(reminder.title)})`), 'Hidden recovery showed the reminder bubble')
    return { simulatedNativeSubmissions: after.reminderNotificationAttempts - before, triggerAttempts: triggerAttempts(), hiddenReload: true, receiptMissingBeforeReload: true }
  } finally {
    account.reminders = previousReminders
    await callE2e(main, 'setReminderNotificationReplyHold', false)
    await callE2e(main, 'setReminderNotificationOutcome', 'show')
    await callE2e(main, 'showWindow', 'pet')
  }
}

export async function reminderReconnectScenario(context) {
  await resetAuthenticated(context)
  await hideMainPanel(context)
  const pet = context.pages.pet
  await waitFor(() => pet.evaluate("document.visibilityState === 'visible'"), { description: 'pet visible before simulated resume' })
  await callE2e(pet, 'flushReminderPoll')

  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const previousReminders = account.reminders
  const reminder = createReminderRecord({
    user: USERS.A,
    id: context.stub.fixture.nextReminderId++,
    title: '恢复联网后的到期提醒',
    remindAt: new Date(Date.now() - 1000),
  })
  const { logPath } = await pet.evaluate('window.desktopBridge.getLogPaths()')
  const readFailure = 'Reminder service unavailable after resume'
  const requestStart = context.stub.requests.length
  const isPetDueRead = (request) => {
    const params = new URLSearchParams(request.search)
    return request.method === 'GET' && request.pathname === '/api/v1/reminders'
      && params.has('due_before') && params.get('triggered') === 'false'
  }
  const reminderReads = () => context.stub.requests.slice(requestStart).filter(isPetDueRead)
  const failedRead = context.stub.holdNext('GET', '/api/v1/reminders', {
    statusCode: 503,
    payload: { detail: readFailure },
  }, isPetDueRead)
  account.reminders = [reminder]
  try {
    await callE2e(pet, 'simulateSystemResume')
    const failedRequest = await withTimeout(failedRead.arrived, 8000, 'reminder read after simulated system resume')
    assert(reminderReads().includes(failedRequest), 'The simulated resume did not start a pet reminder read')
    failedRead.release()
    await waitFor(async () => (await readFile(logPath, 'utf8')).includes(readFailure), {
      timeoutMs: 5000, description: 'pet handles temporary reminder read failure',
    })
    assertEqual(reminderReads().length, 1, 'Reminder was read again before the reconnect event')
    assert(!reminder.triggered_at, 'A failed read confirmed an overdue reminder')

    const reconnectAt = Date.now()
    await pet.evaluate("window.dispatchEvent(new Event('online'))")
    await waitFor(() => reminder.triggered_at, {
      timeoutMs: 8000, description: 'reconnect acknowledges overdue reminder before the ordinary poll cooldown',
    })
    await pet.evaluate("window.dispatchEvent(new Event('online'))")
    await callE2e(pet, 'flushReminderPoll')

    const acknowledgments = context.stub.requests.filter((request) => (
      request.method === 'POST' && request.pathname === `/api/v1/reminders/${reminder.id}/trigger`
    ))
    assertEqual(acknowledgments.length, 1, 'The reconnect events should acknowledge the reminder only once')
    const presentations = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => record.payload?.event === 'reminder:presented' && record.payload.details?.reminderId === reminder.id)
    assertEqual(presentations.length, 1, 'The reconnect events should present the reminder only once')
    assertEqual(reminder.status, 'pending', 'Delivery should leave the reminder available for completion')
    return {
      simulatedResume: true,
      reconnectLatencyMs: Date.parse(reminder.triggered_at) - reconnectAt,
      acknowledgments: acknowledgments.length,
      presentations: presentations.length,
    }
  } finally {
    failedRead.release()
    account.reminders = previousReminders
  }
}

export async function conversationReturnScenario(context) {
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const createdAt = new Date().toISOString()
  const seed = (title) => ({
    id: context.stub.fixture.nextSessionId++, user_id: USERS.A.id,
    title, created_at: createdAt, updated_at: createdAt,
    messages: [{ id: 1, role: 'assistant', content: `${title}的旧消息`, created_at: createdAt }],
  })
  const sessionA = seed('历史 A')
  const sessionB = seed('历史 B')
  account.sessions = [sessionA, sessionB]
  const initialHistory = context.stub.holdNext('GET', `/api/v1/chat/sessions/${sessionA.id}`)
  await resetAuthenticated(context)
  const main = context.pages.main
  const input = '[data-e2e="main-chat-input"]'
  const send = '[data-e2e="main-chat-send"]'
  const select = async (session) => {
    await main.click(`[data-e2e-session-id="${session.id}"]`)
    await main.waitForSelector(`[data-e2e-session-id="${session.id}"][aria-pressed="true"]`)
  }
  const contains = (message) => main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(message)})`)
  const holds = [initialHistory]
  let restoreFailure = null
  let restoreHistoryFailure = null
  try {
    await withTimeout(initialHistory.arrived, 5000, 'initial conversation detail restoration')
    const first = '回来后仍能收到的回答'
    const firstHold = context.stub.holdNext('POST', '/api/v1/chat/message')
    holds.push(firstHold)
    await main.input(input, first)
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(send)}).disabled`), 'History selection allowed sending into an unresolved conversation')
    initialHistory.release()
    await main.waitForSelector(`[data-e2e-session-id="${sessionA.id}"][aria-pressed="true"]`)
    await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(send)})?.disabled === false`), { description: 'restored conversation is ready to send' })
    assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(input)}).value`), first, 'Initial history restoration overwrote the user draft')
    await main.click(send)
    await withTimeout(firstHold.arrived, 5000, 'first pending conversation reply')
    await select(sessionB)
    await select(sessionA)
    await main.input(input, '回答期间的新草稿')
    assert(await main.evaluate(`document.querySelector(${JSON.stringify(send)}).disabled`), 'Returning to an in-flight conversation allowed another overlapping send')
    restoreHistoryFailure = context.stub.overrideResponse('GET', '/api/v1/chat/sessions', 503, { detail: 'Temporary history refresh failure' })
    firstHold.release()
    await waitFor(() => contains(`E2E 小猪收到：${first}`), { description: 'reply displayed after returning to the same conversation' })
    await waitFor(() => main.evaluate(`!document.querySelector(${JSON.stringify(send)}).disabled`), { description: 'returned conversation releases sending state' })
    assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(input)}).value`), '回答期间的新草稿', 'Returning reply erased a newer draft')
    assertEqual(await main.evaluate(`Array.from(document.querySelectorAll('.main-chat-stream .message.assistant')).filter((node) => node.textContent === ${JSON.stringify(`E2E 小猪收到：${first}`)}).length`), 1, 'The returning reply was duplicated')
    restoreHistoryFailure()
    restoreHistoryFailure = null

    const second = '只应该留在 A 的回答'
    const secondHold = context.stub.holdNext('POST', '/api/v1/chat/message')
    holds.push(secondHold)
    await main.input(input, second)
    await main.click(send)
    await withTimeout(secondHold.arrived, 5000, 'second pending conversation reply')
    await select(sessionB)
    const beforeRelease = context.stub.requests.length
    secondHold.release()
    await waitFor(() => context.stub.requests.slice(beforeRelease).some((request) => request.pathname === '/api/v1/chat/sessions'), { description: 'background A reply processed' })
    assert(!await contains(second), 'A background reply entered conversation B')
    await select(sessionA)
    await waitFor(() => contains(`E2E 小猪收到：${second}`), { description: 'background reply remains in A history' })

    const third = '历史读取期间完成的回答'
    const thirdHold = context.stub.holdNext('POST', '/api/v1/chat/message')
    holds.push(thirdHold)
    await main.input(input, third)
    await main.click(send)
    await withTimeout(thirdHold.arrived, 5000, 'third pending conversation reply')
    await select(sessionB)
    const staleHistory = context.stub.holdNext('GET', `/api/v1/chat/sessions/${sessionA.id}`, {
      statusCode: 200, payload: structuredClone(sessionA),
    })
    holds.push(staleHistory)
    await main.click(`[data-e2e-session-id="${sessionA.id}"]`)
    await withTimeout(staleHistory.arrived, 5000, 'history snapshot read before reply')
    const beforeThird = context.stub.requests.length
    thirdHold.release()
    await waitFor(() => context.stub.requests.slice(beforeThird).some((request) => request.pathname === '/api/v1/chat/sessions'), { description: 'third reply completes before history response' })
    staleHistory.release()
    await waitFor(() => contains(`E2E 小猪收到：${third}`), { description: 'stale selected history re-read after a completed reply' })
    const selectedReads = context.stub.requests.filter((request) => request.pathname === `/api/v1/chat/sessions/${sessionA.id}` && request.sequence > beforeThird)
    assert(selectedReads.length >= 1, 'The stale selected history was not refreshed')

    restoreFailure = context.stub.overrideResponse('POST', '/api/v1/chat/message', 503, { detail: '聊天服务暂时不可用，请稍后重试。' })
    const failed = context.stub.holdNext('POST', '/api/v1/chat/message')
    holds.push(failed)
    await main.input(input, '这条发送暂时失败')
    await main.click(send)
    await withTimeout(failed.arrived, 5000, 'held chat service failure')
    await main.input(input, '失败期间写的新草稿')
    failed.release()
    await waitFor(() => main.evaluate(`!document.querySelector(${JSON.stringify(send)}).disabled`), { description: 'chat 503 releases send control' })
    assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(input)}).value`), '失败期间写的新草稿', 'Chat 503 overwrote a newer draft')
    assert(await main.evaluate("document.querySelector('[data-e2e=main-dashboard]') !== null"), 'Chat 503 logged out a valid account')
    restoreFailure()
    restoreFailure = null
    await main.click(send)
    await waitFor(() => contains('E2E 小猪收到：失败期间写的新草稿'), { description: 'chat succeeds after service recovery' })
    return { initialHistoryRetainsDraft: true, initialHistoryBlocksUnresolvedSend: true, revisitShowsReply: true, failedHistoryRefreshKeepsReply: true, otherConversationIsolated: true, staleHistoryRefetched: true, newerDraftPreserved: true, serviceFailureRecovered: true }
  } finally {
    restoreFailure?.()
    restoreHistoryFailure?.()
    for (const hold of holds) hold.release()
  }
}

export async function quickChatRefreshRecoveryScenario(context) {
  await resetAuthenticated(context)
  const quick = context.pages.quick
  await callE2e(quick, 'showWindow', 'quick-chat')
  await quick.reload()
  await quick.waitForSelector(REQUIRED_SELECTORS.quickChatInput)
  const first = '偏好刷新失败时保留这条回答'
  const firstHold = context.stub.holdNext('POST', '/api/v1/chat/message')
  let secondHold
  let restorePreferences
  try {
    await quick.input(REQUIRED_SELECTORS.quickChatInput, first)
    await quick.click(REQUIRED_SELECTORS.quickChatSend)
    await withTimeout(firstHold.arrived, 5000, 'quick chat in flight before preference failure')
    restorePreferences = context.stub.overrideResponse('GET', '/api/v1/users/me/preferences', 503, { detail: 'Temporary preference failure' })
    await quick.evaluate('window.dispatchEvent(new Event("focus"))')
    await quick.waitForSelector('[data-e2e="quick-chat-sync-error"]')
    assert(await quick.evaluate(`Boolean(document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatInput)}))`), 'Preference failure removed the authenticated chat')
    firstHold.release()
    await waitFor(() => quick.evaluate(`document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatAssistantMessage)})?.textContent.includes(${JSON.stringify(`E2E 小猪收到：${first}`)})`), { description: 'in-flight quick reply survives optional preference failure' })
    await waitFor(() => quick.evaluate(`!document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatSend)}).disabled`), { description: 'quick chat does not remain stuck sending' })
    restorePreferences()
    restorePreferences = null
    await quick.evaluate('window.dispatchEvent(new Event("focus"))')
    await waitFor(() => quick.evaluate('!document.querySelector("[data-e2e=quick-chat-sync-error]")'), { description: 'preferences refresh recovers' })

    const privateMessage = '旧账号 A 的迟到回答'
    secondHold = context.stub.holdNext('POST', '/api/v1/chat/message')
    await quick.input(REQUIRED_SELECTORS.quickChatInput, privateMessage)
    await quick.click(REQUIRED_SELECTORS.quickChatSend)
    await withTimeout(secondHold.arrived, 5000, 'old account reply before logout')
    await switchAccountViaUi(context, USERS.B)
    await callE2e(quick, 'showWindow', 'quick-chat')
    await quick.waitForSelector(REQUIRED_SELECTORS.quickChatInput)
    secondHold.release()
    const currentMessage = '新账号 B 可以继续发送'
    await quick.input(REQUIRED_SELECTORS.quickChatInput, currentMessage)
    await quick.click(REQUIRED_SELECTORS.quickChatSend)
    await waitFor(() => quick.evaluate(`document.querySelector(${JSON.stringify(REQUIRED_SELECTORS.quickChatAssistantMessage)})?.textContent.includes(${JSON.stringify(currentMessage)})`), { description: 'new account sends after stale reply release' })
    assert(!await quick.evaluate(`document.querySelector('.quick-chat-thread').textContent.includes(${JSON.stringify(privateMessage)})`), 'Old account reply leaked into the new account')
    return { optionalRefreshKeepsChat: true, inFlightReplyPreserved: true, sendingRecovered: true, accountIsolation: true }
  } finally {
    restorePreferences?.()
    firstHold.release()
    secondHold?.release()
  }
}

export async function sessionSummaryHistoryScenario(context) {
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const createdAt = new Date().toISOString()
  account.sessions = Array.from({ length: 20 }, (_, index) => {
    const id = context.stub.fixture.nextSessionId++
    return {
      id, user_id: USERS.A.id, title: `摘要会话 ${index + 1}`, created_at: createdAt, updated_at: createdAt,
      messages: Array.from({ length: 20 }, (_, messageIndex) => ({
        id: messageIndex + 1, session_id: id, role: messageIndex % 2 ? 'assistant' : 'user',
        content: `会话 ${index + 1} 的消息 ${messageIndex + 1}：${'一段保留在服务端的历史。'.repeat(20)}`, created_at: createdAt,
      })),
    }
  })
  const newest = account.sessions[0]
  const second = account.sessions[1]
  const fullBytes = Buffer.byteLength(JSON.stringify(account.sessions))
  const summaryBytes = Buffer.byteLength(JSON.stringify(account.sessions.map((session) => ({ ...session, messages: [] }))))
  assert(summaryBytes < fullBytes / 10, 'Summary fixture does not meaningfully reduce history transfer')
  const firstRequest = context.stub.requests.length
  let restoreDetail = context.stub.overrideResponse('GET', `/api/v1/chat/sessions/${newest.id}`, 503, { detail: '这段历史暂时无法读取，请重新选择会话。' })
  let heldHistory
  const main = context.pages.main
  try {
    await resetAuthenticated(context)
    await waitFor(() => main.evaluate("document.querySelector('.main-header-status')?.textContent.includes('这段历史暂时无法读取')"), { description: 'optional initial history failure is visible after login' })
    assert(await main.evaluate("Boolean(document.querySelector('[data-e2e=main-dashboard]'))"), 'History failure blocked account recovery')
    await main.waitForSelector(`[data-e2e-session-id="${newest.id}"][aria-pressed="true"]`)
    const initialDetailReads = context.stub.requests.slice(firstRequest).filter((request) => request.pathname === `/api/v1/chat/sessions/${newest.id}`).length
    assert(initialDetailReads >= 1, 'The initial detail failure was not exercised')
    await main.input('[data-e2e="main-chat-input"]', '历史暂时不可用也能收到新回答')
    await main.click('[data-e2e="main-chat-send"]')
    await waitFor(() => main.evaluate("document.querySelector('.main-chat-stream').textContent.includes('E2E 小猪收到：历史暂时不可用也能收到新回答')"), { description: 'known answer is preserved when its detail refresh fails' })
    await waitFor(() => main.evaluate("document.querySelector('[data-e2e=main-chat-send]').textContent !== '发送中…' && document.querySelector('.main-chat-stream').getAttribute('aria-busy') === 'false'"), { description: 'failed detail refresh releases the active chat' })
    const firstSend = context.stub.requests.slice(firstRequest).filter((request) => request.pathname === '/api/v1/chat/message').map((request) => JSON.parse(request.body)).find((body) => body.message === '历史暂时不可用也能收到新回答')
    assertEqual(firstSend?.session_id, newest.id, 'Initial detail failure changed the first message to a new conversation')
    assert(context.stub.requests.slice(firstRequest).filter((request) => request.pathname === `/api/v1/chat/sessions/${newest.id}`).length > initialDetailReads, 'The reply detail failure was not exercised against the selected conversation')
    restoreDetail()
    restoreDetail = null
    await main.click(`[data-e2e-session-id="${newest.id}"]`)
    await waitFor(() => main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(newest.messages[0].content)})`), { description: 'newest history recovers through its own detail endpoint' })
    await main.click(`[data-e2e-session-id="${second.id}"]`)
    await waitFor(() => main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(second.messages[0].content)})`), { description: 'selecting a summary retrieves only its conversation' })
    assert(!await main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(newest.messages[0].content)})`), 'Selecting another summary retained the previous conversation messages')

    const restoringSession = account.sessions[0]
    heldHistory = context.stub.holdNext('GET', `/api/v1/chat/sessions/${restoringSession.id}`)
    await resetAuthenticated(context)
    await withTimeout(heldHistory.arrived, 5000, 'initial history read held after restored login')
    await main.click('[data-e2e="new-chat"]')
    await main.input('[data-e2e="main-chat-input"]', '历史恢复期间的新话题')
    heldHistory.release()
    await main.click('[data-e2e="main-chat-send"]')
    await waitFor(() => main.evaluate("document.querySelector('.main-chat-stream').textContent.includes('E2E 小猪收到：历史恢复期间的新话题')"), { description: 'late initial history cannot replace a new conversation' })
    assert(!await main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(restoringSession.messages[0].content)})`), 'A late initial detail entered the new conversation')
    const calls = context.stub.requests.slice(firstRequest)
    const listCalls = calls.filter((request) => request.method === 'GET' && request.pathname === '/api/v1/chat/sessions')
    assert(listCalls.length > 0 && listCalls.every((request) => new URLSearchParams(request.search).get('include_messages') === 'false'), 'Desktop fetched full message history inside a session list', listCalls)
    const body = calls.filter((request) => request.pathname === '/api/v1/chat/message').map((request) => JSON.parse(request.body)).find((value) => value.message === '历史恢复期间的新话题')
    assert(!body?.session_id, 'Late initial history rebound a new conversation to the old session')
    return { summariesOnly: true, initialDetailFailureRecoverable: true, initialDetailFailureKeepsConversation: true, replyRetainedOnDetailFailure: true, lateInitialHistoryIsolated: true, fullBytes, summaryBytes }
  } finally {
    restoreDetail?.()
    heldHistory?.release()
  }
}

export async function loginAccessibilityScenario(context) {
  await resetToLoggedOut(context)
  const main = context.pages.main
  const requestStart = context.stub.requests.length
  await main.input(REQUIRED_SELECTORS.loginApiBaseUrl, context.stub.apiBaseUrl)
  const nativeWindowControls = []
  for (const action of ['minimize', 'hide']) {
    const control = `[data-e2e="login-${action}"]`
    assert(await main.evaluate(`Boolean(document.querySelector(${JSON.stringify(control)})?.getAttribute('aria-label'))`), 'Login window control is unnamed')
    await main.evaluate(`(() => {
      window.__e2eWindowControlClick = null
      document.querySelector(${JSON.stringify(control)}).addEventListener('click', event => {
        window.__e2eWindowControlClick = { trusted: event.isTrusted, at: Date.now() }
      }, { once: true })
    })()`)
    const point = await main.click(control)
    try {
      // The control changes the native window. Page visibility alone does not
      // reliably report Windows minimization while a CDP session is attached.
      const snapshot = await expectSnapshot(main, snapshot => action === 'minimize'
        ? snapshot.windows?.mainPanel?.minimized === true
        : snapshot.windows?.mainPanel?.visible === false, `native login window ${action}`)
      const click = await main.evaluate('window.__e2eWindowControlClick')
      assert(click?.trusted, `Login ${action} was not activated by actual pointer input`)
      nativeWindowControls.push({ action, ...snapshot.windows.mainPanel,
        pageVisibility: await main.evaluate('document.visibilityState') })
    } catch (error) {
      error.details = { ...error.details, control, point, state: await main.evaluate(`({
        click: window.__e2eWindowControlClick, visibility: document.visibilityState,
        focused: document.hasFocus(), hit: document.elementFromPoint(${point.x}, ${point.y})?.outerHTML,
      })`) }
      throw error
    }
    await callE2e(main, 'showWindow', 'main-panel')
    await expectSnapshot(main, snapshot => snapshot.windows?.mainPanel?.visible === true
      && snapshot.windows?.mainPanel?.minimized === false, 'native login window restores')
    assertEqual(await main.evaluate("document.querySelector('[data-e2e=login-api-base-url]').value"), context.stub.apiBaseUrl, 'Hiding the login window discarded the service address')
  }
  const fields = await main.evaluate(`['server', 'username', 'password'].map((name) => {
    const input = document.querySelector('form').elements.namedItem(name);
    return { name, labels: input.labels.length, required: input.required, autocomplete: input.autocomplete };
  })`)
  assert(fields.every((field) => field.labels === 1 && field.required), 'Login fields lack visible labels or native validation', fields)
  assertEqual(fields[1].autocomplete, 'username')
  assertEqual(fields[2].autocomplete, 'current-password')
  await main.click(REQUIRED_SELECTORS.loginSubmit)
  assertEqual(await main.evaluate('document.activeElement.name'), 'username', 'Native required validation did not focus the empty username')
  await main.input(REQUIRED_SELECTORS.loginUsername, '   ')
  await main.input(REQUIRED_SELECTORS.loginPassword, USERS.A.password)
  await main.click(REQUIRED_SELECTORS.loginSubmit)
  await main.waitForSelector('#desktop-login-feedback[role="alert"]')
  assertEqual(await main.evaluate('document.activeElement.name'), 'username', 'Whitespace validation did not focus the username')
  assertEqual(await main.evaluate("document.activeElement.getAttribute('aria-describedby')"), 'desktop-login-feedback', 'Invalid field is not linked to its error')
  assert(await main.evaluate("parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2 && getComputedStyle(document.activeElement).outlineStyle !== 'none'"), 'Keyboard focus is not visible')
  assertEqual(context.stub.requests.slice(requestStart).filter((request) => ['/api/v1/auth/login', '/api/v1/public/version/win-x64'].includes(request.pathname)).length, 0, 'Invalid credentials made a network request')
  try {
    await main.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 650, deviceScaleFactor: 1, mobile: false })
    assert(await main.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Login form overflows horizontally at 800 by 650')
    await main.evaluate("document.querySelector('[data-e2e=login-submit]').scrollIntoView({ block: 'center' })")
    assert(await main.evaluate("(() => { const r = document.querySelector('[data-e2e=login-submit]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"), 'Login submit is unreachable at 800 by 650')
    await main.screenshot(`${context.artifactPath}/login-validation.png`)
  } finally {
    await main.send('Emulation.clearDeviceMetricsOverride')
  }
  await main.input(REQUIRED_SELECTORS.loginUsername, USERS.A.username)
  await main.input(REQUIRED_SELECTORS.loginPassword, 'incorrect-fixture-password')
  await main.click(REQUIRED_SELECTORS.loginSubmit)
  await waitFor(() => main.evaluate("!document.querySelector('[data-e2e=login-submit]').disabled && document.querySelector('#desktop-login-feedback[role=alert]')?.textContent.includes('Incorrect username or password')"), { description: 'failed login announces error and releases the form' })
  await main.input(REQUIRED_SELECTORS.loginPassword, USERS.A.password)
  await main.click(REQUIRED_SELECTORS.loginSubmit)
  await main.waitForSelector(REQUIRED_SELECTORS.mainDashboard)
  await expectSnapshot(main, (snapshot) => snapshot.account?.userId === USERS.A.id, 'corrected credentials succeed')
  return { associatedLabels: true, invalidInputsStayLocal: true, errorAnnounced: true, visibleFocus: true, windowControls: true, nativeWindowControls, retrySucceeds: true }
}

export async function conversationStartersScenario(context) {
  await resetAuthenticated(context)
  const main = context.pages.main
  await main.click('[data-e2e="new-chat"]')
  await main.waitForSelector('[data-e2e="chat-starters"]')
  const requestStart = context.stub.requests.length
  try {
    await main.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 650, deviceScaleFactor: 1, mobile: false })
    const layout = await main.evaluate(`(() => {
      const input = document.querySelector('[data-e2e=main-chat-input]').getBoundingClientRect();
      const send = document.querySelector('[data-e2e=main-chat-send]').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > window.innerWidth,
        inputVisible: input.top >= 0 && input.bottom <= window.innerHeight,
        sendVisible: send.top >= 0 && send.bottom <= window.innerHeight };
    })()`)
    assert(!layout.overflow && layout.inputVisible && layout.sendVisible, 'Starter suggestions pushed the composer outside the small window', layout)
    await main.screenshot(`${context.artifactPath}/first-conversation.png`)
    await main.evaluate("document.querySelector('[data-e2e=chat-starter-1]').focus()")
    await main.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await waitFor(() => main.evaluate("document.querySelector('[data-e2e=main-chat-input]').value === '我有点累了，陪我歇一会儿吧。'"), { description: 'keyboard starter selection fills the draft' })
    assert(await main.evaluate("document.activeElement === document.querySelector('[data-e2e=main-chat-input]')"), 'Choosing a starter did not focus the editable draft')
    assert(!await main.evaluate("Boolean(document.querySelector('[data-e2e=chat-starters]'))"), 'Suggestions remained over an existing draft')
    assertEqual(context.stub.requests.slice(requestStart).filter((request) => request.method === 'POST' && ['/api/v1/chat/message', '/api/v1/reminders'].includes(request.pathname)).length, 0, 'Choosing a starter sent a request without user confirmation')
    await main.input('[data-e2e="main-chat-input"]', '这是我自己修改后的开场白')
    await main.click('[data-e2e="main-chat-send"]')
    await waitFor(() => main.evaluate("document.querySelector('.main-chat-stream').textContent.includes('E2E 小猪收到：这是我自己修改后的开场白')"), { description: 'explicit send uses the edited starter draft' })
    assert(!await main.evaluate("Boolean(document.querySelector('[data-e2e=chat-starters]'))"), 'Existing history displayed new-conversation suggestions')
    const sentStarters = []
    for (let index = 0; index < 3; index += 1) {
      await main.click('[data-e2e="new-chat"]')
      await main.waitForSelector('[data-e2e="chat-starters"]')
      await main.click(`[data-e2e="chat-starter-${index}"]`)
      const draft = await main.evaluate("document.querySelector('[data-e2e=main-chat-input]').value")
      await main.click('[data-e2e="main-chat-send"]')
      await waitFor(() => main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(`E2E 小猪收到：${draft}`)})`), { description: `starter ${index + 1} reaches chat instead of reminder parsing` })
      sentStarters.push(draft)
    }
    assertEqual(context.stub.requests.slice(requestStart).filter((request) => request.method === 'POST' && request.pathname === '/api/v1/reminders').length, 0, 'A conversation starter created a reminder')
    await main.click('[data-e2e="new-chat"]')
    await main.waitForSelector('[data-e2e="chat-starters"]')
    await main.input('[data-e2e="main-chat-input"]', '保留我的新草稿')
    assert(!await main.evaluate("Boolean(document.querySelector('[data-e2e=chat-starters]'))"), 'Suggestions can overwrite a typed draft')
    assertEqual(await main.evaluate("document.querySelector('[data-e2e=main-chat-input]').value"), '保留我的新草稿', 'Starter state changed the user draft')
    return { keyboardDraftOnly: true, editableBeforeSend: true, existingDraftPreserved: true, sentStarters, smallWindow: layout }
  } finally {
    await main.send('Emulation.clearDeviceMetricsOverride')
  }
}

export async function loginResponseBoundaryScenario(context) {
  await ensureBaseBridge(context)
  const main = context.pages.main
  const held = []
  try {
    await resetToLoggedOut(context)
    await main.input(REQUIRED_SELECTORS.loginApiBaseUrl, context.stub.apiBaseUrl)
    const requestStart = context.stub.requests.length
    const connection = context.stub.holdNext('GET', '/api/v1/public/version/win-x64')
    held.push(connection)
    await main.click('[data-e2e="login-test-connection"]')
    await withTimeout(connection.arrived, 5000, 'pending connection check')
    assert(await main.evaluate("document.querySelector('[data-e2e=login-submit]').disabled"), 'Login stays enabled during a connection check')
    // Exercise synchronous handlers as well as the disabled button. Both
    // actions belong to one form and must not race through separate closures.
    await main.evaluate("document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))")
    connection.release()
    await waitFor(() => main.evaluate("!document.querySelector('[data-e2e=login-test-connection]').disabled"), { description: 'connection check releases the form' })
    assertEqual(context.stub.requests.slice(requestStart).filter((request) => request.pathname === '/api/v1/auth/login').length, 0, 'Submitting during connection validation sent a login')

    const startPendingLogin = async () => {
      await main.input(REQUIRED_SELECTORS.loginApiBaseUrl, context.stub.apiBaseUrl)
      await main.input(REQUIRED_SELECTORS.loginUsername, USERS.A.username)
      await main.input(REQUIRED_SELECTORS.loginPassword, USERS.A.password)
      const hold = context.stub.holdNext('POST', '/api/v1/auth/login')
      held.push(hold)
      await main.click(REQUIRED_SELECTORS.loginSubmit)
      await withTimeout(hold.arrived, 5000, 'pending account A login')
      return hold
    }

    const accountLogin = await startPendingLogin()
    assert(await main.evaluate("['login-api-base-url', 'login-username', 'login-password'].every((name) => document.querySelector('[data-e2e=' + name + ']').disabled)"), 'Login inputs can drift while credentials are in flight')
    await main.evaluate("document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))")
    const switched = await callE2e(main, 'switchAccount', {
      token: createJwt(USERS.B), userId: USERS.B.id, petType: 'pig',
      relationship: createRelationship(USERS.B),
    })
    assert(switched, 'The account B fixture was not applied')
    accountLogin.release()
    await waitFor(() => main.evaluate("Boolean(document.querySelector('[data-e2e=login-submit]') && !document.querySelector('[data-e2e=login-submit]').disabled)"), { description: 'stale login response is handled' })
    await expectSnapshot(main, (snapshot) => snapshot.account?.userId === USERS.B.id, 'account B survives delayed login A')
    assertEqual(context.stub.requests.slice(requestStart).filter((request) => request.pathname === '/api/v1/auth/login').length, 1, 'Duplicate submit issued a second login')
    await main.reload()
    await main.waitForSelector(REQUIRED_SELECTORS.mainDashboard)
    await expectSnapshot(main, (snapshot) => snapshot.renderer?.[0]?.userId === USERS.B.id, 'account B restores after the stale response')

    await resetToLoggedOut(context)
    const serverLogin = await startPendingLogin()
    const nextServer = context.stub.apiBaseUrl + '/replacement'
    const savedServer = await main.evaluate(`(async () => {
      const attempt = await window.desktopBridge.beginLoginAttempt(${JSON.stringify(nextServer)});
      return window.desktopBridge.setApiBaseUrl(${JSON.stringify(nextServer)}, attempt);
    })()`)
    assert(savedServer, 'Replacement server configuration was not accepted')
    serverLogin.release()
    await waitFor(() => main.evaluate("Boolean(document.querySelector('[data-e2e=login-submit]') && !document.querySelector('[data-e2e=login-submit]').disabled)"), { description: 'old-server login response is handled' })
    assert(await main.evaluate("(async () => !(await window.desktopBridge.getSessionToken()))()"), 'Old-server response saved a token to the replacement server')
    assertEqual(await main.evaluate('window.desktopBridge.getApiBaseUrl()'), nextServer, 'Old login restored the previous server')
    return { duplicateSubmitBlocked: true, connectionCheckSingleFlight: true, oldAccountResponseRejected: true, oldServerResponseRejected: true }
  } finally {
    for (const hold of held) hold.release()
    await resetToLoggedOut(context)
  }
}

export async function reminderDraftRecoveryScenario(context) {
  await resetAuthenticated(context)
  await context.pages.main.click('[data-e2e="new-chat"]')
  await context.pages.main.evaluate('window.desktopBridge.openQuickChat()')
  await context.pages.quick.reload()
  await context.pages.quick.waitForSelector(REQUIRED_SELECTORS.quickChatInput)
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const surfaces = [
    { client: context.pages.main, prefix: 'main', title: '起身走走' },
    { client: context.pages.quick, prefix: 'quick', title: '看看窗外' },
  ]
  const results = []
  for (const { client, prefix, title } of surfaces) {
    const input = `[data-e2e="${prefix}-chat-input"]`
    const send = `[data-e2e="${prefix}-chat-send"]`
    const feedback = `[data-e2e="${prefix}-reminder-draft-error"]`
    const start = context.stub.requests.length
    const pastClock = await client.evaluate('(() => { const d = new Date(); return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0") })()')
    for (const [draft, expected] of [
      ['提醒我喝水', '有效时间'],
      ['每周九点提醒我喝水', '每周几'],
      ['0分钟后提醒我喝水', '时长'],
      ['每天十分钟后提醒我喝水', '固定钟点'],
      ['十分钟后提醒我', '事情'],
      [`今天${pastClock}提醒我喝水`, '已经过去'],
    ]) {
      await client.input(input, draft)
      await client.click(send)
      await waitFor(() => client.evaluate(`document.querySelector(${JSON.stringify(feedback)})?.textContent.includes(${JSON.stringify(expected)})`), { description: `${prefix} actionable reminder feedback` })
      assertEqual(await client.evaluate(`document.querySelector(${JSON.stringify(input)}).value`), draft, 'Reminder validation erased the editable draft')
      assert(await client.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(input)}) && document.activeElement.getAttribute('aria-invalid') === 'true'`), 'Reminder validation did not retain input focus and error association')
    }
    assertEqual(context.stub.requests.slice(start).filter((request) => request.method === 'POST' && ['/api/v1/chat/message', '/api/v1/reminders'].includes(request.pathname)).length, 0, 'An invalid reminder was sent to chat or reminder API')
    await client.screenshot(`${context.artifactPath}/reminder-draft-${prefix}.png`)

    const draft = `十分钟后提醒我${title}`
    await client.input(input, draft)
    await waitFor(() => client.evaluate(`!document.querySelector(${JSON.stringify(feedback)})`), { description: 'editing clears old reminder feedback' })
    const restore = context.stub.overrideResponse('POST', '/api/v1/reminders', 503, { detail: '提醒暂时保存失败，请重试。' })
    const beforeFailure = context.stub.requests.length
    try {
      await client.click(send)
      await waitFor(() => context.stub.requests.slice(beforeFailure).some((request) => request.method === 'POST' && request.pathname === '/api/v1/reminders'), { description: 'relative reminder reaches API' })
      await waitFor(() => client.evaluate(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(draft)} && !document.querySelector(${JSON.stringify(send)}).disabled`), { description: 'failed relative reminder restores draft and releases sender' })
    } finally {
      restore()
    }
    const beforeCreated = account.reminders.length
    const beforeTime = Date.now()
    await client.click(send)
    const created = await waitFor(() => account.reminders.slice(beforeCreated).find((item) => item.source_text === draft), { description: 'corrected reminder persists' })
    assertEqual(created.title, title, 'Relative time leaked into reminder title')
    assertEqual(created.recurrence_type, 'once')
    const delay = Date.parse(created.remind_at) - beforeTime
    assert(delay >= 600_000 && delay <= 605_000, 'Relative reminder deadline is not ten minutes from submission', { delay })
    await waitFor(() => client.evaluate(`document.querySelector(${JSON.stringify(input)}).value === '' && !/发送中|Sending/.test(document.querySelector(${JSON.stringify(send)}).textContent)`), { description: 'successful relative reminder clears draft' })
    if (prefix === 'main') {
      await client.waitForSelector(`[data-e2e-upcoming-reminder-id="${created.id}"]`)
      assert(await client.evaluate(`!document.querySelector('.pet-onboarding-card.is-reminder_waiting')?.textContent.includes('一分钟后')`), 'Ordinary reminder displayed the one-minute sample promise')
    }
    assertEqual(account.reminders.length, beforeCreated + 1, 'Retry created duplicate reminders')
    assertEqual(context.stub.requests.slice(start).filter((request) => request.method === 'POST' && request.pathname === '/api/v1/chat/message').length, 0, 'Reminder correction entered model chat')
    results.push({ surface: prefix, invalidDraftsRetained: 6, apiFailureRetried: true, reminderId: created.id, delayMs: delay })
  }
  return { surfaces: results }
}

export async function upcomingReminderManagementScenario(context) {
  await ensureBaseBridge(context)
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const reminder = createReminderRecord({
    id: context.stub.fixture.nextReminderId++, user: USERS.A,
    title: '整理明天的出行清单', remindAt: new Date(Date.now() + 45 * 60_000),
  })
  const recurring = { ...createReminderRecord({
    id: context.stub.fixture.nextReminderId++, user: USERS.A,
    title: '不应混入一次性列表的重复事项', remindAt: new Date(Date.now() + 60 * 60_000),
  }), series_id: 999, recurrence_type: 'daily' }
  account.reminders.push(reminder, recurring)
  await resetAuthenticated(context)
  const main = context.pages.main
  const row = `[data-e2e-upcoming-reminder-id="${reminder.id}"]`
  const edit = `[data-e2e-reminder-edit="${reminder.id}"]`
  const input = `[data-e2e-reminder-time="${reminder.id}"]`
  const save = `[data-e2e-reminder-save-edit="${reminder.id}"]`
  const cancel = `[data-e2e-reminder-cancel="${reminder.id}"]`
  const error = '[data-e2e="upcoming-reminder-edit-error"]'
  await main.waitForSelector(row)
  assert(await main.evaluate(`!document.querySelector('[data-e2e-upcoming-reminder-id="${recurring.id}"]')`), 'Recurring reminders duplicated into upcoming once list')
  await main.click(edit)
  const setTime = async (at) => main.evaluate(`(() => {
    const date = new Date(${JSON.stringify(at.toISOString())});
    const pad = value => String(value).padStart(2, '0');
    const value = date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    const input = document.querySelector(${JSON.stringify(input)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { value, iso: new Date(value).toISOString() };
  })()`)
  const beforeInvalid = context.stub.requests.length
  await setTime(new Date(Date.now() - 10 * 60_000))
  await main.click(save)
  await main.waitForSelector(error)
  assertEqual(context.stub.requests.slice(beforeInvalid).filter((request) => request.method === 'PATCH').length, 0, 'Past reschedule reached API')
  const target = await setTime(new Date(Date.now() + 90 * 60_000))
  const restore = context.stub.overrideResponse('PATCH', `/api/v1/reminders/${reminder.id}`, 503, { detail: '提醒暂时无法保存' })
  try {
    const beforeFailed = context.stub.requests.length
    await main.click(save)
    await waitFor(() => context.stub.requests.slice(beforeFailed).some((request) => request.method === 'PATCH'), { description: 'failed reschedule reaches API' })
    await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(input)})?.value === ${JSON.stringify(target.value)} && !document.querySelector(${JSON.stringify(save)})?.disabled && Boolean(document.querySelector(${JSON.stringify(error)}))`), { description: 'failed reschedule keeps editable date' })
  } finally { restore() }
  await main.click(save)
  await waitFor(() => reminder.remind_at === target.iso, { description: 'retry persists exact local reschedule' })
  await waitFor(() => main.evaluate(`!document.querySelector(${JSON.stringify(input)}) && Boolean(document.querySelector(${JSON.stringify(row)}))`), { description: 'successful edit closes editor' })
  assertEqual(reminder.title, '整理明天的出行清单', 'Reschedule changed reminder title')
  await main.click(edit)
  await main.screenshot(`${context.artifactPath}/upcoming-reminder-edit.png`)
  await main.click(`[data-e2e-reminder-discard-edit="${reminder.id}"]`)
  await main.click(cancel)
  await waitFor(() => reminder.status === 'canceled', { description: 'upcoming cancellation persists' })
  await waitFor(() => main.evaluate(`!document.querySelector(${JSON.stringify(row)})`), { description: 'canceled reminder disappears from upcoming' })

  const heldReminder = createReminderRecord({
    id: context.stub.fixture.nextReminderId++, user: USERS.A,
    title: 'A账号独有的迟到取消', remindAt: new Date(Date.now() + 20 * 60_000),
  })
  account.reminders.push(heldReminder)
  await main.click('[data-e2e="upcoming-reminder-refresh"]')
  // Hold an explicit action while changing accounts; its response must not
  // repopulate the new account or show an A-specific success message.
  await main.waitForSelector(`[data-e2e-reminder-cancel="${heldReminder.id}"]`)
  const hold = context.stub.holdNext('PATCH', `/api/v1/reminders/${heldReminder.id}`)
  try {
    await main.click(`[data-e2e-reminder-cancel="${heldReminder.id}"]`)
    await withTimeout(hold.arrived, 10_000, 'held account A reminder cancellation')
    await switchAccountViaUi(context, USERS.B)
    hold.release()
    await main.waitForSelector('[data-e2e="upcoming-reminders"]')
    assert(await main.evaluate(`!document.querySelector('[data-e2e-upcoming-reminder-id="${heldReminder.id}"]') && !document.querySelector('[data-e2e="upcoming-reminders"]').textContent.includes(${JSON.stringify(heldReminder.title)})`), 'Late reminder response leaked into account B')
  } finally { hold.release() }
  return { reminderId: reminder.id, rescheduledTo: target.iso, pastTimeBlocked: true, failedEditRetained: true, cancellationPersisted: true, accountBoundaryHeld: true }
}

export const SCENARIOS = Object.freeze({
  targets: targetsScenario,
  'p1k-happy': happyPathScenario,
  'capability-ttl': capabilityTtlScenario,
  'main-reload-intent': withProactiveCompanionDisabled(mainReloadDuringIntentScenario),
  'account-switch-race': withProactiveCompanionDisabled(accountSwitchRaceScenario),
  'target-recreate': targetRecreateScenario,
  'intent-ack-false': withProactiveCompanionDisabled(intentAckFalseScenario),
  'intent-ack-timeout': withProactiveCompanionDisabled(intentAckTimeoutScenario),
  'quick-broadcast-before-chat': quickBroadcastBeforeChatScenario,
  'focus-together': focusTogetherScenario,
  'new-conversation': newConversationScenario,
  'companion-recovery': companionRecoveryScenario,
  'pet-switch-sync': petSwitchSyncScenario,
  'reduced-motion': reducedMotionScenario,
  'failed-knowledge-upload': failedKnowledgeUploadScenario,
  'hidden-reminder-deadline': hiddenReminderDeadlineScenario,
  'unmute-reminder': withProactiveCompanionDisabled(unmuteReminderScenario),
  'reminder-confirmation-retry': reminderConfirmationRetryScenario,
  'quick-chat-reminder-sync': quickChatReminderSyncScenario,
  'reminder-notification-receipt-recovery': reminderNotificationReceiptRecoveryScenario,
  'reminder-reconnect': withProactiveCompanionDisabled(reminderReconnectScenario),
  'conversation-return': conversationReturnScenario,
  'quick-chat-refresh-recovery': quickChatRefreshRecoveryScenario,
  'session-summary-history': sessionSummaryHistoryScenario,
  'login-response-boundary': loginResponseBoundaryScenario,
  'conversation-starters': conversationStartersScenario,
  'login-accessibility': loginAccessibilityScenario,
  'reminder-draft-recovery': reminderDraftRecoveryScenario,
  'upcoming-reminder-management': upcomingReminderManagementScenario,
})

export const FULL_SCENARIO_ORDER = Object.freeze(Object.keys(SCENARIOS))
