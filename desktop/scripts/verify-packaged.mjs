// Smoke the packaged executable with disposable local accounts and userData.
// This is not an NSIS installation or live-service acceptance test.
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assert, waitFor } from './e2e/assertions.mjs'
import { CdpClient, fetchPageTargets, mapRendererTargets, waitForDevToolsActivePort } from './e2e/cdp-client.mjs'
import { removeSafeUserDataPath } from './e2e/run.mjs'
import { startStubServer } from './e2e/stub-server.mjs'
import { USERS } from './e2e/fixtures.mjs'
import { REQUIRED_SELECTORS as SELECTORS } from './e2e/p1k-scenarios.mjs'

const desktopRoot = resolve(fileURLToPath(import.meta.url), '../..')
const executable = join(desktopRoot, 'dist/releases/win-unpacked/Detachym.exe')
const artifacts = join(desktopRoot, 'artifacts/e2e', `packaged-${Date.now()}`)
const userData = await mkdtemp(join(tmpdir(), 'detachym-e2e-packaged-'))
const report = { status: 'running', executable, backend: 'local-stub', launches: [], userDataRemoved: false }
const execFileAsync = promisify(execFile)
let child
let clients = []
let stub
let ownedLogPath

async function stop() {
  for (const client of clients) client.close()
  clients = []
  if (child && child.exitCode === null && child.signalCode === null) {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { description: 'packaged process exit' })
  }
  if (ownedLogPath && basename(ownedLogPath).endsWith(`-${child.pid}.log`)) {
    await copyFile(ownedLogPath, join(artifacts, basename(ownedLogPath)))
    // Only the exact log returned by this owned process, after it exits.
    await rm(ownedLogPath)
    ownedLogPath = null
  }
}

async function launch() {
  const env = { ...process.env, DETACHYM_E2E: '1', DETACHYM_API_BASE_URL: stub.apiBaseUrl }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  child = spawn(executable, [
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userData}`,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.on('data', (data) => stderr.push(String(data)))
  child.stdout.resume()
  child.on('error', (error) => stderr.push(error.message))
  const { port } = await waitForDevToolsActivePort(userData)
  const targets = await waitFor(async () => {
    const mapped = mapRendererTargets(await fetchPageTargets(port))
    return mapped.size === 3 ? mapped : null
  }, { description: 'packaged three renderer targets', timeoutMs: 20_000 })
  const pages = {}
  for (const [entry, target] of targets) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl)
    clients.push(client)
    await client.enable()
    await client.waitForReady()
    const shape = await client.evaluate('({bridge:!!window.desktopBridge,e2e:!!window.desktopBridge?.e2e})')
    assert(shape.bridge && !shape.e2e, `${entry}: production bridge must exclude E2E controls`, shape)
    assert(target.url.includes('app.asar'), 'Expected the packaged renderer, not development sources')
    pages[entry] = client
  }
  const pet = pages['pet.html']
  await pet.evaluate('window.desktopBridge.openMainPanel()')
  ownedLogPath = (await pet.evaluate('window.desktopBridge.getLogPaths()')).logPath
  const version = await pet.evaluate('window.desktopBridge.getAppVersion()')
  assert(version === '1.1.0-rc.1', 'Unexpected packaged version', version)
  report.launches.push({ version, targets: targets.size, e2eBridgeAbsent: true })
  return pages
}

try {
  await mkdir(artifacts, { recursive: true })
  stub = await startStubServer()
  let pages = await launch()
  let main = pages['main-panel.html']
  await main.input(SELECTORS.loginApiBaseUrl, stub.apiBaseUrl)
  await main.input(SELECTORS.loginUsername, USERS.A.username)
  await main.input(SELECTORS.loginPassword, USERS.A.password)
  await main.click(SELECTORS.loginSubmit)
  await main.waitForSelector(SELECTORS.mainDashboard)
  await main.click(SELECTORS.petOptionPig)
  await waitFor(() => main.evaluate('window.desktopBridge.getPetState().then(s=>s.petType === "pig" && s.userId === 101)'), { description: 'packaged pig selection' })
  await pages['pet.html'].evaluate('window.desktopBridge.openQuickChat()')
  await pages['quick-chat.html'].waitForSelector(SELECTORS.quickChatInput)
  await pages['quick-chat.html'].input(SELECTORS.quickChatInput, '你好，小猪')
  await pages['quick-chat.html'].click(SELECTORS.quickChatSend)
  await pages['quick-chat.html'].waitForSelector(SELECTORS.quickChatAssistantMessage)
  assert(stub.requests.some((request) => request.pathname === '/api/v1/chat/message'),
    'Packaged quick chat must reach the local backend; an error bubble is not success')
  await main.screenshot(join(artifacts, 'first-login.png'))
  report.loginAndQuickChat = true
  await stop()
  // DevToolsActivePort from the previous launch is no longer authoritative.
  await rm(join(userData, 'DevToolsActivePort'), { force: true })
  pages = await launch()
  main = pages['main-panel.html']
  await main.waitForSelector(SELECTORS.mainDashboard)
  const persisted = await main.evaluate('window.desktopBridge.getPetState().then(s=>({petType:s.petType,userId:s.userId}))')
  assert(persisted.petType === 'pig' && persisted.userId === USERS.A.id, 'Account and pet should survive restart', persisted)
  report.restartRestoresAccountAndPet = true
  await main.click(SELECTORS.logout)
  await main.waitForSelector(SELECTORS.loginSubmit)
  await stop()
  await rm(join(userData, 'DevToolsActivePort'), { force: true })
  pages = await launch()
  await pages['main-panel.html'].waitForSelector(SELECTORS.loginSubmit)
  report.logoutSurvivesRestart = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = { message: error.message, stack: error.stack }
} finally {
  try {
    await stop()
    await stub?.close()
    await removeSafeUserDataPath(userData)
    report.userDataRemoved = true
  } catch (error) {
    report.status = 'failed'
    report.cleanupError = error.message
  }
  await writeFile(join(artifacts, 'packaged-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, artifacts }, null, 2))
}
process.exitCode = report.status === 'passed' ? 0 : 1
