import { spawn, execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { assert, waitFor } from '../../desktop/scripts/e2e/assertions.mjs'
import { CdpClient, fetchPageTargets, mapRendererTargets, waitForDevToolsActivePort } from '../../desktop/scripts/e2e/cdp-client.mjs'

const [executable, profile, version, output] = process.argv.slice(2)
const report = { status: 'running', expectedVersion: version, renderers: [] }
const env = { ...process.env }
for (const key of ['DETACHYM_E2E', 'DETACHYM_API_BASE_URL', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) {
  delete env[key]
}
await mkdir(profile)
const child = spawn(executable, [
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + profile,
], { env, windowsHide: true, stdio: 'ignore' })
const childrenExited = new Promise(resolve => child.once('exit', resolve))
let childError
child.once('error', error => { childError = error })
const clients = new Map()
try {
  const { port } = await waitForDevToolsActivePort(profile)
  const targets = await waitFor(async () => {
    const current = mapRendererTargets(await fetchPageTargets(port))
    return current.size === 3 ? current : null
  }, { description: 'three installed app.asar renderers', timeoutMs: 20_000 })
  for (const [entry, target] of targets) {
    const page = await CdpClient.connect(target.webSocketDebuggerUrl)
    clients.set(entry, page)
    await page.enable()
    await page.waitForReady()
    const bridge = await page.evaluate('({ production: !!window.desktopBridge, e2e: !!window.desktopBridge?.e2e })')
    assert(target.url.includes('app.asar') && bridge.production && !bridge.e2e, entry + ': expected production packaged renderer')
    report.renderers.push(entry)
  }
  const pet = clients.get('pet.html')
  report.actualVersion = await pet.evaluate('window.desktopBridge.getAppVersion()')
  assert(report.actualVersion === version, 'installed app reports unexpected version')
  await pet.evaluate('window.desktopBridge.openMainPanel()')
  await clients.get('main-panel.html').waitForSelector('[data-e2e="login-submit"]')
  report.cleanLoginPrompt = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = childError?.message || error.message
} finally {
  for (const client of clients.values()) client.close()
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      await Promise.race([childrenExited, delay(5000)])
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        report.status = 'failed'
        report.cleanupError = error.message
      }
    }
  }
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    report.status = 'failed'
    report.cleanupError ||= 'Installed Electron process did not stop'
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
process.exitCode = report.status === 'passed' ? 0 : 1
