// Real Electron UI -> real FastAPI -> disposable SQLite. No production writes.
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm, access, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assert, waitFor, serializeError } from './e2e/assertions.mjs'
import { CdpClient, fetchPageTargets, mapRendererTargets, waitForDevToolsActivePort } from './e2e/cdp-client.mjs'
import { removeSafeUserDataPath } from './e2e/run.mjs'
import { REQUIRED_SELECTORS as S } from './e2e/p1k-scenarios.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktop = join(root, 'desktop')
const packaged = process.argv.includes('--packaged')
const registrationOnly = process.argv.includes('--registration-only')
const timeZoneOverride = process.argv.find((value) => value.startsWith('--timezone='))?.slice('--timezone='.length)
if (timeZoneOverride) new Intl.DateTimeFormat('en', { timeZone: timeZoneOverride })
const expectedVersion = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version
const runtime = await mkdtemp(join(tmpdir(), 'detachym-e2e-real-'))
const userData = await mkdtemp(join(tmpdir(), 'detachym-e2e-user-'))
const artifacts = join(desktop, 'artifacts/e2e', `real-backend-${Date.now()}`)
const password = `Acceptance-${randomBytes(12).toString('hex')}`
const secret = randomBytes(32).toString('hex')
const execAsync = promisify(execFile)
const report = { status: 'running', backend: 'real-local-fastapi-sqlite', packaged, registrationOnly, checks: [], artifacts }
report.evidenceScope = { registration: 'real Web UI and FastAPI, no seeded accounts', email: 'local SMTP STARTTLS/AUTH capture; not external inbox delivery', growth: 'real earned XP and outfits; long-term level thresholds covered separately by backend tests' }
const identities = {}
let backend
let electron
let browser
let registrationPage
let expiringMessage
let backendPort
let pages = {}
let backendLogs = ''
let electronLogs = ''
const apiOrigins = new Set()
const processEnv = { ...process.env }
delete processEnv.ELECTRON_RUN_AS_NODE
delete processEnv.ELECTRON_RENDERER_URL
delete processEnv.DETACHYM_E2E

function launchProcess(command, args, options) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  child.on('error', (error) => { child.launchError = error })
  return child
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
  await execAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { description: 'owned process exit' })
}

