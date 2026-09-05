import { assert, assertEqual, assertIncludes, waitFor } from './assertions.mjs'
import {
  CAPABILITY_TTL_MS,
  E2E_PROTOCOL_VERSION,
  USERS,
  createJwt,
  createRelationship,
} from './fixtures.mjs'

export const REQUIRED_E2E_BRIDGE_API = Object.freeze({
  protocolVersion: E2E_PROTOCOL_VERSION,
  methods: Object.freeze([
    'describe',
    'reset',
    'snapshot',
    'showWindow',
    'prepareOnboarding',
    'expireOperationCapabilities',
    'switchAccount',
    'destroyWindow',
    'recreateWindow',
    'setMainPanelIntentAckMode',
    'broadcastRelationshipTo',
    'flushReminderPoll',
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

async function expectSnapshot(client, predicate, description, timeoutMs = 10_000) {
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

async function ensureBaseBridge(context) {
  await Promise.all([
    requireE2eBridge(context.pages.pet, 'pet'),
    requireE2eBridge(context.pages.quick, 'quick-chat'),
    requireE2eBridge(context.pages.main, 'main-panel'),
  ])
}

async function resetToLoggedOut(context) {
  await callE2e(context.pages.main, 'reset', {
    protocolVersion: E2E_PROTOCOL_VERSION,
    account: null,
    relationship: null,
    onboarding: { reset: true },
  })
  await callE2e(context.pages.main, 'showWindow', 'main-panel')
  await context.pages.main.reload()
}

async function loginAs(context, user) {
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

async function hideMainPanel(context) {
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
  return { entries, bridge }
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
  const before = context.stub.requests.length
  const expiry = await callE2e(context.pages.main, 'expireOperationCapabilities')
  assert(expiry?.expired > 0, 'E2E hook did not expire an operation capability', expiry)
  await callE2e(context.pages.main, 'triggerRelationshipRefresh')
  await waitFor(
    () => context.stub.requests.slice(before).some((request) => request.pathname === '/api/v1/pets/pig/relationship'),
    { timeoutMs: CAPABILITY_TTL_MS, description: 'real relationship request after capability TTL' },
  )
  const snapshot = await expectSnapshot(
    context.pages.main,
    (value) => value.lastCompletedRequest?.path === '/pets/pig/relationship' && value.lastCompletedRequest?.ok === true,
    'successful post-TTL request commit',
  )
  return { expiry, lastCompletedRequest: snapshot.lastCompletedRequest }
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
  await callE2e(
    context.pages.main,
    'broadcastRelationshipTo',
    'quick-chat',
    createRelationship(USERS.A),
  )
  await callE2e(context.pages.quick, 'showWindow', 'quick-chat')
  const adopted = await expectSnapshot(
    context.pages.quick,
    (value) => value.relationship?.user_id === 101 && value.relationshipCapabilityAdopted === true,
    'quick-chat relationship broadcast adoption',
  )
  await context.pages.quick.input(REQUIRED_SELECTORS.quickChatInput, '你好，小猪')
  await context.pages.quick.click(REQUIRED_SELECTORS.quickChatSend)
  await context.pages.quick.waitForSelector(REQUIRED_SELECTORS.quickChatAssistantMessage)
  assert(
    context.stub.requests.some((request) => request.pathname === '/api/v1/chat/message'),
    'Quick chat did not make a real stub-backed chat request',
  )
  return { adoptedRelationship: adopted.relationship }
}

export const SCENARIOS = Object.freeze({
  targets: targetsScenario,
  'p1k-happy': happyPathScenario,
  'capability-ttl': capabilityTtlScenario,
  'main-reload-intent': mainReloadDuringIntentScenario,
  'account-switch-race': accountSwitchRaceScenario,
  'target-recreate': targetRecreateScenario,
  'intent-ack-false': intentAckFalseScenario,
  'intent-ack-timeout': intentAckTimeoutScenario,
  'quick-broadcast-before-chat': quickBroadcastBeforeChatScenario,
})

export const FULL_SCENARIO_ORDER = Object.freeze(Object.keys(SCENARIOS))
