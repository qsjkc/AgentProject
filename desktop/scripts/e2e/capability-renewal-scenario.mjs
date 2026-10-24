import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import {
  REQUIRED_SELECTORS,
  callE2e,
  ensureBaseBridge,
  expectSnapshot,
  loginAs,
  resetToLoggedOut,
} from './p1k-scenarios.mjs'

const USERS = Object.freeze({
  completed: Object.freeze({ id: 505, username: 'capability-renewal', email: 'capability-renewal@example.test', password: 'capability-renewal-password-505' }),
  empty: Object.freeze({ id: 606, username: 'capability-isolation', email: 'capability-isolation@example.test', password: 'capability-isolation-password-606' }),
})
const PANEL = '[data-e2e="focus-panel"]'
const FOCUS_REFRESH_COUNT = 64

export async function prepareCapabilityRenewalFixture({ userDataPath, apiBaseUrl, now = Date.now() }) {
  const storePath = join(userDataPath, 'config.json')
  let config = {}
  let exists = false
  try {
    config = JSON.parse(await readFile(storePath, 'utf8'))
    exists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const key = JSON.stringify([apiBaseUrl.replace(/\/+$/, ''), USERS.completed.id, 'pig'])
  assert(!config.focusSessions?.[key], 'Capability renewal fixture must use its own fresh account')
  const entry = {
    id: 'e2e-capability-renewal-completed',
    intention: '长时间陪伴后仍能开始下一段',
    durationMs: 15 * 60_000,
    completedAt: now,
  }
  // This merges only the dedicated account into the runner's fresh TEMP file,
  // before Electron starts; another scenario may already have seeded its fixture.
  config.focusSessions = {
    ...config.focusSessions,
    [key]: { ...entry, status: 'completed', revision: 1, remainingMs: 0, endsAt: null },
  }
  await writeFile(storePath, `${JSON.stringify(config, null, 2)}\n`, { flag: exists ? 'w' : 'wx' })
  return { evidence: 'completed-fixture-with-repeated-renderer-focus-reads', storePath, key, entry }
}

function addAccounts(context) {
  for (const user of Object.values(USERS)) {
    context.stub.fixture.accounts.set(user.id, {
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

async function readUi(main) {
  return main.evaluate(`(() => {
    const panel = document.querySelector('[data-e2e="focus-panel"]')
    return {
      status: panel?.getAttribute('data-focus-status'),
      busy: panel?.getAttribute('aria-busy'),
      error: panel?.querySelector('[role="alert"]')?.textContent || null,
      entries: Array.from(document.querySelectorAll('[data-e2e-focus-history-id]'), (node) => node.getAttribute('data-e2e-focus-history-id')),
    }
  })()`)
}

async function waitForFocus(main, status) {
  await main.waitForSelector(`${PANEL}[data-focus-status="${status}"][aria-busy="false"]`)
}

async function assertOneStoredCompletion(fixture, status) {
  const config = JSON.parse(await readFile(fixture.storePath, 'utf8'))
  const stored = config.focusSessions?.[fixture.key]
  assertEqual(stored?.status, status, 'Focus status was not saved after capability renewal')
  assertEqual(stored?.history?.length, 1, 'Capability renewal lost or duplicated completed history')
  for (const [field, value] of Object.entries(fixture.entry)) {
    assertEqual(stored.history[0][field], value, `Capability renewal changed persisted ${field}`)
  }
}

async function switchAccount(context, user) {
  await context.pages.main.click(REQUIRED_SELECTORS.logout)
  await loginAs(context, user)
  await expectSnapshot(context.pages.main, (snapshot) => (
    snapshot.account?.userId === user.id
    && snapshot.account?.petType === 'pig'
    && snapshot.renderer?.[0]?.relationshipId === createRelationship(user).id
  ), `capability renewal account ${user.id} hydrated`)
  await waitForFocus(context.pages.main, 'idle')
}

export async function capabilityRenewalScenario(context) {
  const fixture = context.capabilityRenewalFixture
  assert(fixture?.entry, 'Capability renewal requires its pre-start TEMP fixture')
  await ensureBaseBridge(context)
  addAccounts(context)
  await resetToLoggedOut(context)
  await loginAs(context, USERS.completed)
  const main = context.pages.main
  await waitForFocus(main, 'completed')
  await callE2e(main, 'showWindow', 'main-panel')
  await expectSnapshot(main, (snapshot) => snapshot.relationshipCapabilityAdopted === true,
    'initial relationship capability is adopted')

  // A renderer focus event uses the real FocusSessionPanel.load() ->
  // captureApiOperationContext() -> renewal IPC path. Scope reductions create
  // pet capabilities from the retained relationship context. Repeat beyond the
  // per-renderer LRU capacity, without authorizing/touching that source directly.
  // In particular, do not call e2e.snapshot() inside this loop: its relationship
  // authorization would refresh the source's LRU position and mask the defect.
  for (let index = 0; index < FOCUS_REFRESH_COUNT; index += 1) {
    await main.evaluate('window.dispatchEvent(new Event("focus"))')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await waitFor(async () => (await readUi(main)).busy === 'false', {
      description: `renderer focus refresh ${index + 1} settles`,
    })
    const ui = await readUi(main)
    assertEqual(ui.error, null, `Renderer focus refresh ${index + 1} lost its renewable source capability`)
    assertEqual(ui.status, 'completed', 'Renderer focus refresh changed completed focus state')
    assertEqual(ui.entries.length, 1, 'Renderer focus refresh lost completed history')
  }

  await main.click('[data-e2e="focus-reset"]')
  await waitForFocus(main, 'idle')
  const afterReset = await readUi(main)
  assertEqual(afterReset.error, null, 'Reset failed after repeated scope reductions')
  assertEqual(afterReset.entries[0], fixture.entry.id, 'Reset lost the completed entry')
  await assertOneStoredCompletion(fixture, 'idle')
  await main.reload()
  await waitForFocus(main, 'idle')
  assertEqual((await readUi(main)).entries[0], fixture.entry.id, 'Reload lost history after capability renewal')

  await switchAccount(context, USERS.empty)
  await main.waitForSelector('[data-e2e="focus-history-empty"]')
  assertEqual((await readUi(main)).entries.length, 0, 'Renewed focus capability crossed accounts')
  await switchAccount(context, USERS.completed)
  assertEqual((await readUi(main)).entries[0], fixture.entry.id, 'Original account did not recover its completion')
  await assertOneStoredCompletion(fixture, 'idle')
  await main.evaluate(`document.querySelector(${JSON.stringify(PANEL)}).scrollIntoView({ block: 'center' })`)
  const screenshot = join(context.artifactPath, 'capability-renewal-retained.png')
  await main.screenshot(screenshot)
  return {
    evidence: fixture.evidence,
    naturalTimerCompletionExercised: false,
    rendererFocusRefreshes: FOCUS_REFRESH_COUNT,
    resetAfterRepeatedRenewals: true,
    rendererReloadRetainsHistory: true,
    accountIsolation: true,
    screenshot,
  }
}
