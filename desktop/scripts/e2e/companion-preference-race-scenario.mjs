import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship } from './fixtures.mjs'
import { callE2e, expectSnapshot, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 883, username: 'companion-preference-owner', email: 'companion-preference-owner@example.test', password: 'companion-preference-fixture-883' }
const WEEKLY = '/api/v1/pets/pig/weekly-summary'
const MODE_OPTION = '.companion-mode-option'

function setCompanionHour(pet, hour, minute = 0, second = 0) {
  return pet.evaluate(`(() => {
    window.restoreCompanionClock?.()
    const original = window.Date
    const instant = new original(2026, 10, 22, ${hour}, ${minute}, ${second}).getTime()
    window.Date = new Proxy(original, {
      construct: (target, args) => new target(...(args.length === 0 ? [instant] : args)),
    })
    window.restoreCompanionClock = () => { window.Date = original; delete window.restoreCompanionClock }
  })()`)
}

export async function companionPreferenceRaceScenario(context) {
  const { main, pet } = context.pages
  const { stub } = context
  stub.fixture.accounts.set(OWNER.id, {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', createRelationship(OWNER)]]), sessions: [], documents: [], reminders: [],
  })
  await resetToLoggedOut(context)
  const originalSettings = await main.evaluate('window.desktopBridge.getCompanionSettings()')
  await main.evaluate("window.desktopBridge.updateCompanionSettings({ mode: 'off', quietHoursStart: 23, quietHoursEnd: 8 })")
  try {
    await loginAs(context, OWNER)
    await callE2e(pet, 'showWindow', 'pet')
    await main.waitForSelector('[data-e2e="pet-weekly-summary"][aria-busy="false"]')
    await setCompanionHour(pet, 23)
    const { logPath } = await pet.evaluate('window.desktopBridge.getLogPaths()')
    const presentations = async () => (await readFile(logPath, 'utf8')).trim().split('\n')
      .filter((line) => JSON.parse(line).payload?.event === 'companion:event').length
    const initialPresentations = await presentations()
    const count = async () => {
      const config = JSON.parse(await readFile(join(context.userDataPath, 'config.json'), 'utf8'))
      return config.petCompanionState?.[`${OWNER.id}:pig`]?.proactiveCount ?? 0
    }
    const selectMode = async (mode, position) => {
      const selector = `${MODE_OPTION}:nth-child(${position})`
      await main.click(selector)
      await main.waitForSelector(`${selector}[aria-pressed="true"]`)
      await expectSnapshot(pet, (snapshot) => snapshot.renderer.some((entry) => entry.companionMode === mode),
        `the pet receives the ${mode} preference`)
    }

    const exerciseHeldOpportunity = async (whilePending, description) => {
      await expectSnapshot(pet, (snapshot) => snapshot.renderer.some((entry) => entry.companionStateReady
        && entry.visibility === 'visible' && entry.voicePhase === 'idle' && !entry.transientBubble
        && !entry.companionPending && !entry.requestPending && !entry.animationLocked && !entry.guide),
        'the visible pet is ready for a proactive opportunity')
      const held = stub.holdNext('GET', WEEKLY)
      let arrived = false
      void held.arrived.then(() => { arrived = true })
      // Start immediately and wait for the real renderer to request its copy inputs.
      const poll = callE2e(pet, 'flushCompanionPoll').catch((error) => error)
      try {
        await waitFor(() => arrived, { description })
        await expectSnapshot(pet, (snapshot) => snapshot.renderer.some((entry) => entry.companionPending),
          'this held summary belongs to the proactive poll')
        await whilePending()
      } finally {
        held.release()
      }
      const outcome = await poll
      if (outcome instanceof Error) throw outcome
      assertEqual(outcome, true, 'The proactive poll did not complete')
    }

    await selectMode('standard', 3)
    await setCompanionHour(pet, 9)
    await exerciseHeldOpportunity(() => selectMode('off', 1), 'the morning summary before switching companion mode off')
    assertEqual(await presentations(), initialPresentations, 'Turning off still showed a proactive bubble')
    assertEqual(await count(), 0, 'Turning off still consumed the proactive budget')

    await setCompanionHour(pet, 23)
    await selectMode('standard', 3)
    await setCompanionHour(pet, 22, 59, 58)
    await exerciseHeldOpportunity(() => setCompanionHour(pet, 23, 0, 5), 'the late-evening summary before quiet time')
    assertEqual(await presentations(), initialPresentations, 'Quiet hours still showed a proactive bubble')
    assertEqual(await count(), 0, 'Quiet hours still consumed the proactive budget')

    await setCompanionHour(pet, 9)
    await exerciseHeldOpportunity(() => undefined, 'a morning summary with the same preference and time')
    await waitFor(async () => await presentations() === initialPresentations + 1,
      { description: 'one proactive bubble while companionship is enabled' })
    assertEqual(await count(), 1, 'The allowed bubble did not consume exactly one proactive slot')
    return { offDuringRead: true, enteredQuietTimeDuringRead: true, allowedPresentations: 1, allowedProactiveCount: 1 }
  } finally {
    await pet.evaluate('window.restoreCompanionClock?.()')
    await main.evaluate(`window.desktopBridge.updateCompanionSettings(${JSON.stringify(originalSettings)})`)
  }
}
