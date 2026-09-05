import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  access,
  readdir,
  copyFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { serializeError, waitFor } from './assertions.mjs'
import {
  CdpClient,
  fetchPageTargets,
  mapRendererTargets,
  waitForDevToolsActivePort,
} from './cdp-client.mjs'
import { FULL_SCENARIO_ORDER, REQUIRED_E2E_BRIDGE_API, REQUIRED_SELECTORS, SCENARIOS } from './p1k-scenarios.mjs'
import { startStubServer } from './stub-server.mjs'

const execFileAsync = promisify(execFile)
const E2E_TEMP_PREFIX = 'detachym-e2e-'
const EXPECTED_ENTRIES = ['pet.html', 'quick-chat.html', 'main-panel.html']
const ROLE_BY_ENTRY = Object.freeze({
  'pet.html': 'pet',
  'quick-chat.html': 'quick',
  'main-panel.html': 'main',
})

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(scriptPath, '..', '..', '..')
const electronPath = join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const artifactRoot = join(desktopRoot, 'artifacts', 'e2e')

function runId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}--${process.pid}--${randomBytes(3).toString('hex')}`
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function isWindowsReparsePoint(filePath) {
  if (process.platform !== 'win32') return false
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$targetPath = [Environment]::GetEnvironmentVariable('DETACHYM_E2E_REPARSE_PATH', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'Missing reparse-point target path' }",
    '$item = Get-Item -LiteralPath $targetPath -Force -ErrorAction Stop',
    '[Console]::Out.Write([bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint))',
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    windowsHide: true,
    env: { ...process.env, DETACHYM_E2E_REPARSE_PATH: filePath },
  })
  return stdout.trim().toLowerCase() === 'true'
}

export async function assertSafeUserDataPath(userDataPath, systemTempPath = tmpdir()) {
  if (!userDataPath) throw new Error('Refusing cleanup: userData path is empty')
  const requestedTarget = resolve(userDataPath)
  const requestedStats = await lstat(requestedTarget)
  if (!requestedStats.isDirectory()) throw new Error(`Refusing cleanup of non-directory userData path: ${requestedTarget}`)
  if (requestedStats.isSymbolicLink() || await isWindowsReparsePoint(requestedTarget)) {
    throw new Error(`Refusing cleanup of reparse point: ${requestedTarget}`)
  }
  const [resolvedTemp, resolvedTarget] = await Promise.all([
    realpath(resolve(systemTempPath)),
    realpath(requestedTarget),
  ])
  const pathFromTemp = relative(resolvedTemp, resolvedTarget)
  if (!pathFromTemp || pathFromTemp === '.' || pathFromTemp.startsWith(`..${sep}`) || pathFromTemp === '..' || isAbsolute(pathFromTemp)) {
    throw new Error(`Refusing cleanup outside the system TEMP directory: ${resolvedTarget}`)
  }
  if (!basename(resolvedTarget).startsWith(E2E_TEMP_PREFIX)) {
    throw new Error(`Refusing cleanup without ${E2E_TEMP_PREFIX} basename prefix: ${resolvedTarget}`)
  }
  const stats = await lstat(resolvedTarget)
  if (!stats.isDirectory()) throw new Error(`Refusing cleanup of non-directory userData path: ${resolvedTarget}`)
  if (stats.isSymbolicLink() || await isWindowsReparsePoint(resolvedTarget)) {
    throw new Error(`Refusing cleanup of reparse point: ${resolvedTarget}`)
  }
  return { resolvedTemp, resolvedTarget }
}

export async function removeSafeUserDataPath(userDataPath, systemTempPath = tmpdir()) {
  const { resolvedTarget } = await assertSafeUserDataPath(userDataPath, systemTempPath)
  await rm(resolvedTarget, { recursive: true, force: false, maxRetries: 0 })
}

function parseArgs(argv) {
  const options = { scenario: 'targets', list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--list') options.list = true
    else if (value === '--scenario') options.scenario = argv[++index]
    else if (value.startsWith('--scenario=')) options.scenario = value.slice('--scenario='.length)
    else throw new Error(`Unknown E2E argument: ${value}`)
  }
  return options
}

async function verifyRuntime() {
  const required = [
    electronPath,
    ...EXPECTED_ENTRIES.map((entry) => join(desktopRoot, 'dist', 'renderer', entry)),
  ]
  const missing = []
  for (const filePath of required) {
    if (!await pathExists(filePath)) missing.push(filePath)
  }
  if (missing.length > 0) {
    throw new Error(
      `E2E runtime is incomplete. Run "npm.cmd run build:renderer" in ${desktopRoot} first. Missing: ${missing.join(', ')}`,
    )
  }
}

function startElectron({ userDataPath, stub, stdoutLines, stderrLines }) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  Object.assign(environment, {
    DETACHYM_E2E: '1',
    DETACHYM_E2E_STUB_URL: stub.origin,
    DETACHYM_API_BASE_URL: stub.apiBaseUrl,
    VITE_API_BASE_URL: stub.apiBaseUrl,
  })
  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataPath}`,
    desktopRoot,
  ]
  const child = spawn(electronPath, args, {
    cwd: desktopRoot,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => stdoutLines.push(...String(chunk).split(/\r?\n/).filter(Boolean)))
  child.stderr.on('data', (chunk) => stderrLines.push(...String(chunk).split(/\r?\n/).filter(Boolean)))
  return { child, pid: child.pid, args }
}