async function startBackend() {
  backend = launchProcess(join(root, 'backend/venv/Scripts/python.exe'), [
    join(root, 'backend/scripts/desktop_acceptance_backend.py'),
  ], {
    cwd: runtime,
    env: { ...processEnv, PYTHONPATH: join(root, 'backend'), PYTHONUNBUFFERED: '1',
      DETACHYM_ACCEPTANCE_RUNTIME: runtime,
      DETACHYM_ACCEPTANCE_SECRET: secret, DETACHYM_ACCEPTANCE_PORT: String(backendPort || 0),
      DETACHYM_ACCEPTANCE_FRONTEND_DIST: join(root, 'frontend/dist'), PYTHONDONTWRITEBYTECODE: '1' },
  })
  let stdout = ''
  backend.stdout.on('data', (chunk) => { stdout += chunk; backendLogs += chunk })
  backend.stderr.on('data', (chunk) => { backendLogs += chunk })
  await waitFor(() => {
    if (backend.launchError) throw backend.launchError
    const match = stdout.match(/"acceptancePort":\s*(\d+)/)
    if (match) { backendPort = Number(match[1]); return true }
    return false
  }, { description: 'real backend port', timeoutMs: 30_000 })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${backendPort}/health/ready`)).ok,
    { description: 'real backend ready', timeoutMs: 30_000, intervalMs: 300 })
}

const baseUrl = () => `http://127.0.0.1:${backendPort}/api/v1`
async function inspectDatabase() {
  const { stdout } = await execAsync(join(root, 'backend/venv/Scripts/python.exe'), [
    join(root, 'backend/scripts/desktop_acceptance_backend.py'), '--inspect',
  ], { windowsHide: true, env: { ...processEnv, DETACHYM_ACCEPTANCE_RUNTIME: runtime, PYTHONDONTWRITEBYTECODE: '1' } })
  return JSON.parse(stdout)
}
async function receivedCode(email, subject = '注册验证码') {
  return waitFor(async () => {
    const messages = JSON.parse(await readFile(join(runtime, 'smtp-messages.json'), 'utf8'))
    const message = messages.findLast((item) => item.recipients.includes(email) && item.subject.includes(subject))
    if (!message) return null
    const code = message.html.match(/>(\d{6})</)?.[1]
    assert(code && message.tls && message.authenticated, 'Verification mail did not traverse authenticated SMTP with STARTTLS')
    return { ...message, code }
  }, { description: `local SMTP receipt for ${email}` })
}
async function launchRegistrationBrowser() {
  const browserData = join(runtime, 'web-user-data')
  await mkdir(browserData, { recursive: true })
  let edgePath
  for (const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']) {
    try { await access(candidate); edgePath = candidate; break } catch {}
  }
  assert(edgePath, 'Microsoft Edge is required for actual Web registration UI acceptance')
  browser = launchProcess(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    `--user-data-dir=${browserData}`, `http://127.0.0.1:${backendPort}/register`,
  ], { cwd: runtime, env: processEnv })
  const { port } = await waitForDevToolsActivePort(browserData)
  const target = await waitFor(async () => (await fetchPageTargets(port)).find((item) => item.url.includes('/register')),
    { description: 'real registration page in isolated browser' })
  registrationPage = await CdpClient.connect(target.webSocketDebuggerUrl)
  await registrationPage.enable()
  await registrationPage.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false })
  await registrationPage.waitForReady()
  await registrationPage.waitForSelector('input[autocomplete="username"]', { timeoutMs: 30_000 })
}
async function stopRegistrationBrowser() {
  try { await registrationPage?.send('Browser.close', {}, { timeoutMs: 2000 }) } catch {}
  registrationPage?.close()
  await stopProcess(browser)
  // Edge can hand off to a detached browser process. Match only this run's
  // exact isolated profile argument; never terminate the user's normal Edge.
  const script = [
    "$profilePath = [Environment]::GetEnvironmentVariable('DETACHYM_ACCEPTANCE_EDGE_PROFILE', 'Process')",
    "$targets = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $profilePath) }",
    "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('; ')
  await execAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, env: { ...processEnv, DETACHYM_ACCEPTANCE_EDGE_PROFILE: join(runtime, 'web-user-data') },
  })
}
async function fillRegistration(suffix, code = '') {
  await registrationPage.input('input[autocomplete="username"]', `accept-${suffix}`)
  await registrationPage.input('input[autocomplete="email"]', `accept-${suffix}@example.com`)
  await registrationPage.input('input[autocomplete="new-password"]', password)
  if (code) await registrationPage.input('input[autocomplete="one-time-code"]', code)
}
async function navigateRegistration() {
  let loaded = false
  const unsubscribe = registrationPage.on('Page.loadEventFired', () => { loaded = true })
  try {
    await registrationPage.send('Page.navigate', { url: `http://127.0.0.1:${backendPort}/register` })
    await waitFor(() => loaded, { description: 'new registration document load' })
    await registrationPage.waitForSelector('input[autocomplete="username"]')
  } finally { unsubscribe() }
}
async function registerViaWeb(suffix) {
  await registrationPage.evaluate('localStorage.clear()')
  await navigateRegistration()
  await fillRegistration(suffix)
  await clickEnabled(registrationPage, 'form button[type="button"]')
  const message = await receivedCode(`accept-${suffix}@example.com`)
  const invalidCode = message.code === '000000' ? '999999' : '000000'
  await registrationPage.input('input[autocomplete="one-time-code"]', invalidCode)
  await clickEnabled(registrationPage, 'form button[type="submit"]')
  await registrationPage.waitForSelector('[role="alert"]')
  assert(await registrationPage.evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('验证码')`), 'Wrong code did not produce verification feedback')
  assert(!(await inspectDatabase()).users.some((user) => user.email === `accept-${suffix}@example.com`), 'Wrong code created an account')
  await registrationPage.input('input[autocomplete="one-time-code"]', message.code)
  await clickEnabled(registrationPage, 'form button[type="submit"]')
  await waitFor(() => registrationPage.evaluate('location.pathname === "/account" && !!localStorage.getItem("token")'),
    { description: 'successful real registration and automatic Web login' })
  const token = await registrationPage.evaluate('localStorage.getItem("token")')
  const me = await api('/auth/me', token)
  assert(me.preferences.pet_type === 'pig', 'Registered account did not default to pig')
  identities[suffix] = me.id
  const duplicate = await fetch(`${baseUrl()}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `accept-${suffix}-replay`, email: me.email, password, verification_code: message.code }),
  })
  assert(duplicate.status === 400, 'Registration code replay created another account')
  const audit = await inspectDatabase()
  assert(audit.codes.some((item) => item.email === me.email && item.purpose === 'register' && item.consumed_at), 'Successful registration did not consume its code')
  await registrationPage.screenshot(join(artifacts, `registered-${suffix}.png`))
  return { userId: me.id, wrongCodeRejected: true, registrationCodeConsumed: true, replayRejected: true,
    automaticWebLogin: true, smtpTls: message.tls, smtpAuthenticated: message.authenticated }
}
async function api(path, token, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    signal: AbortSignal.timeout(20_000),
  })
  assert(response.ok, `Real API ${path}: HTTP ${response.status}`)
  return response.json()
}
async function tokenFor(suffix) {
  return (await api('/auth/login', null, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: `accept-${suffix}`, password }),
  })).access_token
}
async function launchDesktop() {
  await rm(join(userData, 'DevToolsActivePort'), { force: true })
  const executable = packaged ? join(desktop, 'dist/releases/win-unpacked/Detachym.exe')
    : join(desktop, 'node_modules/electron/dist/electron.exe')
  electron = launchProcess(executable, [
    ...(packaged ? [] : [desktop]), '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userData}`,
  ], { cwd: desktop, env: { ...processEnv, DETACHYM_API_BASE_URL: baseUrl(), APPDATA: join(runtime, 'AppData') } })
  electron.stdout.on('data', (chunk) => { electronLogs += chunk })
  electron.stderr.on('data', (chunk) => { electronLogs += chunk })
  const { port } = await waitForDevToolsActivePort(userData)
  const targets = await waitFor(async () => {
    const mapped = mapRendererTargets(await fetchPageTargets(port))
    return mapped.size === 3 ? mapped : null
  }, { description: 'three real desktop windows', timeoutMs: 20_000 })
  pages = {}
  for (const [entry, target] of targets) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl)
    pages[entry] = client
    await client.enable()
    if (timeZoneOverride) await client.send('Emulation.setTimezoneOverride', { timezoneId: timeZoneOverride })
    await client.waitForReady()
    assert(await client.evaluate('!!window.desktopBridge && !window.desktopBridge.e2e'), 'No test-control bridge allowed')
    if (packaged) assert(target.url.includes('app.asar'), 'Must load packaged renderer')
  }
  await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
  const version = await pages['pet.html'].evaluate('window.desktopBridge.getAppVersion()')
  assert(version === expectedVersion, 'Actual executable version must match the checkout', { version, expectedVersion })
}
async function stopDesktop() {
  for (const client of Object.values(pages)) {
    collectApiOrigins(client)
    client.close()
  }
  pages = {}
  await stopProcess(electron)
}
function collectApiOrigins(client) {
  for (const entry of client?.diagnostics.network || []) {
    const value = entry.request?.url
    if (!value?.startsWith('http')) continue
    const url = new URL(value)
    if (url.pathname.startsWith('/api/v1/')) apiOrigins.add(url.origin)
  }
}
function safeDiagnostics(client) {
  return { ...client.diagnostics, network: client.diagnostics.network.map((entry) => ({
    at: entry.at, method: entry.method, url: entry.request?.url || entry.response?.url,
    status: entry.response?.status, errorText: entry.errorText,
  })) }
}
function collectCareRewardRequests() {
  return Object.values(pages).flatMap((client) => client.diagnostics.network.flatMap((entry) => {
    if (!entry.request?.url?.endsWith('/relationship/rewards')) return []
    let payload
    try { payload = JSON.parse(entry.request.postData || '{}') } catch { return [] }
    return payload.action ? [{ at: entry.at, url: entry.request.url, action: payload.action }] : []
  }))
}
async function login(suffix) {
  const main = pages['main-panel.html']
  await main.input(S.loginApiBaseUrl, baseUrl())
  await main.input(S.loginUsername, `accept-${suffix}`)
  await main.input(S.loginPassword, password)
  await clickEnabled(main, S.loginSubmit)
  await main.waitForSelector(S.mainDashboard, { timeoutMs: 15_000 })
}
async function waitForEnabled(page, selector, description) {
  await waitFor(() => page.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    return Boolean(button && !button.disabled);
  })()`), { description })
}
async function clickEnabled(page, selector) {
  // Raw CDP dispatches pointer input even to disabled buttons. Match a real
  // available user action; perform exactly one click and verify its outcome.
  await waitForEnabled(page, selector, `enabled action ${selector}`)
  return page.click(selector)
}
async function record(name, run) {
  console.log(`[real-backend] ${name} started`)
  try {
    const result = await run()
    report.checks.push({ name, status: 'passed', ...result })
    console.log(`[real-backend] ${name} passed`)
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: serializeError(error) })
    throw error
  }
}

async function selectActualPet(petType) {
  await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
  await clickEnabled(pages['main-panel.html'], `[data-e2e="pet-option-${petType}"]`)
  await waitFor(() => pages['pet.html'].evaluate(`window.desktopBridge.getPetState().then(s => s.petType === ${JSON.stringify(petType)} && s.userId === ${identities.a})`),
    { description: `${petType} desktop state` })
  await pages['main-panel.html'].waitForSelector(`[data-e2e="pet-relationship-summary"].relationship-summary-${petType}`)
}

async function assertOnboardingCompleted(petType) {
  return waitFor(async () => {
    const config = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'))
    const state = Object.values(config.petOnboardingStates || {}).find((item) => (
      item.user_id === identities.a && item.pet_type === petType && item.status === 'finished' && item.finish_reason === 'completed'
    ))
    return state ? { petType, relationshipId: state.relationship_id, finishReason: state.finish_reason } : null
  }, { description: `${petType} persisted onboarding completion` })
}

async function readOnboardingFacts() {
  const config = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'))
  return Object.values(config.petOnboardingStates || {}).map((state) => ({
    user_id: state.user_id, pet_type: state.pet_type, relationship_id: state.relationship_id,
    status: state.status, finish_reason: state.finish_reason,
    observed_capability_ids: state.observed_capability_ids,
  }))
}

async function patReadyPet(petType, token) {
  await pages['main-panel.html'].evaluate('window.desktopBridge.hideMainPanel()')
  await pages['pet.html'].bringToFront()
  await waitFor(async () => (await readOnboardingFacts()).some((state) => (
    state.user_id === identities.a && state.pet_type === petType && state.status === 'active'
  )), { description: `${petType} initial onboarding state created` })
  await waitFor(() => pages['pet.html'].evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(S.petCarePat)});
    return Boolean(button && !button.disabled);
  })()`), { description: `${petType} pat toolbar enabled after entry animation` })
  const before = await api(`/pets/${petType}/daily-summary`, token)
  await clickEnabled(pages['pet.html'], S.petCarePat)
  await waitFor(async () => (await api(`/pets/${petType}/daily-summary`, token)).care_count > before.care_count,
    { description: `${petType} actual pat reward persisted` })
  await waitFor(async () => (await readOnboardingFacts()).some((state) => (
    state.user_id === identities.a && state.pet_type === petType
    && state.observed_capability_ids?.includes('pet_interaction')
  )), { description: `${petType} actual pat onboarding observation persisted` })
}

