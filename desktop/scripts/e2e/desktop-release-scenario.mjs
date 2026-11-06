import { assert, assertEqual, waitFor } from './assertions.mjs'
import { join } from 'node:path'
import { USERS } from './fixtures.mjs'
import { ensureBaseBridge, loginAs, resetToLoggedOut } from './p1k-scenarios.mjs'

const ENDPOINT = '/api/v1/public/version/win-x64'
const CHECK = '[data-e2e="desktop-release-check"]'
const STATUS = '[data-e2e="desktop-release-status"]'

async function expectStatus(main, expected) {
  await waitFor(() => main.evaluate(`document.querySelector('${STATUS}')?.dataset.releaseStatus === ${JSON.stringify(expected)}`), {
    description: `desktop release ${expected}`,
  })
}

async function openPanel(main) {
  await main.click('.main-more-settings > summary')
  await main.click('[data-e2e="desktop-release"] > summary')
}

export async function desktopReleaseScenario(context) {
  await ensureBaseBridge(context)
  await resetToLoggedOut(context)
  await loginAs(context, USERS.A)
  const main = context.pages.main
  const version = await main.evaluate('window.desktopBridge.getAppVersion()')
  const nextVersion = /-rc\.\d+$/.test(version) ? version.replace(/\d+$/, (number) => String(Number(number) + 1)) : `${Number(version.split('.')[0]) + 1}.0.0`
  const current = { platform: 'win-x64', version, available: true, download_url: 'https://untrusted.example/not-opened.exe' }
  let restore = context.stub.overrideResponse('GET', ENDPOINT, 200, current)
  try {
    await openPanel(main)
    await expectStatus(main, 'current')
    assert(await main.evaluate(`document.querySelector('[data-e2e="desktop-current-version"]').textContent.includes(${JSON.stringify(version)})`), 'Installed version is missing')
    const cases = [
      { status: 'update', release: { ...current, version: nextVersion } },
      { status: 'unavailable', release: { ...current, version: nextVersion, available: false } },
      { status: 'ahead', release: { ...current, version: '0.0.1' } },
      { status: 'error', release: { ...current, version: 'not-semver' } },
      { status: 'error', release: { detail: 'temporary failure' }, code: 503 },
      { status: 'current', release: current },
    ]
    for (const item of cases) {
      restore()
      restore = context.stub.overrideResponse('GET', ENDPOINT, item.code || 200, item.release)
      await main.click(CHECK)
      await expectStatus(main, item.status)
      if (item.status === 'update') await main.screenshot(join(context.artifactPath, 'desktop-release-update.png'))
      assertEqual(await main.evaluate(`Boolean(document.querySelector('[data-e2e="desktop-release-download"]'))`), item.status === 'update', 'Download action is shown only for an available newer release')
      assertEqual(await main.evaluate(`document.querySelector('[data-e2e="main-chat-input"]').disabled`), false, 'Checking releases must not block chat')
    }
    assertEqual(await main.evaluate(`window.desktopBridge.openDesktopDownloadPage('https://untrusted.example/api/v1').then(() => false, () => true)`), true, 'External navigation accepted a renderer-selected source')
    assertEqual(await context.pages.quick.evaluate(`window.desktopBridge.openDesktopDownloadPage(${JSON.stringify(context.stub.apiBaseUrl)}).then(() => false, () => true)`), true, 'Quick-chat renderer opened an external page')

    const held = context.stub.holdNext('GET', ENDPOINT, { statusCode: 200, payload: { ...current, version: '9999.0.0' } })
    await main.click(CHECK)
    await held.arrived
    await main.click('[data-e2e="logout"]')
    held.release()
    await loginAs(context, USERS.B)
    assertEqual(await main.evaluate(`document.querySelector('${STATUS}')?.dataset.releaseStatus`), 'idle', 'A previous account request populated the new panel')
    await openPanel(main)
    await expectStatus(main, 'current')
    assert(context.stub.requests.filter((request) => request.pathname === ENDPOINT).every((request) => request.authorization === null), 'Public version checks included account credentials')
    return { currentVersion: version, states: ['current', 'update', 'unavailable', 'ahead', 'malformed', 'offline', 'retry'], staleAccountResultIgnored: true, externalTargetRejected: true }
  } finally { restore() }
}
