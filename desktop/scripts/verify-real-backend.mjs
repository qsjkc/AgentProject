// Real Electron UI -> real FastAPI -> disposable SQLite. No production writes.
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
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
const timeZoneOverride = process.argv.find((value) => value.startsWith('--timezone='))?.slice('--timezone='.length)
if (timeZoneOverride) new Intl.DateTimeFormat('en', { timeZone: timeZoneOverride })
const expectedVersion = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version
const runtime = await mkdtemp(join(tmpdir(), 'detachym-e2e-real-'))
const userData = await mkdtemp(join(tmpdir(), 'detachym-e2e-user-'))
const artifacts = join(desktop, 'artifacts/e2e', `real-backend-${Date.now()}`)
const password = `Acceptance-${randomBytes(12).toString('hex')}`
const secret = randomBytes(32).toString('hex')
const execAsync = promisify(execFile)
const report = { status: 'running', backend: 'real-local-fastapi-sqlite', packaged, checks: [], artifacts }
let backend
let electron
let backendPort
let pages = {}
let backendLogs = ''
let electronLogs = ''
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
      DETACHYM_ACCEPTANCE_RUNTIME: runtime, DETACHYM_ACCEPTANCE_PASSWORD: password,
      DETACHYM_ACCEPTANCE_SECRET: secret, DETACHYM_ACCEPTANCE_PORT: String(backendPort || 0) },
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
async function api(path, token, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    signal: AbortSignal.timeout(5000),
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
  for (const client of Object.values(pages)) client.close()
  pages = {}
  await stopProcess(electron)
}
async function login(suffix) {
  const main = pages['main-panel.html']
  await main.input(S.loginApiBaseUrl, baseUrl())
  await main.input(S.loginUsername, `accept-${suffix}`)
  await main.input(S.loginPassword, password)
  await main.click(S.loginSubmit)
  await main.waitForSelector(S.mainDashboard, { timeoutMs: 15_000 })
}
async function record(name, run) {
  console.log(`[real-backend] ${name} started`)
  const result = await run()
  report.checks.push({ name, status: 'passed', ...result })
  console.log(`[real-backend] ${name} passed`)
}

