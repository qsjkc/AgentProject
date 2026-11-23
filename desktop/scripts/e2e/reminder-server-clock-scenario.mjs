import { assert, assertEqual, waitFor } from './assertions.mjs'
import { createJwt, createPreferences, createRelationship, createReminderRecord } from './fixtures.mjs'
import { callE2e, hideMainPanel, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const OWNER = { id: 885, username: 'reminder-clock-owner', email: 'reminder-clock-owner@example.test', password: 'reminder-clock-fixture-885' }
const CLOCK_SKEW_MS = 6_000
const REMINDER_LEAD_MS = 3_000
const MAX_DELIVERY_LAG_MS = 4_000

async function exerciseSkew({ pages: { main, pet }, stub }, account, skewMs) {
  const description = `renderer clock ${skewMs} ms from the server`
  const nativeSubmissions = async () => (await callE2e(main, 'snapshot')).reminderNotificationAttempts
  await pet.evaluate(`(() => {
    const originalNow = Date.now;
    Date.now = () => originalNow() + ${skewMs};
    window.restoreReminderTestClock = () => { Date.now = originalNow; delete window.restoreReminderTestClock; };
  })()`)

  try {
    const before = await nativeSubmissions()
    const dueAt = Date.now() + REMINDER_LEAD_MS
    const reminder = createReminderRecord({
      user: OWNER, id: stub.fixture.nextReminderId++, title: `服务端到期提醒 ${skewMs}`,
      remindAt: new Date(dueAt),
    })
    const acknowledgments = () => stub.requests.filter(
      ({ method, pathname }) => method === 'POST' && pathname === `/api/v1/reminders/${reminder.id}/trigger`,
    )
    const hasBubble = () => pet.evaluate(
      `Boolean(document.querySelector('.pet-bubble')?.textContent.includes(${JSON.stringify(reminder.title)}))`,
    )
    account.reminders = [reminder]

    // Discover the future occurrence once. Its delivery uses the normal main-process timer.
    await callE2e(pet, 'flushReminderPoll')
    assert(Date.now() < dueAt, `Fixture did not finish its initial read before the deadline: ${description}`)
    assertEqual(acknowledgments().length, 0, `Sent an acknowledgment before server time: ${description}`)
    assertEqual(await nativeSubmissions(), before, `Submitted a notification before server time: ${description}`)
    assertEqual(await hasBubble(), false, `Displayed a bubble before server time: ${description}`)

    await waitFor(() => reminder.triggered_at, {
      timeoutMs: REMINDER_LEAD_MS + MAX_DELIVERY_LAG_MS,
      description: `automatic delivery at the server deadline with ${description}`,
    })
    const lag = Date.parse(reminder.triggered_at) - dueAt
    assert(lag >= 0 && lag <= MAX_DELIVERY_LAG_MS, `Delivered too early or late with ${description}`, { lag })
    await waitFor(hasBubble, { description: `visible reminder bubble with ${description}` })

    // A follow-up fresh poll must not repeat the notification or acknowledgment.
    await callE2e(pet, 'flushReminderPoll')
    const sent = acknowledgments()
    assertEqual(sent.length, 1, `Expected one successful acknowledgment with ${description}`)
    assertEqual(new URLSearchParams(sent[0].search).get('expected_remind_at'), reminder.remind_at,
      'The trigger did not match the delivered occurrence')
    assertEqual(await nativeSubmissions() - before, 1, `Expected one native submission with ${description}`)
    return { skewMs, deliveryLagMs: lag, acknowledgments: sent.length, nativeSubmissions: 1, bubbleVisible: true }
  } finally {
    account.reminders = []
    await pet.evaluate('window.restoreReminderTestClock?.()')
  }
}

export async function reminderServerClockScenario(context) {
  const { main, pet } = context.pages
  const account = {
    user: OWNER, token: createJwt(OWNER), preferences: createPreferences(OWNER),
    relationshipByPet: new Map([['pig', createRelationship(OWNER)]]), sessions: [], documents: [], reminders: [],
  }
  context.stub.fixture.accounts.set(OWNER.id, account)
  const previous = await main.evaluate('window.desktopBridge.getCompanionSettings()')
  try {
    await main.evaluate('window.desktopBridge.updateCompanionSettings({ mode: "off" })')
    await resetToLoggedOut(context)
    await loginAs(context, OWNER)
    await hideMainPanel(context)
    await callE2e(pet, 'showWindow', 'pet')
    await waitFor(() => pet.evaluate("document.visibilityState === 'visible'"), { description: 'the visible pet' })
    const ahead = await exerciseSkew(context, account, CLOCK_SKEW_MS)
    const behind = await exerciseSkew(context, account, -CLOCK_SKEW_MS)
    return { ahead, behind }
  } finally {
    await main.evaluate(`window.desktopBridge.updateCompanionSettings(${JSON.stringify(previous)})`)
  }
}
