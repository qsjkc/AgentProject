import { join } from 'node:path'
import { assert, assertEqual, waitFor } from './assertions.mjs'
import { USERS, createJwt, createRelationship } from './fixtures.mjs'
import { callE2e, ensureBaseBridge, expectSnapshot, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const ME = '/api/v1/auth/me'
const SESSIONS = '/api/v1/chat/sessions'
const DOCUMENTS = '/api/v1/rag/documents'
const DASHBOARD = '[data-e2e="main-dashboard"]'
const RETRYABLE = '[data-e2e="session-recovery"][data-state="retryable"]'
const RECOVERING = '[data-e2e="session-recovery"][data-state="recovering"]'
const LOGIN = '[data-e2e="login-submit"]'
const INPUT = '[data-e2e="main-chat-input"]'

async function session(main) {
  return main.evaluate('window.desktopBridge.getSessionSnapshot()')
}

async function absent(main, selector) {
  return main.evaluate(`!document.querySelector(${JSON.stringify(selector)})`)
}

async function heldArrival(hold, description) {
  let arrived = false
  void hold.arrived.then(() => { arrived = true })
  await waitFor(() => arrived, { description })
}

function observeNextResponse(main, pathname) {
  const evidence = { requestId: null, status: null, finished: false, failed: null }
  const removeListeners = [
    main.on('Network.requestWillBeSent', ({ requestId, request }) => {
      if (!evidence.requestId && request.method === 'GET' && new URL(request.url).pathname === pathname) evidence.requestId = requestId
    }),
    main.on('Network.responseReceived', ({ requestId, response }) => {
      if (requestId === evidence.requestId) evidence.status = response.status
    }),
    main.on('Network.loadingFinished', ({ requestId }) => {
      if (requestId === evidence.requestId) evidence.finished = true
    }),
    main.on('Network.loadingFailed', ({ requestId, errorText }) => {
      if (requestId === evidence.requestId) evidence.failed = errorText
    }),
  ]
  return { evidence, dispose: () => removeListeners.forEach((remove) => remove()) }
}

async function start(context) {
  await ensureBaseBridge(context)
  await resetToLoggedOut(context)
  await loginAs(context, USERS.A)
  await expectSnapshot(context.pages.main, (snapshot) => snapshot.renderer?.[0]?.userId === USERS.A.id, 'account A dashboard ready')
}

export async function sessionRecoveryScenario(context) {
  await start(context)
  const main = context.pages.main
  const saved = await session(main)
  const firstRequest = context.stub.requests.length
  const screenshots = []
  const held = []
  let restore = () => {}
  try {
    // A renderer with a real network failure must retain its saved session.
    await main.send('Network.enable')
    await main.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await main.reload()
    await main.waitForSelector(RETRYABLE)
    assertEqual(JSON.stringify(await session(main)), JSON.stringify(saved), 'Network failure discarded the saved account')
    assert(await absent(main, LOGIN), 'A network outage incorrectly requested credentials')
    assert(await absent(main, DASHBOARD), 'Unverified account data was shown during recovery')
    const retryScreenshot = join(context.artifactPath, 'session-recovery-offline.png')
    await main.screenshot(retryScreenshot)
    screenshots.push(retryScreenshot)

    // Bring the network back with a controlled 503, then exercise the real retry button.
    restore = context.stub.overrideResponse('GET', ME, 503, { detail: 'Temporary account service outage' })
    await main.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await main.click('[data-e2e="session-recovery-retry"]')
    await waitFor(() => main.evaluate(`Boolean(document.querySelector('${RETRYABLE}')) && document.querySelector('.session-recovery-error')?.textContent.includes('Temporary account service outage')`), { description: '503 account response remains retryable' })
    assertEqual(JSON.stringify(await session(main)), JSON.stringify(saved), '503 discarded the saved account')
    restore()
    const hold = context.stub.holdNext('GET', ME)
    held.push(hold)
    const beforeRetry = context.stub.requests.filter((request) => request.pathname === ME).length
    await main.click('[data-e2e="session-recovery-retry"]')
    await heldArrival(hold, 'single recovery request')
    await main.waitForSelector(RECOVERING)
    await main.evaluate(`(() => {
      for (let i = 0; i < 5; i += 1) {
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('focus'));
        document.querySelector('[data-e2e="session-recovery-retry"]').click();
      }
    })()`)
    hold.release()
    await main.waitForSelector(DASHBOARD)
    assertEqual(context.stub.requests.filter((request) => request.pathname === ME).length - beforeRetry, 1, 'Concurrent recovery events duplicated account restoration')
    const recoveredScreenshot = join(context.artifactPath, 'session-recovery-restored.png')
    await main.screenshot(recoveredScreenshot)
    screenshots.push(recoveredScreenshot)

    // Automatic event recovery uses the same saved token and obeys its cooldown.
    for (const event of ['online', 'focus']) {
      restore = context.stub.overrideResponse('GET', ME, 503, { detail: `Temporary ${event} outage` })
      await main.reload()
      await main.waitForSelector(RETRYABLE)
      restore()
      await new Promise((resolve) => setTimeout(resolve, 1600))
      await main.evaluate(`window.dispatchEvent(new Event(${JSON.stringify(event)}))`)
      await main.waitForSelector(DASHBOARD)
      assertEqual(JSON.stringify(await session(main)), JSON.stringify(saved), `${event} recovery changed credentials`)
    }
    assertEqual(context.stub.requests.slice(firstRequest).filter((request) => request.pathname === '/api/v1/auth/login').length, 0, 'Recovery unexpectedly performed password login')
    return { offlineSessionRetained: true, service503SessionRetained: true, manualRetry: true, onlineRetry: true, focusRetry: true, singleFlight: true, passwordLoginsDuringRecovery: 0, screenshots }
  } finally {
    restore()
    for (const hold of held) hold.release()
    await main.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }
}

export async function optionalDashboardRecoveryScenario(context) {
  await start(context)
  const main = context.pages.main
  const account = context.stub.fixture.accounts.get(USERS.A.id)
  const originalSessions = account.sessions
  const originalDocuments = account.documents
  const now = new Date().toISOString()
  const history = { id: context.stub.fixture.nextSessionId++, user_id: USERS.A.id, title: 'Recoverable history fixture', created_at: now, updated_at: now, messages: [{ id: 1, role: 'assistant', content: 'Old conversation must not replace a fresh draft', created_at: now }] }
  const document = { id: context.stub.fixture.nextDocumentId++, user_id: USERS.A.id, filename: 'recovered-note.txt', status: 'completed', created_at: now, chunk_count: 1 }
  account.sessions = [history]
  account.documents = [document]
  let restore = () => {}
  const held = []
  try {
    restore = context.stub.overrideResponse('GET', SESSIONS, 503, { detail: 'History temporarily unavailable' })
    await main.reload()
    await main.waitForSelector(DASHBOARD)
    await main.waitForSelector('[data-e2e="sessions-error"]')
    await main.click('[data-e2e="main-tab-knowledge"]')
    await main.waitForSelector(`[data-e2e-document-id="${document.id}"]`)
    assert(await absent(main, LOGIN), 'Optional history failure blocked the verified account')
    restore()
    await main.click('[data-e2e="main-tab-chat"]')
    await main.click('[data-e2e="sessions-retry"]')
    await main.waitForSelector(`[data-e2e-session-id="${history.id}"]`)
    assert(await absent(main, '[data-e2e="sessions-error"]'), 'Successful retry did not clear history error')

    restore = context.stub.overrideResponse('GET', DOCUMENTS, 503, { detail: 'Documents temporarily unavailable' })
    await main.reload()
    await main.waitForSelector(DASHBOARD)
    await main.waitForSelector(`[data-e2e-session-id="${history.id}"]`)
    await main.click('[data-e2e="main-tab-knowledge"]')
    await main.waitForSelector('[data-e2e="documents-error"]')
    restore()
    await main.click('[data-e2e="knowledge-refresh"]')
    await main.waitForSelector(`[data-e2e-document-id="${document.id}"]`)
    assert(await absent(main, '[data-e2e="documents-error"]'), 'Successful retry did not clear documents error')

    // Delayed initial history hydration cannot navigate away from a new draft.
    const historyHold = context.stub.holdNext('GET', SESSIONS)
    held.push(historyHold)
    await main.reload()
    await heldArrival(historyHold, 'delayed initial history')
    await main.waitForSelector(DASHBOARD)
    await main.click('[data-e2e="new-chat"]')
    const draft = 'Keep this unsent draft after history returns'
    await main.input(INPUT, draft)
    const beforeRelease = context.stub.requests.length
    historyHold.release()
    await main.waitForSelector(`[data-e2e-session-id="${history.id}"]`)
    assertEqual(await main.evaluate(`document.querySelector('${INPUT}').value`), draft, 'Late history discarded the unsent draft')
    assertEqual(await main.evaluate(`document.querySelector('[data-e2e-session-id="${history.id}"]').getAttribute('aria-pressed')`), 'false', 'Late list navigated to the old conversation')
    assertEqual(context.stub.requests.slice(beforeRelease).filter((request) => request.pathname === `${SESSIONS}/${history.id}`).length, 0, 'Late history loaded old conversation details')
    // Sending in the default empty conversation must also claim navigation before
    // its first session id exists. Do not click New Chat in these two cases.
    for (const kind of ['chat', 'reminder']) {
      account.sessions = [history]
      const initialList = context.stub.holdNext('GET', SESSIONS)
      held.push(initialList)
      await main.reload()
      await heldArrival(initialList, `initial history during first ${kind}`)
      await main.waitForSelector(DASHBOARD)
      const endpoint = kind === 'chat' ? '/api/v1/chat/message' : '/api/v1/reminders'
      const submission = context.stub.holdNext('POST', endpoint)
      held.push(submission)
      const message = kind === 'chat' ? 'First message while history is still loading' : '十分钟后提醒我核对恢复场景'
      await main.input(INPUT, message)
      await main.click('[data-e2e="main-chat-send"]')
      await heldArrival(submission, `first ${kind} accepted before list returns`)
      assertEqual(await main.evaluate(`document.querySelector('${INPUT}').value`), '', 'Accepted send did not clear its draft')
      const beforeList = context.stub.requests.length
      initialList.release()
      await main.waitForSelector(`[data-e2e-session-id="${history.id}"]`)
      assertEqual(await main.evaluate(`document.querySelector('[data-e2e-session-id="${history.id}"]').getAttribute('aria-pressed')`), 'false', `History replaced pending first ${kind}`)
      assertEqual(context.stub.requests.slice(beforeList).filter((request) => request.pathname === `${SESSIONS}/${history.id}`).length, 0, `History selected old details during first ${kind}`)
      if (kind === 'chat') assert(await main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(message)})`), 'Pending first message disappeared')
      submission.release()
      if (kind === 'chat') {
        await waitFor(() => main.evaluate(`document.querySelector('.main-chat-stream').textContent.includes(${JSON.stringify(`E2E 小猪收到：${message}`)})`), { description: 'first reply stays visible after late history' })
      } else {
        await waitFor(() => account.reminders.some((item) => item.source_text === message), { description: 'first reminder persists after late history' })
      }
    }
    return { historyFailureDoesNotBlockAccount: true, documentsFailureDoesNotBlockAccount: true, independentListRetries: true, delayedHistoryPreservesNewChatAndDraft: true, delayedHistoryPreservesFirstChat: true, delayedHistoryPreservesFirstReminder: true }
  } finally {
    restore()
    for (const hold of held) hold.release()
    account.sessions = originalSessions
    account.documents = originalDocuments
  }
}

export async function sessionRecoveryBoundaryScenario(context) {
  await start(context)
  const main = context.pages.main
  const held = []
  const observers = []
  let restore = () => {}
  try {
    const stale = context.stub.holdNext('GET', ME, { statusCode: 401, payload: { detail: 'Expired old account' } })
    held.push(stale)
    const staleResponse = observeNextResponse(main, ME)
    observers.push(staleResponse)
    await main.reload()
    await heldArrival(stale, 'account A restoration pending')
    await main.waitForSelector(RECOVERING)
    await main.click('[data-e2e="session-recovery-sign-out"]')
    await main.waitForSelector(LOGIN)
    assertEqual((await session(main)).token, null, 'Recovery sign out retained the token')
    await loginAs(context, USERS.B)
    const savedB = await session(main)
    stale.release()
    await waitFor(() => staleResponse.evidence.status !== null, { description: 'old account response headers reach the renderer' })
    // A rejected account context intentionally stops before response.json(), so
    // Chromium need not finish the unread body. Observe the real 401 arrival,
    // then let renderer reactions paint before checking the new account via IPC.
    await main.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assertEqual(staleResponse.evidence.status, 401, 'The observed old response was not the controlled 401')
    await expectSnapshot(main, (snapshot) => snapshot.account?.userId === USERS.B.id && snapshot.renderer?.[0]?.userId === USERS.B.id, 'account B survives stale 401')
    assertEqual(JSON.stringify(await session(main)), JSON.stringify(savedB), 'Old account failure cleared the new session')

    // A direct account switch while recovery is in flight must also reject the result.
    const switchHold = context.stub.holdNext('GET', ME)
    held.push(switchHold)
    await main.reload()
    await heldArrival(switchHold, 'account B restoration pending')
    assert(await callE2e(main, 'switchAccount', { token: createJwt(USERS.A), userId: USERS.A.id, petType: 'pig', relationship: createRelationship(USERS.A) }), 'Account fixture switch failed')
    const savedA = await session(main)
    switchHold.release()
    await main.waitForSelector(LOGIN)
    assertEqual(JSON.stringify(await session(main)), JSON.stringify(savedA), 'Late account B response changed account A')
    await main.reload()
    await main.waitForSelector(DASHBOARD)
    await expectSnapshot(main, (snapshot) => snapshot.renderer?.[0]?.userId === USERS.A.id, 'new account restores after old request finishes')

    const serverHold = context.stub.holdNext('GET', ME)
    held.push(serverHold)
    await main.reload()
    await heldArrival(serverHold, 'old server restoration pending')
    const nextServer = context.stub.apiBaseUrl + '/replacement'
    assert(await main.evaluate(`(async () => {
      const attempt = await window.desktopBridge.beginLoginAttempt(${JSON.stringify(nextServer)});
      return window.desktopBridge.setApiBaseUrl(${JSON.stringify(nextServer)}, attempt);
    })()`), 'Replacement server was not saved')
    serverHold.release()
    await main.waitForSelector(LOGIN)
    assert(await absent(main, DASHBOARD), 'Old server response restored its dashboard')
    assertEqual(await main.evaluate('window.desktopBridge.getApiBaseUrl()'), nextServer, 'Old response replaced the new service address')

    await resetToLoggedOut(context)
    await loginAs(context, USERS.A)
    restore = context.stub.overrideResponse('GET', ME, 401, { detail: 'Session expired' })
    await main.reload()
    await main.waitForSelector(LOGIN)
    assertEqual((await session(main)).token, null, 'Rejected session was not cleared')
    assert(await absent(main, RETRYABLE), 'Expired credentials incorrectly offered network recovery')
    return { recoverySignOut: true, stale401CannotClearNewAccount: true, stale401Response: { ...staleResponse.evidence }, lateAccountSwitchRejected: true, lateServerSwitchRejected: true, rejectedSessionReturnsToLogin: true }
  } finally {
    restore()
    for (const observer of observers) observer.dispose()
    for (const hold of held) hold.release()
    await resetToLoggedOut(context)
  }
}
