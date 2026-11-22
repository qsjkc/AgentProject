import { join } from 'node:path'

import { assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { callE2e, expectSnapshot, loginAs, REQUIRED_SELECTORS, resetToLoggedOut } from './p1k-scenarios.mjs'
import { startStubServer } from './stub-server.mjs'

const OWNER = { id: 871, username: 'daily-step-owner', email: 'daily-step-owner@example.test', password: 'daily-step-fixture-871' }
const OTHER = { id: 872, username: 'daily-step-other', email: 'daily-step-other@example.test', password: 'daily-step-fixture-872' }
const FOCUS_PANEL = '[data-e2e="focus-panel"]'
const FOCUS_INTENTION = '[data-e2e="focus-intention"]'
const FOCUS_TIME = '[data-e2e="focus-time"]'
const MAIN_CHAT_INPUT = '[data-e2e="main-chat-input"]'
const STEP_INPUT = '[data-e2e="daily-step-input"]'
const STEP_TITLE = '[data-e2e="daily-step-title"]'
const CARRY_OVER = '[data-e2e="daily-step-carry-over"]'
const CARRY_OVER_TITLE = '[data-e2e="daily-step-carry-over-title"]'

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

async function expectTodayLanding(main, source) {
  await expectSnapshot(main, (snapshot) => (
    snapshot.windows?.mainPanel?.visible === true
    && snapshot.windows?.mainPanel?.minimized === false
    && snapshot.account?.userId === OWNER.id
    && snapshot.account?.petType === 'pig'
  ), `${source} restores the same account's main panel`)
  await waitFor(() => main.evaluate(`(() => {
    const today = document.getElementById('companion-today')
    const heading = document.getElementById('companion-today-heading')
    const sidebar = today?.closest('.main-companion-sidebar')
    if (!heading || !sidebar || document.activeElement !== today) return false
    const label = heading.getBoundingClientRect()
    const visible = sidebar.getBoundingClientRect()
    return label.top >= visible.top && label.bottom <= visible.bottom
  })()`), { description: `${source} focuses and scrolls to the Today heading` })
}

function readValue(page, selector) {
  return page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
}

function showDailyStepDate(main, now) {
  // Move only the already-loaded main renderer to the desired local date.
  return main.evaluate(`(() => {
    window.restoreDailyStepClock?.()
    const originalNow = Date.now
    window.restoreDailyStepClock = () => { Date.now = originalNow; delete window.restoreDailyStepClock }
    Date.now = () => ${JSON.stringify(now)}
    window.dispatchEvent(new Event('focus'))
  })()`)
}

function restoreDailyStepDate(main) {
  return main.evaluate("window.restoreDailyStepClock?.(); window.dispatchEvent(new Event('focus'))")
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
  const { main, pet, quick } = context.pages
  const title = '读完两页书'
  addDailyStepAccounts(context.stub)
  await resetToLoggedOut(context)
  await loginAs(context, OWNER)
  await waitForScope(main, OWNER, 'pig')
  await expectStep(main, 'empty')

  await main.input(STEP_INPUT, title)
  await main.click('[data-e2e="daily-step-save"]')
  await expectStep(main, 'planned', title)

  const mainDraft = '主面板里还没有发送的话'
  await main.input(MAIN_CHAT_INPUT, mainDraft)
  await main.click(REQUIRED_SELECTORS.mainTabKnowledge)
  await main.waitForSelector(`${REQUIRED_SELECTORS.mainTabKnowledge}[aria-pressed="true"]`)
  await main.evaluate('window.desktopBridge.hideMainPanel()')
  await expectSnapshot(main, (snapshot) => snapshot.windows?.mainPanel?.visible === false, 'main panel is natively hidden')
  await callE2e(pet, 'showWindow', 'pet')
  await pet.click('[data-e2e="pet-open-today"]')
  await expectTodayLanding(main, 'pet Today shortcut')
  await main.waitForSelector(`${FOCUS_PANEL}[data-focus-status="idle"]`)
  await expectStep(main, 'planned', title)
  assertEqual(await readValue(main, MAIN_CHAT_INPUT), mainDraft, 'Pet Today shortcut discarded a main chat draft')

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

  await main.click('[data-e2e="focus-toggle"]')
  await main.waitForSelector(`${FOCUS_PANEL}[data-focus-status="paused"]`)
  const readFocusTime = () => main.evaluate(`document.querySelector(${JSON.stringify(FOCUS_TIME)})?.textContent`)
  const pausedTime = await readFocusTime()
  await main.evaluate('window.desktopBridge.minimizeMainPanel()')
  await expectSnapshot(main, (snapshot) => snapshot.windows?.mainPanel?.minimized === true, 'main panel is natively minimized')
  await callE2e(quick, 'showWindow', 'quick-chat')
  const quickDraft = '快捷聊天里还没有发送的话'
  await quick.input(REQUIRED_SELECTORS.quickChatInput, quickDraft)
  await quick.click('[data-e2e="quick-open-today"]')
  await expectTodayLanding(main, 'quick chat Today shortcut')
  await main.waitForSelector(`${FOCUS_PANEL}[data-focus-status="paused"]`)
  assertEqual(await readFocusTime(), pausedTime, 'Quick chat Today shortcut advanced the paused timer')
  assertEqual(await readValue(quick, REQUIRED_SELECTORS.quickChatInput), quickDraft, 'Quick chat Today shortcut discarded its draft')
  assertEqual(await readValue(main, MAIN_CHAT_INPUT), mainDraft, 'Quick chat Today shortcut discarded a main chat draft')

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

  const tomorrow = await main.evaluate(`(() => {
    const date = new Date()
    date.setDate(date.getDate() + 1)
    return date.setHours(12, 0, 0, 0)
  })()`)
  try {
    await showDailyStepDate(main, tomorrow)
    await expectStep(main, 'empty')
    assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(CARRY_OVER)}) === null`), true,
      'A completed yesterday step was offered for carry-over')
  } finally {
    await restoreDailyStepDate(main)
  }
  await expectStep(main, 'completed', title)

  await main.click('[data-e2e="daily-step-undo"]')
  await expectStep(main, 'planned', title)
  try {
    await showDailyStepDate(main, tomorrow)
    await expectStep(main, 'empty')
    await main.waitForSelector(CARRY_OVER)
    assertEqual(await main.evaluate(`document.querySelector(${JSON.stringify(CARRY_OVER_TITLE)})?.textContent.trim()`), title,
      'Carry-over did not show the unfinished yesterday step')
    const newDraft = '今天自己的计划草稿'
    const carryIsDisabled = () => main.evaluate(`document.querySelector(${JSON.stringify(CARRY_OVER)})?.disabled`)
    await main.input(STEP_INPUT, newDraft)
    await waitFor(carryIsDisabled, { description: 'carry-over does not overwrite an unsaved today step' })
    assertEqual(await readValue(main, STEP_INPUT), newDraft, 'An unfinished yesterday step replaced today’s draft')
    await main.input(STEP_INPUT, '')
    await waitFor(async () => (await carryIsDisabled()) === false, { description: 'carry-over can be chosen after clearing the draft' })

    await main.click(CARRY_OVER)
    await expectStep(main, 'planned', title)
    await main.reload()
    await waitForScope(main, OWNER, 'pig')
    await showDailyStepDate(main, tomorrow)
    await expectStep(main, 'planned', title)
    await main.click('[data-e2e="daily-step-edit"]')
    await main.click('[data-e2e="daily-step-remove"]')
    await expectStep(main, 'empty')
  } finally {
    await restoreDailyStepDate(main)
  }
  await expectStep(main, 'empty')
  assertEqual(context.stub.requests.some((request) => request.body.includes(title)), false,
    'The local daily step title was sent to the service')
  assertEqual(context.stub.requests.some((request) => (
    request.method === 'POST' && request.pathname === '/api/v1/chat/message'
    && (request.body.includes(mainDraft) || request.body.includes(quickDraft))
  )), false, 'A Today shortcut sent an unsent chat draft')

  return {
    petTodayFromHiddenKnowledge: true,
    quickTodayFromMinimizedPanel: true,
    preservesPausedFocus: true,
    preservesChatDrafts: true,
    manualStart: true,
    preservesExistingIntention: true,
    manualCompletion: true,
    undo: true,
    rendererReload: true,
    petIsolation: true,
    accountIsolation: true,
    serverIsolation: true,
    simulatedCalendarChange: true,
    carriesUnfinishedStepOnRequest: true,
    protectsTodayStepDraft: true,
    localTitle: true,
    removed: true,
    screenshot,
  }
}