async function equipInitialScarf(petType, token) {
  const main = pages['main-panel.html']
  await waitForEnabled(main, `[data-item-id="${petType}_basic_scarf"]`, `${petType} outfit control enabled`)
  const before = await api(`/pets/${petType}/relationship`, token)
  await clickEnabled(main, `[data-item-id="${petType}_basic_scarf"]`)
  // Outfit persistence and its XP reward are separate API requests. Wait for
  // the whole visible operation before taking another pet's isolation baseline.
  await waitFor(() => main.evaluate(`(() => {
    const panel = document.querySelector('.outfit-panel[data-pet-type="${petType}"]');
    return Boolean(panel?.querySelector('[data-item-id="${petType}_basic_scarf"][aria-pressed="true"]')
      && panel.querySelector('.outfit-clear-button')?.disabled === false);
  })()`), { description: `${petType} outfit save and reward operation finished` })
  return waitFor(async () => {
    const relationship = await api(`/pets/${petType}/relationship`, token)
    return relationship.outfit.equipped_outfits.neck === `${petType}_basic_scarf`
      && relationship.intimacy_xp >= before.intimacy_xp + 3 ? relationship : null
  }, { description: `${petType} initial scarf and dress-up XP persisted` })
}

async function waitForNaturalReminder(petType, reminderId, token) {
  await pages['main-panel.html'].evaluate('window.desktopBridge.hideMainPanel()')
  const result = await waitFor(async () => {
    const state = await pages['pet.html'].evaluate('window.desktopBridge.getPetState()')
    if (state.petType !== petType || state.userId !== identities.a) {
      return { interruptedContext: { petType: state.petType, userId: state.userId } }
    }
    return (await api(`/reminders?pet_type=${petType}`, token))
      .find((row) => row.id === reminderId && row.triggered_at)
  }, { description: `${petType} natural reminder delivery`, timeoutMs: 100_000, intervalMs: 1000 })
  assert(!result.interruptedContext, 'Desktop account or pet changed unexpectedly while waiting for its reminder', {
    expected: { petType, userId: identities.a }, actual: result.interruptedContext,
  })
  await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
  return result
}

