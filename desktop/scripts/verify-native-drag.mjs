import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { assert, assertEqual, serializeError, waitFor } from './e2e/assertions.mjs'
import { CdpClient, fetchPageTargets, mapRendererTargets, waitForDevToolsActivePort } from './e2e/cdp-client.mjs'
import { USERS } from './e2e/fixtures.mjs'
import { REQUIRED_SELECTORS as SELECTORS } from './e2e/p1k-scenarios.mjs'
import { removeSafeUserDataPath } from './e2e/run.mjs'
import { startStubServer } from './e2e/stub-server.mjs'

const usage = 'verify-native-drag.mjs --interactive-test-desktop --exe PATH --version VERSION --exe-sha256 SHA256 --app-asar-sha256 SHA256'
const script = fileURLToPath(new URL('./verify-native-drag.ps1', import.meta.url))
const desktop = resolve(fileURLToPath(import.meta.url), '../..')
const exec = promisify(execFile)
const powerShell = 'pwsh.exe'
const nativeCommand = ['-NoProfile', '-NoLogo', '-NonInteractive', '-File', script]

function argumentsForRun(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'interactive-test-desktop': { type: 'boolean' },
    exe: { type: 'string' }, version: { type: 'string' },
    'exe-sha256': { type: 'string' }, 'app-asar-sha256': { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) return null
  assert(values['interactive-test-desktop'] && values.exe && values.version, usage)
  for (const key of ['exe-sha256', 'app-asar-sha256']) {
    assert(/^[a-f0-9]{64}$/i.test(values[key] || ''), `A pinned ${key} is required.`)
  }
  assert(process.platform === 'win32', 'This test requires an interactive Windows test desktop.')
  return values
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function verifyFiles(executable, options) {
  const asar = join(dirname(executable), 'resources', 'app.asar')
  const [exeSha256, appAsarSha256] = await Promise.all([sha256(executable), sha256(asar)])
  assertEqual(exeSha256, options['exe-sha256'].toLowerCase(), 'Packaged executable digest differs')
  assertEqual(appAsarSha256, options['app-asar-sha256'].toLowerCase(), 'Packaged app.asar digest differs')
  return { exeSha256, appAsarSha256 }
}

function measure(native) {
  assert(!native.Error, native.Error || 'Native Win32 input completed')
  const { Samples: samples, Dpi: dpi, Work: work, GrabOffset: grab, HeldMs: heldMs } = native
  assert(Number.isInteger(dpi) && dpi > 0 && dpi % 96 !== 0, 'Fractional DPI is required', { dpi })
  const width = Math.round(220 * dpi / 96)
  const height = Math.round(240 * dpi / 96)
  const tolerance = Math.ceil(3 * dpi / 96)
  const clamp = (value, from, to) => Math.min(to, Math.max(from, value))
  const anchor = ({ X, Y }) => ({
    x: clamp(X - grab.X, work.Left, work.Right - width),
    y: clamp(Y - grab.Y, work.Top, work.Bottom - height),
  })
  const errorAt = (sample, target = anchor(sample.Cursor)) => Math.hypot(sample.Window.Left - target.x, sample.Window.Top - target.y)
  const span = (points, key) => Math.max(...points.map((point) => point[key])) - Math.min(...points.map((point) => point[key]))
  const longMotion = samples.filter((sample) => sample.Trial === 0 && sample.Phase === 'motion' && sample.ElapsedMs >= 500)
  assert(heldMs >= 80_000 && longMotion.length >= 1500, 'The long grip did not complete', { heldMs, samples: longMotion.length })
  const stableSize = samples.filter((sample) => sample.ElapsedMs >= 500)
  const sizes = stableSize.map(({ Window: b }) => ({ width: b.Right - b.Left, height: b.Bottom - b.Top }))
  assert(sizes.every((size) => Math.abs(size.width - width) <= 1 && Math.abs(size.height - height) <= 1)
    && span(sizes, 'width') <= 1 && span(sizes, 'height') <= 1, 'The fixed window size drifted at fractional DPI', { width, height })
  const checkpoints = samples.filter((sample) => sample.Phase === 'checkpoint')
  assert(checkpoints.length === 8 && checkpoints.every((point) => errorAt(point) <= tolerance),
    'The long drag failed to recover its anchor across the work area', checkpoints.map((point) => ({ cursor: point.Cursor, error: errorAt(point) })))
  assert(span(checkpoints.map((point) => point.Window), 'Left') >= (work.Right - work.Left - width) * .8
    && span(checkpoints.map((point) => point.Window), 'Top') >= (work.Bottom - work.Top - height) * .8,
  'The pet did not cover the requested drag range')

  const releases = samples.filter((sample) => sample.Phase === 'drop').map((drop) => {
    const trial = samples.filter((point) => point.Trial === drop.Trial)
    const peel = trial.find((point) => point.Phase === 'peel')
    const settled = trial.find((point) => point.Phase === 'settled')
    assert(peel && settled && peel.ElapsedMs >= drop.ElapsedMs, 'Missing post-release samples', { trial: drop.Trial })
    const cursorTravel = Math.hypot(peel.Cursor.X - drop.Cursor.X, peel.Cursor.Y - drop.Cursor.Y)
    assert(cursorTravel >= Math.min(work.Right - work.Left, work.Bottom - work.Top) * .35, 'Post-release cursor movement was too small')
    const finalError = errorAt(settled, anchor(drop.Cursor))
    assert(finalError <= tolerance, 'The pet did not stay at the captured drop point', { trial: drop.Trial, finalError })
    const firstMatch = trial.find((point) => point.ElapsedMs >= drop.ElapsedMs && errorAt(point, anchor(drop.Cursor)) <= tolerance)
    return { trial: drop.Trial, cursorTravel, finalError, settleMs: firstMatch.ElapsedMs - drop.ElapsedMs }
  })
  assertEqual(releases.length, 13, 'Expected one long grip and twelve repeated releases')
  const errors = longMotion.map((point) => errorAt(point)).sort((a, b) => a - b)
  return { dpi, heldMs, sampleCount: samples.length, width, height, tolerance,
    p95MotionAnchorErrorPx: errors[Math.floor(errors.length * .95)], releases }
}

async function run(options) {
  const executable = await realpath(options.exe)
  assertEqual(basename(executable).toLowerCase(), 'detachym.exe', 'Expected the packaged Detachym executable')
  const artifacts = join(desktop, 'artifacts', 'e2e', `native-drag-${Date.now()}-${process.pid}`)
  const report = { status: 'running', startedAt: new Date().toISOString(), executable,
    expectedVersion: options.version, backend: 'local-stub', profileRemoved: false }
  await mkdir(artifacts, { recursive: true })
  let userData, child, browser, stub, cancellation
  const clients = []
  const appErrors = []
  const exited = () => child && (child.exitCode !== null || child.signalCode !== null)
  function requestCancel() {
    if (userData && !cancellation) cancellation = writeFile(join(userData, 'cancel-native-drag'), 'cancel\n').catch((error) => {
      report.cancellationError = serializeError(error)
    })
  }
  async function stop() {
    if (!child?.pid || exited()) return
    if (browser) {
      void browser.send('Browser.close', {}, { timeoutMs: 2000 }).catch(() => {})
      await waitFor(exited, { description: 'the owned packaged process to quit', timeoutMs: 8000 }).catch(() => {})
    }
    if (!exited()) {
      const pid = String(child.pid)
      await exec('taskkill.exe', ['/PID', pid, '/T', '/F'], { windowsHide: true }).catch((error) => {
        if (!exited()) throw error
      })
      await waitFor(exited, { description: 'the owned packaged process to terminate' })
    }
  }
  try {
    report.fingerprints = await verifyFiles(executable, options)
    await exec(powerShell, [...nativeCommand, '-Preflight'], { windowsHide: true, timeout: 8000 })
    userData = await mkdtemp(join(tmpdir(), 'detachym-e2e-native-drag-'))
    process.on('SIGINT', requestCancel)
    process.on('SIGTERM', requestCancel)
    const roaming = join(userData, 'roaming')
    const local = join(userData, 'local')
    await Promise.all([mkdir(roaming), mkdir(local)])
    stub = await startStubServer()
    const env = { ...process.env, APPDATA: roaming, LOCALAPPDATA: local, DETACHYM_API_BASE_URL: stub.apiBaseUrl }
    delete env.DETACHYM_E2E
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userData}`], {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.on('error', (error) => appErrors.push(error.message))
    child.stderr.on('data', (chunk) => appErrors.push(String(chunk)))
    const { port, browserPath } = await waitForDevToolsActivePort(userData)
    browser = await CdpClient.connect(`ws://127.0.0.1:${port}${browserPath}`)
    const targets = await waitFor(async () => {
      const found = mapRendererTargets(await fetchPageTargets(port))
      return found.size === 3 && found
    }, { description: 'three packaged renderer targets', timeoutMs: 20_000 })
    const pages = {}
    for (const [entry, target] of targets) {
      assert(target.url.includes('app.asar'), 'Expected packaged renderers')
      const page = await CdpClient.connect(target.webSocketDebuggerUrl)
      clients.push(page)
      await page.enable()
      await page.waitForReady()
      assert(await page.evaluate('Boolean(window.desktopBridge && !window.desktopBridge.e2e)'), 'Expected the production bridge')
      pages[entry] = page
    }
    const pet = pages['pet.html']
    assertEqual(await pet.evaluate('window.desktopBridge.getAppVersion()'), options.version, 'Running version differs')
    const main = pages['main-panel.html']
    await pet.evaluate('window.desktopBridge.openMainPanel()')
    await main.input(SELECTORS.loginApiBaseUrl, stub.apiBaseUrl)
    await main.input(SELECTORS.loginUsername, USERS.A.username)
    await main.input(SELECTORS.loginPassword, USERS.A.password)
    await main.click(SELECTORS.loginSubmit)
    await main.waitForSelector(SELECTORS.mainDashboard)
    await main.click(SELECTORS.petOptionPig)
    await waitFor(() => pet.evaluate(`window.desktopBridge.getPetState().then(s=>s.petType === 'pig' && s.userId === ${USERS.A.id})`),
      { description: 'signed-in packaged pig fixture' })
    await main.evaluate('window.desktopBridge.hideMainPanel()')
    await pet.evaluate('window.desktopBridge.resetPetPosition()')
    await pet.evaluate('window.desktopBridge.openQuickChat()')
    await pages['quick-chat.html'].waitForSelector(SELECTORS.quickChatInput)
    await pet.evaluate('window.desktopBridge.focusPetWindow()')
    await pet.waitForSelector(SELECTORS.petSurface)
    const grab = await pet.evaluate(`(() => {
      const surface = document.querySelector(${JSON.stringify(SELECTORS.petSurface)});
      const { left, top, width, height } = surface.getBoundingClientRect();
      const x = left + width / 2, y = top + height / 2;
      return { x, y, scale: devicePixelRatio, hit: surface.contains(document.elementFromPoint(x, y)) };
    })()`)
    assert(grab.hit, 'The pet grab point is obscured', grab)
    report.setup = grab
    const { stdout } = await exec(powerShell, [...nativeCommand, '-OwnerId', String(child.pid), '-ExpectedExecutable', executable,
      '-GrabX', String(grab.x), '-GrabY', String(grab.y), '-RendererScale', String(grab.scale),
      '-CancelPath', join(userData, 'cancel-native-drag')], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    report.trace = JSON.parse(stdout)
    report.summary = measure(report.trace)
    report.finalBounds = await pet.evaluate('window.desktopBridge.getPetBounds()')
    await stop()
    const { petBounds } = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'))
    assert(petBounds.width === 220 && petBounds.height === 240, 'Persisted pet size is not nominal', petBounds)
    assert(Math.abs(report.finalBounds.x - petBounds.x) <= 1 && Math.abs(report.finalBounds.y - petBounds.y) <= 1,
      'The final native location was not persisted', petBounds)
    report.persistedBounds = petBounds
    await verifyFiles(executable, options)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = serializeError(error)
  } finally {
    process.off('SIGINT', requestCancel)
    process.off('SIGTERM', requestCancel)
    try {
      await cancellation
      await stop()
      if (userData) {
        await removeSafeUserDataPath(userData)
        report.profileRemoved = true
      }
    } catch (error) {
      report.status = 'failed'
      report.cleanupError = serializeError(error)
    } finally {
      for (const client of clients) client.close()
      browser?.close()
      await stub?.close()
    }
    report.finishedAt = new Date().toISOString()
    if (appErrors.length && report.status !== 'passed') report.appErrors = appErrors.slice(-12)
    const evidence = join(artifacts, 'native-drag.json')
    await writeFile(evidence, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ status: report.status, evidence, summary: report.summary, error: report.error,
      cleanupError: report.cleanupError }, null, 2))
  }
  return report.status === 'passed' ? 0 : 1
}

try {
  const options = argumentsForRun(process.argv.slice(2))
  if (options) process.exitCode = await run(options)
  else console.log(`${usage}\nRequires PowerShell 7 and one active Windows display with fractional scaling.\nThe test moves the Windows pointer and writes a JSON measurement report.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
