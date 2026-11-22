import { spawn, execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { assert, waitFor } from '../../desktop/scripts/e2e/assertions.mjs'
import { CdpClient, fetchPageTargets, mapRendererTargets, readDevToolsActivePort, waitForDevToolsActivePort } from '../../desktop/scripts/e2e/cdp-client.mjs'

const [executable, profile, version, output, mode, expectedLanguage] = process.argv.slice(2)
const upgrade = mode !== undefined
const languageSelector = '.desktop-login-meta select'
const pairedLanguages = new Map([['zh-CN', 'en'], ['en', 'zh-CN']])

const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase()

async function readUpgradeConfig(configPath) {
  assert((await lstat(configPath)).isFile() && samePath(await realpath(configPath), configPath),
    'Unexpected redirected profile configuration')
  const content = await readFile(configPath, 'utf8')
  try {
    return JSON.parse(content)
  } catch {
    throw new Error('Invalid Detachym profile configuration')
  }
}

async function upgradeProfilePaths() {
  assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows'
    && process.env.RUNNER_ARCH === 'X64' && process.env.GITHUB_WORKFLOW === 'Windows Upgrade Acceptance'
    && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === 'refs/heads/main',
  'Upgrade profile checks require the GitHub-hosted Windows Upgrade Acceptance workflow on main')
  assert((mode === 'set-language' && process.argv.length === 7)
    || (mode === 'preserve-language' && process.argv.length === 8 && pairedLanguages.has(expectedLanguage)),
  'Expected set-language or preserve-language with a supported expected language')
  assert(profile && profile === process.env.APPDATA && isAbsolute(profile), 'Upgrade mode requires the exact APPDATA path')
  assert(executable && isAbsolute(executable) && basename(executable).toLowerCase() === 'detachym.exe',
    'Upgrade mode requires the installed Detachym executable')
  const appData = await realpath(profile)
  assert(samePath(appData, profile), 'APPDATA unexpectedly resolves through a redirect')
  const paths = ['Detachym', 'detachym-desktop'].map((name) => join(appData, name))
  const existingConfigPaths = []
  for (const path of paths) {
    try {
      const entry = await lstat(path)
      assert(entry.isDirectory() && samePath(await realpath(path), path), 'Unexpected redirected Detachym profile')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      await lstat(join(path, 'DevToolsActivePort'))
      throw new Error('A previous DevTools marker still exists. Verify that the earlier app stopped.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const configPath = join(path, 'config.json')
    try {
      await lstat(configPath)
      existingConfigPaths.push(configPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (mode === 'set-language') {
    assert(existingConfigPaths.length === 0, 'Baseline requires an unused Detachym configuration')
  } else {
    assert(existingConfigPaths.length === 1, 'Candidate requires exactly one retained Detachym configuration')
    const saved = await readUpgradeConfig(existingConfigPaths[0])
    assert(saved.language === expectedLanguage && !saved.sessionToken, 'Retained configuration differs before candidate launch')
  }
  return { paths, existingConfigPath: existingConfigPaths[0] }
}

async function locateUpgradeProfile(paths) {
  const current = []
  for (const path of paths) {
    try {
      const marker = await readDevToolsActivePort(path)
      const profilePath = await realpath(path)
      assert(samePath(profilePath, path) && samePath(await realpath(marker.filePath), join(path, 'DevToolsActivePort')),
        'Unexpected redirected DevTools marker')
      assert(marker.port <= 65535, 'DevTools marker contains an invalid port')
      current.push({ ...marker, profilePath })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  assert(current.length <= 1, 'Found multiple Detachym DevTools profiles')
  return current[0]
}

async function verifyLanguage(main, configPath) {
  const observe = () => main.evaluate(`(async () => ({
    ui: document.querySelector(${JSON.stringify(languageSelector)})?.value,
    bridge: await window.desktopBridge.getLanguage(),
  }))()`)
  await main.waitForSelector(languageSelector)
  const original = await waitFor(async () => {
    const { ui, bridge } = await observe()
    return ui === bridge && pairedLanguages.has(ui) ? ui : null
  }, { description: 'login UI and stored language agree' })
  const language = mode === 'set-language' ? pairedLanguages.get(original) : expectedLanguage
  if (mode === 'set-language') {
    await main.evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(languageSelector)})
      const value = ${JSON.stringify(language)}
      if (![...select.options].some(option => option.value === value)) throw new Error('Missing language option')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value)
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
  }
  await waitFor(async () => {
    const { ui, bridge } = await observe()
    if (ui !== language || bridge !== language) return false
    const saved = await readUpgradeConfig(configPath)
    return saved.language === language && !saved.sessionToken
  }, { description: 'expected language in installed renderer, bridge and app config' })
  return { language, initialLanguage: original }
}

async function verifyRendererStorage(main) {
  const key = JSON.stringify('detachym.windows-upgrade-acceptance')
  const marker = `renderer-storage:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`
  if (mode === 'set-language') {
    const stored = await main.evaluate(`(() => {
      if (localStorage.getItem(${key}) !== null) return false
      localStorage.setItem(${key}, ${JSON.stringify(marker)})
      return localStorage.getItem(${key})
    })()`)
    assert(stored === marker, 'Baseline renderer did not store a fresh upgrade marker')
    return 'seeded'
  }
  assert(await main.evaluate(`localStorage.getItem(${key})`) === marker,
    'Candidate renderer did not retain the baseline local storage marker')
  return 'preserved'
}

const report = { status: 'running', expectedVersion: version, renderers: [] }
const env = { ...process.env }
for (const key of ['DETACHYM_E2E', 'DETACHYM_API_BASE_URL', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) {
  delete env[key]
}
const defaultProfile = upgrade ? await upgradeProfilePaths() : null
if (upgrade) {
  env.DETACHYM_API_BASE_URL = 'http://127.0.0.1:9/api/v1'
  report.mode = mode
} else {
  await mkdir(profile)
}
const child = spawn(executable, [
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  ...(!upgrade ? ['--user-data-dir=' + profile] : []),
], { env, windowsHide: true, stdio: 'ignore' })
const childrenExited = new Promise(resolve => child.once('exit', resolve))
let childError
child.once('error', error => { childError = error })
const clients = new Map()
let activeProfile
try {
  activeProfile = upgrade
    ? await waitFor(() => locateUpgradeProfile(defaultProfile.paths), { description: 'default Detachym DevTools profile', timeoutMs: 20_000 })
    : await waitForDevToolsActivePort(profile)
  const { port } = activeProfile
  if (upgrade) {
    report.profilePath = activeProfile.profilePath
    report.configPath = join(report.profilePath, 'config.json')
    assert(!defaultProfile.existingConfigPath || samePath(report.configPath, defaultProfile.existingConfigPath),
      'Candidate did not open the retained app profile')
  }
  const targets = await waitFor(async () => {
    const current = mapRendererTargets(await fetchPageTargets(port))
    return current.size === 3 ? current : null
  }, { description: 'three installed app.asar renderers', timeoutMs: 20_000 })
  for (const [entry, target] of targets) {
    if (upgrade) {
      const address = new URL(target.webSocketDebuggerUrl)
      assert(address.protocol === 'ws:' && address.hostname === '127.0.0.1' && Number(address.port) === port,
        'Unexpected DevTools endpoint for installed renderer')
    }
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
  const main = clients.get('main-panel.html')
  await main.waitForSelector('[data-e2e="login-submit"]')
  report.cleanLoginPrompt = true
  if (upgrade) {
    Object.assign(report, await verifyLanguage(main, report.configPath))
    report.rendererLocalStorage = await verifyRendererStorage(main)
    // Electron closes the CDP socket without replying to Browser.close.
    // Wait for normal shutdown so the renderer storage can finish writing.
    void main.send('Browser.close', {}, { timeoutMs: 2000 }).catch(() => {})
    await waitFor(() => child.exitCode !== null || child.signalCode !== null,
      { description: 'normal installed Electron shutdown', timeoutMs: 10_000 })
    assert(child.exitCode === 0, 'Installed Electron did not exit successfully')
    report.gracefulExit = true
  }
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
  if (upgrade && activeProfile && (child.exitCode !== null || child.signalCode !== null)) {
    try {
      const marker = await readDevToolsActivePort(activeProfile.profilePath)
      assert(marker.port === activeProfile.port && marker.browserPath === activeProfile.browserPath
        && samePath(await realpath(marker.filePath), activeProfile.filePath), 'DevTools marker changed after launch')
      await unlink(activeProfile.filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        report.status = 'failed'
        report.cleanupError ||= error.message
      }
    }
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
process.exitCode = report.status === 'passed' ? 0 : 1