try {
  await mkdir(artifacts, { recursive: true })
  await mkdir(join(runtime, 'AppData'), { recursive: true })
  await startBackend()
  await launchDesktop()
  let tokenA
  let reminder
  await record('login, default pig and real relationship', async () => {
    await login('a')
    await waitFor(() => pages['pet.html'].evaluate('window.desktopBridge.getPetState().then(s=>s.petType === "pig" && s.userId === 101)'),
      { description: 'pig account state' })
    tokenA = await tokenFor('a')
    const preferences = await api('/users/me/preferences', tokenA)
    assert(preferences.pet_type === 'pig', 'New account preferences must default to pig')
    const relationship = await api('/pets/pig/relationship', tokenA)
    assert(relationship.user_id === 101 && relationship.pet_type === 'pig', 'Wrong relationship owner')
    await pages['main-panel.html'].waitForSelector(S.relationshipSummary)
    return { relationshipId: relationship.id }
  })
  await record('care interaction and one-minute reminder creation', async () => {
    await pages['pet.html'].bringToFront()
    await pages['pet.html'].click(S.petCarePat)
    await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
    await pages['main-panel.html'].click(S.onboardingReminderCreate)
    reminder = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))[0],
      { description: 'persisted real reminder' })
    assert(Math.abs(Date.parse(reminder.remind_at) - Date.now() - 60_000) < 15_000, 'Reminder must be one minute ahead')
    assert((await api('/reminders?pet_type=pig', tokenA)).length === 1, 'Duplicate creation')
    return { reminderId: reminder.id, remindAt: reminder.remind_at }
  })
  await record('natural reminder delivery and explicit completion', async () => {
    // No clock changes, DB edits, forced polls, or E2E controls.
    reminder = await waitFor(async () => {
      const rows = await api('/reminders?pet_type=pig', tokenA)
      return rows.find((row) => row.id === reminder.id && row.triggered_at)
    }, { description: 'natural reminder delivery', timeoutMs: 100_000, intervalMs: 1000 })
    assert(reminder.status === 'pending', 'Delivery must not auto-complete')
    const deliveryLagMs = Date.parse(reminder.triggered_at) - Date.parse(reminder.remind_at)
    assert(deliveryLagMs >= 0 && deliveryLagMs <= 5000, `Known reminder deadline exceeded five seconds: ${deliveryLagMs} ms`)
    await pages['main-panel.html'].click(S.pendingReminderRefresh)
    await pages['main-panel.html'].click(S.pendingReminderComplete.replace('{id}', reminder.id))
    const completed = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.id === reminder.id && row.status === 'completed'), { description: 'explicit completion persisted' })
    await pages['main-panel.html'].screenshot(join(artifacts, 'completed-reminder.png'))
    return { triggeredAt: completed.triggered_at, completedAt: completed.completed_at, deliveryLagMs }
  })
  await record('restart restores account and preserves completed reminder', async () => {
    await stopDesktop()
    await launchDesktop()
    await pages['main-panel.html'].waitForSelector(S.mainDashboard)
    assert(await pages['main-panel.html'].evaluate('window.desktopBridge.getPetState().then(s=>s.petType === "pig" && s.userId === 101)'), 'Account not restored')
    const rows = await api('/reminders?pet_type=pig', tokenA)
    assert(rows.length === 1 && rows[0].status === 'completed', 'Reminder duplicated or reopened')
  })
  await record('backend outage and reconnection preserve data', async () => {
    await stopProcess(backend)
    let unavailable = false
    try { await api('/reminders?pet_type=pig', tokenA) } catch { unavailable = true }
    assert(unavailable, 'Backend must actually be unavailable during this check')
    await pages['main-panel.html'].click(S.pendingReminderRefresh)
    await startBackend()
    await pages['main-panel.html'].reload()
    await pages['main-panel.html'].waitForSelector(S.mainDashboard)
    await pages['main-panel.html'].click(S.pendingReminderRefresh)
    const rows = await api('/reminders?pet_type=pig', tokenA)
    assert(rows.length === 1 && rows[0].status === 'completed', 'Outage lost completed state')
  })
  await record('quick chat creates recurring reminder with Chinese minutes', async () => {
    await pages['pet.html'].evaluate('window.desktopBridge.openQuickChat()')
    const quick = pages['quick-chat.html']
    const deviceTimeZone = await quick.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')
    await quick.input(S.quickChatInput, '每天上午九点十五分提醒我喝水')
    await quick.click(S.quickChatSend)
    const recurring = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.series_id), { description: 'real recurring reminder from quick chat' })
    assert(recurring.title === '喝水' && recurring.recurrence_type === 'daily', 'Incorrect recurring reminder')
    const series = (await api('/reminder-series?pet_type=pig', tokenA)).find((item) => item.id === recurring.series_id)
    assert(series?.timezone === deviceTimeZone, `Recurring reminder did not retain the desktop timezone: ${series?.timezone} / ${deviceTimeZone}`)
    const localTime = new Date(recurring.remind_at).toLocaleTimeString('en-GB', { timeZone: deviceTimeZone })
    assert(localTime === '09:15:00', `Chinese minutes lost: ${localTime}`)
    await quick.screenshot(join(artifacts, 'recurring-reminder.png'))
    await pages['pet.html'].evaluate('window.desktopBridge.openMainPanel()')
    return { reminderId: recurring.id, seriesId: recurring.series_id, localTime, deviceTimeZone }
  })
  await record('relative reminder correction and real persistence', async () => {
    const main = pages['main-panel.html']
    await main.click('[data-e2e="new-chat"]')
    await main.input('[data-e2e="main-chat-input"]', '每周九点提醒我伸个懒腰')
    await main.click('[data-e2e="main-chat-send"]')
    await main.waitForSelector('[data-e2e="main-reminder-draft-error"]')
    assert(await main.evaluate("document.querySelector('[data-e2e=main-chat-input]').value === '每周九点提醒我伸个懒腰'"), 'Invalid reminder draft was lost')
    const beforeRows = await api('/reminders?pet_type=pig', tokenA)
    const draft = '十七分钟后提醒我伸个懒腰'
    await main.input('[data-e2e="main-chat-input"]', draft)
    const beforeTime = Date.now()
    await main.click('[data-e2e="main-chat-send"]')
    const relative = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA)).find((row) => row.source_text === draft), { description: 'real relative reminder' })
    const delayMs = Date.parse(relative.remind_at) - beforeTime
    assert(relative.title === '伸个懒腰' && relative.recurrence_type === 'once', 'Relative reminder title or recurrence changed')
    assert(delayMs >= 17 * 60_000 && delayMs <= 17 * 60_000 + 5000, 'Relative deadline changed before real persistence')
    assert((await api('/reminders?pet_type=pig', tokenA)).length === beforeRows.length + 1, 'Relative reminder created duplicates')
    return { reminderId: relative.id, delayMs, retainedDraft: true }
  })
  await record('upcoming reminder reschedule and cancellation persist', async () => {
    const main = pages['main-panel.html']
    const relative = (await api('/reminders?pet_type=pig', tokenA)).find((row) => row.source_text === '十七分钟后提醒我伸个懒腰')
    assert(relative, 'Relative reminder missing before management')
    const id = relative.id
    await main.click(`[data-e2e-reminder-edit="${id}"]`)
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
    await main.click(`[data-e2e-reminder-save-edit="${id}"]`)
    const moved = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.id === id && Date.parse(row.remind_at) === Date.parse(target)), { description: 'real reschedule persisted' })
    assert(moved.title === relative.title && moved.status === 'pending' && !moved.triggered_at, 'Reschedule changed reminder identity or delivery state')
    const lateTrigger = await fetch(`${baseUrl()}/reminders/${id}/trigger`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` } })
    assert(lateTrigger.status === 409, 'Late trigger must not consume a future reminder')
    await main.screenshot(join(artifacts, 'upcoming-reminder-rescheduled.png'))
    await main.click(`[data-e2e-reminder-cancel="${id}"]`)
    const canceled = await waitFor(async () => (await api('/reminders?pet_type=pig', tokenA))
      .find((row) => row.id === id && row.status === 'canceled'), { description: 'real reminder cancellation persisted' })
    assert(canceled.cancellation_source === 'user', 'Cancellation source not persisted')
    await main.reload()
    await main.waitForSelector('[data-e2e="upcoming-reminders"]')
    assert(await main.evaluate(`!document.querySelector('[data-e2e-upcoming-reminder-id="${id}"]')`), 'Canceled reminder returned after reload')
    return { reminderId: id, rescheduledTo: moved.remind_at, canceled: true, lateTriggerRejected: true }
  })
  await record('account B isolation and logout persistence', async () => {
    await pages['main-panel.html'].click(S.logout)
    await login('b')
    await pages['main-panel.html'].click(S.petOptionPig)
    await waitFor(() => pages['pet.html'].evaluate('window.desktopBridge.getPetState().then(s=>s.userId === 202)'), { description: 'B account propagated' })
    const tokenB = await tokenFor('b')
    assert((await api('/reminders?pet_type=pig', tokenB)).length === 0, 'A reminders leaked into B')
    const forbidden = await fetch(`${baseUrl()}/reminders/${reminder.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}` } })
    assert(forbidden.status === 404, 'Cross-account completion must be refused')
    await pages['main-panel.html'].click(S.logout)
    await stopDesktop()
    await launchDesktop()
    await pages['main-panel.html'].waitForSelector(S.loginSubmit)
  })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = serializeError(error)
  for (const [name, client] of Object.entries(pages)) {
    try { await client.screenshot(join(artifacts, `failure-${name}.png`)) } catch {}
    await writeFile(join(artifacts, `${name}.diagnostics.json`), JSON.stringify(client.diagnostics, null, 2))
  }
} finally {
  try {
    await stopDesktop()
    await stopProcess(backend)
    await removeSafeUserDataPath(userData)
    await removeSafeUserDataPath(runtime)
    report.cleanedUp = true
  } catch (error) { report.status = 'failed'; report.cleanupError = serializeError(error) }
  await writeFile(join(artifacts, 'backend.log'), backendLogs)
  await writeFile(join(artifacts, 'electron.log'), electronLogs)
  report.version = expectedVersion
  await writeFile(join(artifacts, 'real-backend.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
process.exitCode = report.status === 'passed' ? 0 : 1