async function terminateRecordedProcess(processRecord) {
  const { child, pid } = processRecord || {}
  if (!child || !Number.isInteger(pid) || pid <= 0 || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGTERM')
  }
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    { timeoutMs: 10_000, intervalMs: 50, description: `recorded Electron PID ${pid} to exit` },
  )
}

function createTargetContext(port, stub, artifactPath) {
  const context = {
    port,
    stub,
    artifactPath,
    targets: new Map(),
    pages: {},
    clientsByTargetId: new Map(),
  }
  context.refreshTargets = async ({ requireComplete = true } = {}) => {
    const targetList = await fetchPageTargets(port)
    const nextTargets = mapRendererTargets(targetList)
    if (requireComplete) {
      for (const entry of EXPECTED_ENTRIES) {
        if (!nextTargets.has(entry)) throw new Error(`Missing Electron renderer target: ${entry}`)
      }
    }
    const nextPages = {}
    for (const [entry, target] of nextTargets) {
      let client = context.clientsByTargetId.get(target.id)
      if (!client) {
        client = await CdpClient.connect(target.webSocketDebuggerUrl, { timeoutMs: 15_000 })
        await client.enable()
        context.clientsByTargetId.set(target.id, client)
      }
      nextPages[ROLE_BY_ENTRY[entry]] = client
    }
    context.targets = nextTargets
    context.pages = nextPages
    return context
  }
  return context
}

async function discoverInitialTargets(context) {
  return waitFor(
    async () => {
      try {
        await context.refreshTargets({ requireComplete: true })
        return context
      } catch {
        return null
      }
    },
    { timeoutMs: 25_000, intervalMs: 150, description: 'three Electron renderer targets' },
  )
}