async function collectContextEvents() {
  const directory = join(runtime, 'AppData/Detachym/logs')
  const events = []
  for (const file of await readdir(directory).catch(() => [])) {
    if (!file.startsWith('desktop-main-') || !file.endsWith('.log')) continue
    for (const line of (await readFile(join(directory, file), 'utf8')).split('\n').filter(Boolean)) {
      let record
      try { record = JSON.parse(line) } catch { continue }
      const event = record.payload?.event || record.event
      if (!/switch-pet|main-panel-switch|voice-global-shortcut-triggered/.test(event || '')) continue
      const payload = record.payload || record
      // Keep only context metadata, never session capabilities or credentials.
      events.push({ at: record.ts, event, role: record.role, petType: payload.petType,
        fromPetType: payload.fromPetType, toPetType: payload.toPetType,
        targetPetType: payload.targetPetType, phase: payload.phase })
    }
  }
  return events
}

try {
  await mkdir(artifacts, { recursive: true })
  await mkdir(join(runtime, 'AppData'), { recursive: true })
  await access(join(root, 'frontend/dist/index.html'))
  await startBackend()
  await record('empty isolated database and real SMTP code issuance', async () => {
    assert((await inspectDatabase()).users.length === 0, 'Acceptance must begin without seeded users')
    await api('/auth/send-verification-code', null, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'accept-expired@example.com' }),
    })
    expiringMessage = await receivedCode('accept-expired@example.com')
    return { accountsSeeded: false, smtpStartTls: true, smtpAuthenticated: true, expiryClock: 'natural five-minute server TTL' }
  })
  await launchRegistrationBrowser()
  await record('Web registration A with received code, wrong-code rejection and auto-login', () => registerViaWeb('a'))
  await record('Web registration B independently with received code', () => registerViaWeb('b'))
  await record('real password-reset verification code cannot be reused', async () => {
    await api('/auth/forgot-password', null, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'accept-a@example.com' }) })
    const message = await receivedCode('accept-a@example.com', '重置密码验证码')
    const payload = { email: 'accept-a@example.com', verification_code: message.code, new_password: password }
    await api('/auth/reset-password', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const replay = await fetch(`${baseUrl()}/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    assert(replay.status === 400 && (await replay.json()).detail === 'Invalid verification code', 'Consumed reset code was reusable')
    return { smtpCodeConsumedOnce: true, replayStatus: replay.status }
  })
  if (!registrationOnly) {
  await launchDesktop()
  let tokenA
  let reminder
  await record('login, default pig and real relationship', async () => {
    await login('a')
    await waitFor(() => pages['pet.html'].evaluate(`window.desktopBridge.getPetState().then(s=>s.petType === "pig" && s.userId === ${identities.a})`),
      { description: 'pig account state' })
    tokenA = await tokenFor('a')
    const preferences = await api('/users/me/preferences', tokenA)
    assert(preferences.pet_type === 'pig', 'New account preferences must default to pig')
    const relationship = await api('/pets/pig/relationship', tokenA)
    assert(relationship.user_id === identities.a && relationship.pet_type === 'pig', 'Wrong relationship owner')
    await pages['main-panel.html'].waitForSelector(S.relationshipSummary)
    return { relationshipId: relationship.id }
  })
  await record('care interaction and one-minute reminder creation', async () => {
    await patReadyPet('pig', tokenA)
    await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
    await clickEnabled(pages['main-panel.html'], S.onboardingReminderCreate)
    reminder = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))[0],
      { description: 'persisted real reminder' })
    assert(Math.abs(Date.parse(reminder.remind_at) - Date.now() - 60_000) < 15_000, 'Reminder must be one minute ahead')
    assert((await api('/reminders?pet_type=pig', tokenA)).length === 1, 'Duplicate creation')
    return { reminderId: reminder.id, remindAt: reminder.remind_at }
  })
  await record('natural reminder delivery and explicit completion', async () => {
    // No clock changes, DB edits, forced polls, or E2E controls.
    reminder = await waitForNaturalReminder('pig', reminder.id, tokenA)
    assert(reminder.status === 'pending', 'Delivery must not auto-complete')
    const deliveryLagMs = Date.parse(reminder.triggered_at) - Date.parse(reminder.remind_at)
    assert(deliveryLagMs >= 0 && deliveryLagMs <= 5000, `Known reminder deadline exceeded five seconds: ${deliveryLagMs} ms`)
    await clickEnabled(pages['main-panel.html'], S.pendingReminderRefresh)
    await waitForEnabled(pages['main-panel.html'], S.pendingReminderRefresh, 'pending reminder refresh finished before completion')
    await clickEnabled(pages['main-panel.html'], S.pendingReminderComplete.replace('{id}', reminder.id))
    const completed = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.id === reminder.id && row.status === 'completed'), { description: 'explicit completion persisted' })
    await pages['main-panel.html'].screenshot(join(artifacts, 'completed-reminder.png'))
    return { triggeredAt: completed.triggered_at, completedAt: completed.completed_at, deliveryLagMs }
  })
  await record('pig unlocked outfit and persisted onboarding', async () => {
    const completion = await assertOnboardingCompleted('pig')
    await equipInitialScarf('pig', tokenA)
    return completion
  })
  const petEvidence = {}
  for (const petType of ['cat', 'dog']) {
    await record(`${petType}: real care, independent XP, outfit and natural onboarding reminder`, async () => {
      const otherPets = ['pig', 'cat', 'dog'].filter((item) => item !== petType)
      const beforeOthers = Object.fromEntries(await Promise.all(otherPets.map(async (item) => [item, await api(`/pets/${item}/relationship`, tokenA)])))
      await selectActualPet(petType)
      const main = pages['main-panel.html']
      for (const section of ['pet-daily-summary', 'pet-weekly-summary', 'focus-panel']) {
        await main.waitForSelector(`[data-e2e="${section}"][data-pet-type="${petType}"]`)
      }
      await patReadyPet(petType, tokenA)
      await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
      await clickEnabled(main, S.onboardingReminderCreate)
      const sample = await waitFor(async () => (await api(`/reminders?pet_type=${petType}`, tokenA))[0],
        { description: `${petType} real onboarding reminder` })
      assert(sample.pet_type === petType && sample.user_id === identities.a, 'Sample reminder crossed account/pet ownership')
      assert(Math.abs(Date.parse(sample.remind_at) - Date.now() - 60_000) < 15_000, 'Sample reminder was not scheduled one minute ahead')
      await equipInitialScarf(petType, tokenA)
      await clickEnabled(main, '[data-e2e="focus-start"]')
      await main.waitForSelector('[data-e2e="focus-panel"][data-focus-status="running"]')
      await clickEnabled(main, '[data-e2e="focus-end"]')
      await main.waitForSelector('[data-e2e="focus-panel"][data-focus-status="idle"]')
      const delivered = await waitForNaturalReminder(petType, sample.id, tokenA)
      const lag = Date.parse(delivered.triggered_at) - Date.parse(delivered.remind_at)
      assert(lag >= 0 && lag <= 5000 && delivered.status === 'pending', 'Natural delivery failed its deadline or auto-completed')
      await clickEnabled(main, S.pendingReminderRefresh)
      await waitForEnabled(main, S.pendingReminderRefresh, `${petType} pending reminder refresh finished before completion`)
      await clickEnabled(main, S.pendingReminderComplete.replace('{id}', sample.id))
      await waitFor(async () => (await api(`/reminders?pet_type=${petType}`, tokenA)).some((item) => item.id === sample.id && item.status === 'completed'),
        { description: `${petType} explicit completion persisted` })
      const completion = await assertOnboardingCompleted(petType)
      const relationship = await api(`/pets/${petType}/relationship`, tokenA)
      assert(relationship.intimacy_xp > 0 && relationship.user_id === identities.a, 'Care did not grow the correct relationship')
      assert(completion.relationshipId === relationship.id, 'Onboarding persisted against a different relationship')
      const weekly = await api(`/pets/${petType}/weekly-summary`, tokenA)
      assert(weekly.pet_type === petType, 'Weekly summary returned the wrong pet')
      for (const other of otherPets) {
        const after = await api(`/pets/${other}/relationship`, tokenA)
        assert(after.intimacy_xp === beforeOthers[other].intimacy_xp, 'Another pet received this pet\'s XP',
          { activePet: petType, otherPet: other, beforeXp: beforeOthers[other].intimacy_xp, afterXp: after.intimacy_xp })
        assert(JSON.stringify(after.outfit.equipped_outfits) === JSON.stringify(beforeOthers[other].outfit.equipped_outfits), 'Another pet received this pet\'s outfit')
      }
      await main.screenshot(join(artifacts, `${petType}-real-companion.png`))
      petEvidence[petType] = { ...completion, xp: relationship.intimacy_xp, reminderId: sample.id, deliveryLagMs: lag }
      return petEvidence[petType]
    })
  }
  await record('switching among three pets restores independent completed state', async () => {
    for (const petType of ['cat', 'dog', 'pig']) {
      await selectActualPet(petType)
      await assertOnboardingCompleted(petType)
      const relationship = await api(`/pets/${petType}/relationship`, tokenA)
      assert(relationship.outfit.equipped_outfits.neck === `${petType}_basic_scarf`, 'Pet switch lost or mixed outfit state')
    }
    return { pets: ['cat', 'dog', 'pig'], statesPreserved: true }
  })
  await record('restart restores account and preserves completed reminder', async () => {
    await stopDesktop()
    await launchDesktop()
    await pages['main-panel.html'].waitForSelector(S.mainDashboard)
    assert(await pages['main-panel.html'].evaluate(`window.desktopBridge.getPetState().then(s=>s.petType === "pig" && s.userId === ${identities.a})`), 'Account not restored')
    const rows = await api('/reminders?pet_type=pig', tokenA)
    assert(rows.length === 1 && rows[0].status === 'completed', 'Reminder duplicated or reopened')
  })
  await record('backend outage and reconnection preserve data', async () => {
    await stopProcess(backend)
    let unavailable = false
    try { await api('/reminders?pet_type=pig', tokenA) } catch { unavailable = true }
    assert(unavailable, 'Backend must actually be unavailable during this check')
    await clickEnabled(pages['main-panel.html'], S.pendingReminderRefresh)
    await startBackend()
    await pages['main-panel.html'].reload()
    await pages['main-panel.html'].waitForSelector(S.mainDashboard)
    await clickEnabled(pages['main-panel.html'], S.pendingReminderRefresh)
    const rows = await api('/reminders?pet_type=pig', tokenA)
    assert(rows.length === 1 && rows[0].status === 'completed', 'Outage lost completed state')
  })
  await record('quick chat creates recurring reminder with Chinese minutes', async () => {
    await pages['pet.html'].evaluate('window.desktopBridge.openQuickChat()')
    const quick = pages['quick-chat.html']
    const deviceTimeZone = await quick.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')
    await quick.input(S.quickChatInput, '每天上午九点十五分提醒我喝水')
    await clickEnabled(quick, S.quickChatSend)
    const recurring = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.series_id), { description: 'real recurring reminder from quick chat' })
    assert(recurring.title === '喝水' && recurring.recurrence_type === 'daily', 'Incorrect recurring reminder')
    const series = (await api('/reminder-series?pet_type=pig', tokenA)).find((item) => item.id === recurring.series_id)
    assert(series?.timezone === deviceTimeZone, `Recurring reminder did not retain the desktop timezone: ${series?.timezone} / ${deviceTimeZone}`)
    const localTime = new Date(recurring.remind_at).toLocaleTimeString('en-GB', { timeZone: deviceTimeZone })
    assert(localTime === '09:15:00', `Chinese minutes lost: ${localTime}`)
    await waitForEnabled(quick, S.quickChatSend, 'quick chat reminder operation finished')
    await quick.screenshot(join(artifacts, 'recurring-reminder.png'))
    await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
    return { reminderId: recurring.id, seriesId: recurring.series_id, localTime, deviceTimeZone }
  })
  await record('relative reminder correction and real persistence', async () => {
    const main = pages['main-panel.html']
    await clickEnabled(main, '[data-e2e="new-chat"]')
    await main.input('[data-e2e="main-chat-input"]', '每周九点提醒我伸个懒腰')
    await clickEnabled(main, '[data-e2e="main-chat-send"]')
    await main.waitForSelector('[data-e2e="main-reminder-draft-error"]')
    assert(await main.evaluate("document.querySelector('[data-e2e=main-chat-input]').value === '每周九点提醒我伸个懒腰'"), 'Invalid reminder draft was lost')
    const beforeRows = await api('/reminders?pet_type=pig', tokenA)
    const draft = '十七分钟后提醒我伸个懒腰'
    await main.input('[data-e2e="main-chat-input"]', draft)
    const beforeTime = Date.now()
    await clickEnabled(main, '[data-e2e="main-chat-send"]')
    const relative = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA)).find((row) => row.source_text === draft), { description: 'real relative reminder' })
    const delayMs = Date.parse(relative.remind_at) - beforeTime
    assert(relative.title === '伸个懒腰' && relative.recurrence_type === 'once', 'Relative reminder title or recurrence changed')
    assert(delayMs >= 17 * 60_000 && delayMs <= 17 * 60_000 + 5000, 'Relative deadline changed before real persistence')
    assert((await api('/reminders?pet_type=pig', tokenA)).length === beforeRows.length + 1, 'Relative reminder created duplicates')
    await waitFor(() => main.evaluate(`(() => {
      const button = document.querySelector('[data-e2e="main-chat-send"]');
      return ['发送消息', 'Send Message'].includes(button?.textContent.trim())
        && document.querySelector('[data-e2e="main-chat-input"]')?.value === '';
    })()`), { description: 'main reminder operation finished' })
    return { reminderId: relative.id, delayMs, retainedDraft: true }
  })
  await record('upcoming reminder reschedule and cancellation persist', async () => {
    const main = pages['main-panel.html']
    const relative = (await api('/reminders?pet_type=pig', tokenA)).find((row) => row.source_text === '十七分钟后提醒我伸个懒腰')
    assert(relative, 'Relative reminder missing before management')
    const id = relative.id
    await clickEnabled(main, `[data-e2e-reminder-edit="${id}"]`)
    const target = await main.evaluate(`(() => {
      const date = new Date(Date.now() + 2 * 60 * 60_000);
      const pad = value => String(value).padStart(2, '0');
      const value = date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      const input = document.querySelector('[data-e2e-reminder-time="${id}"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return new Date(value).toISOString();
    })()`)
    await clickEnabled(main, `[data-e2e-reminder-save-edit="${id}"]`)
    const moved = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.id === id && Date.parse(row.remind_at) === Date.parse(target)), { description: 'real reschedule persisted' })
    assert(moved.title === relative.title && moved.status === 'pending' && !moved.triggered_at, 'Reschedule changed reminder identity or delivery state')
    const lateTrigger = await fetch(`${baseUrl()}/reminders/${id}/trigger`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` } })
    assert(lateTrigger.status === 409, 'Late trigger must not consume a future reminder')
    await waitFor(() => main.evaluate(`(() => {
      const row = document.querySelector('[data-e2e-upcoming-reminder-id="${id}"]');
      return row?.getAttribute('aria-busy') === 'false'
        && row.querySelector('time')?.dateTime === ${JSON.stringify(moved.remind_at)}
        && !row.querySelector('[data-e2e-reminder-time="${id}"]');
    })()`), { description: 'reschedule result committed to the actual UI' })
    await waitForEnabled(main, `[data-e2e-reminder-cancel="${id}"]`, 'cancel enabled after reschedule completes')
    await main.screenshot(join(artifacts, 'upcoming-reminder-rescheduled.png'))
    await clickEnabled(main, `[data-e2e-reminder-cancel="${id}"]`)
    const canceled = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.id === id && row.status === 'canceled'), { description: 'real reminder cancellation persisted' })
    assert(canceled.cancellation_source === 'user', 'Cancellation source not persisted')
    await main.reload()
    await main.waitForSelector('[data-e2e="upcoming-reminders"]')
    await waitForEnabled(main, '[data-e2e="upcoming-reminder-refresh"]', 'reloaded upcoming reminders finished loading')
    assert(!await main.evaluate(`Boolean(document.querySelector('[data-e2e="upcoming-reminder-error"]'))`), 'Reloaded upcoming reminders failed to load')
    assert(await main.evaluate(`!document.querySelector('[data-e2e-upcoming-reminder-id="${id}"]')`), 'Canceled reminder returned after reload')
    return { reminderId: id, rescheduledTo: moved.remind_at, canceled: true, lateTriggerRejected: true }
  })
  await record('account B isolation and logout persistence', async () => {
    await clickEnabled(pages['main-panel.html'], S.logout)
    await login('b')
    await clickEnabled(pages['main-panel.html'], S.petOptionPig)
    await waitFor(() => pages['pet.html'].evaluate(`window.desktopBridge.getPetState().then(s=>s.userId === ${identities.b})`), { description: 'B account propagated' })
    await pages['main-panel.html'].waitForSelector(S.relationshipSummary)
    const tokenB = await tokenFor('b')
    for (const petType of ['pig', 'cat', 'dog']) {
      assert((await api(`/reminders?pet_type=${petType}`, tokenB)).length === 0, 'A reminders leaked into B')
      const relationship = await api(`/pets/${petType}/relationship`, tokenB)
      assert(relationship.user_id === identities.b && Object.keys(relationship.outfit.equipped_outfits).length === 0,
        'Account B inherited account A relationship or outfit')
    }
    const forbidden = await fetch(`${baseUrl()}/reminders/${reminder.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}` } })
    assert(forbidden.status === 404, 'Cross-account completion must be refused')
    await clickEnabled(pages['main-panel.html'], S.logout)
    await stopDesktop()
    await launchDesktop()
    await pages['main-panel.html'].waitForSelector(S.loginSubmit)
  })
  }
  await record('naturally expired registration code is rejected without creating an account', async () => {
    const expiresAt = Date.parse(expiringMessage.receivedAt) + 5 * 60_000 + 1000
    if (Date.now() < expiresAt) console.log(`[real-backend] waiting ${Math.ceil((expiresAt - Date.now()) / 1000)} seconds for the real code TTL`)
    await waitFor(() => Date.now() >= expiresAt, { description: 'natural verification-code expiry', timeoutMs: 310_000, intervalMs: 1000 })
    await registrationPage.evaluate('localStorage.clear()')
    await navigateRegistration()
    await fillRegistration('expired', expiringMessage.code)
    await clickEnabled(registrationPage, 'form button[type="submit"]')
    await registrationPage.waitForSelector('[role="alert"]')
    assert(await registrationPage.evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('验证码')`), 'Expired code did not produce verification feedback')
    const rejected = await fetch(`${baseUrl()}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'accept-expired', email: 'accept-expired@example.com', password, verification_code: expiringMessage.code }) })
    assert(rejected.status === 400 && (await rejected.json()).detail === 'Verification code expired', 'Expired code was not refused by the real API')
    const audit = await inspectDatabase()
    assert(audit.users.length === 2 && !audit.users.some((user) => user.email === 'accept-expired@example.com'), 'Expired code created an account')
    return { realElapsedMs: Date.now() - Date.parse(expiringMessage.receivedAt), databaseClockModified: false, databaseRowsInjected: false, apiStatus: rejected.status }
  })
  const smtpMessages = JSON.parse(await readFile(join(runtime, 'smtp-messages.json'), 'utf8'))
  report.smtpReceipts = smtpMessages.map(({ html, ...metadata }) => metadata)
  for (const client of [registrationPage, ...Object.values(pages)]) {
    collectApiOrigins(client)
  }
  assert([...apiOrigins].every((origin) => origin === `http://127.0.0.1:${backendPort}`), 'Acceptance attempted a non-local API origin')
  report.apiOrigins = [...apiOrigins]
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = serializeError(error)
  report.careRewardRequests = collectCareRewardRequests()
  if (registrationPage) {
    try {
      report.registrationFailure = await registrationPage.evaluate(`({ url: location.href, alert: document.querySelector('[role="alert"]')?.textContent, status: document.querySelector('[role="status"]')?.textContent, email: document.querySelector('input[autocomplete="email"]')?.value, username: document.querySelector('input[autocomplete="username"]')?.value, buttons: [...document.querySelectorAll('form button')].map(b => ({ text: b.textContent, disabled: b.disabled })) })`)
      report.registrationNetwork = registrationPage.diagnostics.network.map((entry) => ({ method: entry.method, url: entry.request?.url || entry.response?.url, status: entry.response?.status }))
      await registrationPage.evaluate(`document.querySelectorAll('input[autocomplete="one-time-code"],input[type="password"]').forEach(input => { input.value = '' })`)
      await registrationPage.screenshot(join(artifacts, 'registration-failure.png'))
    } catch {}
  }
  for (const [name, client] of Object.entries(pages)) {
    try { await client.screenshot(join(artifacts, `failure-${name}.png`)) } catch {}
    await writeFile(join(artifacts, `${name}.diagnostics.json`), JSON.stringify(safeDiagnostics(client), null, 2))
  }
} finally {
  const cleanupErrors = []
  report.contextEvents = await collectContextEvents().catch(() => [])
  report.onboardingStates = await readOnboardingFacts().catch(() => [])
  for (const cleanup of [stopRegistrationBrowser, stopDesktop, () => stopProcess(backend),
    () => removeSafeUserDataPath(userData), () => removeSafeUserDataPath(runtime)]) {
    try { await cleanup() } catch (error) { cleanupErrors.push(serializeError(error)) }
  }
  report.cleanedUp = cleanupErrors.length === 0
  if (cleanupErrors.length) { report.status = 'failed'; report.cleanupErrors = cleanupErrors }
  await writeFile(join(artifacts, 'backend.log'), backendLogs)
  await writeFile(join(artifacts, 'electron.log'), electronLogs)
  report.version = expectedVersion
  await writeFile(join(artifacts, 'real-backend.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
process.exitCode = report.status === 'passed' ? 0 : 1