async function captureArtifacts(context, report) {
  const screenshots = {}
  report.finalSnapshots = {}
  for (const [role, client] of Object.entries(context?.pages || {})) {
    try {
      report.finalSnapshots[role] = await client.evaluate('window.desktopBridge?.e2e?.snapshot?.()')
    } catch (error) {
      report.finalSnapshots[role] = { error: serializeError(error) }
    }
  }
  try {
    await context.pages.pet?.evaluate(`Promise.all([
      window.desktopBridge?.openMainPanel?.(),
      window.desktopBridge?.openQuickChat?.(),
    ])`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  } catch {
    // Missing/broken preload is recorded by the target scenario and CDP console log.
  }
  for (const [role, client] of Object.entries(context?.pages || {})) {
    const screenshotPath = join(context.artifactPath, `${role}.png`)
    try {
      await client.bringToFront()
      await client.screenshot(screenshotPath)
      screenshots[role] = screenshotPath
    } catch (error) {
      screenshots[role] = { error: serializeError(error) }
    }
  }
  report.screenshots = screenshots
  report.cdp = {}
  for (const [role, client] of Object.entries(context?.pages || {})) {
    report.cdp[role] = client.diagnostics
  }
  await writeFile(join(context.artifactPath, 'cdp-log.json'), `${JSON.stringify(report.cdp, null, 2)}\n`)
}

async function writeReportFiles(artifactPath, report, stub, stdoutLines, stderrLines) {
  report.stubRequests = stub?.requests || []
  report.electron = {
    ...(report.electron || {}),
    stdoutLineCount: stdoutLines.length,
    stderrLineCount: stderrLines.length,
  }
  await Promise.all([
    writeFile(join(artifactPath, 'run.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(artifactPath, 'stub-requests.json'), `${JSON.stringify(report.stubRequests, null, 2)}\n`),
    writeFile(join(artifactPath, 'electron-stdout.log'), `${stdoutLines.join('\n')}\n`),
    writeFile(join(artifactPath, 'electron-stderr.log'), `${stderrLines.join('\n')}\n`),
  ])
}

export async function run(options = parseArgs(process.argv.slice(2))) {
  if (options.list) {
    process.stdout.write(`${[...Object.keys(SCENARIOS), 'suite'].join('\n')}\n`)
    return { ok: true, listed: true }
  }
  if (options.scenario !== 'suite' && !SCENARIOS[options.scenario]) {
    throw new Error(`Unknown scenario "${options.scenario}". Use --list to see available scenarios.`)
  }

  await verifyRuntime()
  const currentRunId = runId()
  const artifactPath = join(artifactRoot, currentRunId)
  await mkdir(artifactPath, { recursive: true })
  const userDataPath = await mkdtemp(join(tmpdir(), E2E_TEMP_PREFIX))
  const stdoutLines = []
  const stderrLines = []
  let stub = null
  let electron = null
  let context = null
  let primaryError = null
  let cleanupError = null
  const report = {
    runId: currentRunId,
    startedAt: new Date().toISOString(),
    scenario: options.scenario,
    status: 'running',
    artifactPath,
    userData: { path: userDataPath, removed: false },
    requiredBridge: REQUIRED_E2E_BRIDGE_API,
    requiredSelectors: REQUIRED_SELECTORS,
    results: [],
  }

  try {
    stub = await startStubServer()
    electron = startElectron({ userDataPath, stub, stdoutLines, stderrLines })
    report.electron = { pid: electron.pid, args: electron.args, executable: electronPath }
    const devTools = await waitForDevToolsActivePort(userDataPath, { timeoutMs: 25_000 })
    report.devTools = devTools
    context = createTargetContext(devTools.port, stub, artifactPath)
    await discoverInitialTargets(context)
    report.targets = [...context.targets].map(([entry, target]) => ({
      entry,
      id: target.id,
      title: target.title,
      url: target.url,
    }))

    const scenarioNames = options.scenario === 'suite' ? FULL_SCENARIO_ORDER : [options.scenario]
    for (const scenarioName of scenarioNames) {
      const startedAt = new Date().toISOString()
      process.stdout.write(`[e2e] ${scenarioName} started\n`)
      try {
        const result = await SCENARIOS[scenarioName](context)
        report.results.push({ scenario: scenarioName, status: 'passed', startedAt, finishedAt: new Date().toISOString(), result })
        process.stdout.write(`[e2e] ${scenarioName} passed\n`)
      } catch (error) {
        report.results.push({ scenario: scenarioName, status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: serializeError(error) })
        throw error
      }
    }
    report.status = 'passed'
  } catch (error) {
    primaryError = error
    report.status = 'failed'
    report.error = serializeError(error)
  } finally {
    report.finishedAt = new Date().toISOString()
    if (context) await captureArtifacts(context, report)
    await writeReportFiles(artifactPath, report, stub, stdoutLines, stderrLines)
    try {
      await stub?.close()
    } catch (error) {
      cleanupError ||= error
    }
    let terminationSucceeded = false
    try {
      await terminateRecordedProcess(electron)
      terminationSucceeded = true
    } catch (error) {
      cleanupError ||= error
    }
    if (terminationSucceeded) {
      try {
        const logDir = join(userDataPath, 'logs')
        if (await pathExists(logDir)) {
          for (const name of await readdir(logDir)) {
            if (name.startsWith('desktop-main-') && name.endsWith('.log')) {
              await copyFile(join(logDir, name), join(artifactPath, name))
            }
          }
        }
        await removeSafeUserDataPath(userDataPath)
        report.userData.removed = true
      } catch (error) {
        cleanupError ||= error
      }
    }
    if (cleanupError) {
      report.status = 'failed'
      report.cleanupError = serializeError(cleanupError)
    }
    await writeReportFiles(artifactPath, report, stub, stdoutLines, stderrLines)
  }

  process.stdout.write(`${JSON.stringify({
    ok: report.status === 'passed',
    scenario: options.scenario,
    artifactPath,
    error: report.error?.message || null,
    cleanupError: report.cleanupError?.message || null,
  }, null, 2)}\n`)
  if (cleanupError) throw cleanupError
  if (primaryError) throw primaryError
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}
