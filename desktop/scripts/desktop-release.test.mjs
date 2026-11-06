import assert from 'node:assert/strict'
import { compareDesktopVersions, fetchDesktopRelease, getDesktopReleaseStatus } from '../src/shared/desktop-release.js'
import { getDesktopDownloadPage } from '../electron/desktop-release.cjs'

for (const [left, right, expected] of [
  ['1.1.0-rc.10', '1.1.0-rc.4', 1], ['1.1.0', '1.1.0-rc.5', 1],
  ['1.1.0-rc.5', '1.1.0', -1], ['1.1.0+new', '1.1.0+old', 0],
  ['1.1.0-alpha', '1.1.0-alpha.1', -1], ['1.1.0-alpha.1', '1.1.0-alpha.beta', -1],
  ['1.1.0-beta.2', '1.1.0-beta.11', -1], ['1.1.0-beta', '1.1.0-rc.1', -1],
  ['1.2.0', '1.1.99', 1], ['2.0.0', '1.99.99', 1], ['1.1.0', '1.1.0', 0],
  ['1.1.0-rc.01', '1.1.0', null], ['01.1.0', '1.1.0', null], ['invalid', '1.1.0', null],
]) assert.equal(compareDesktopVersions(left, right), expected, `${left} versus ${right}`)

const release = { platform: 'win-x64', version: '1.1.0-rc.5', available: true }
assert.equal(getDesktopReleaseStatus('1.1.0-rc.4', release), 'update')
assert.equal(getDesktopReleaseStatus('1.1.0-rc.5', release), 'current')
assert.equal(getDesktopReleaseStatus('1.1.0', release), 'ahead')
assert.equal(getDesktopReleaseStatus('1.1.0-rc.4', { ...release, available: false }), 'unavailable')
for (const invalid of [{}, { ...release, platform: 'linux' }, { ...release, available: 'true' }, { ...release, version: 'latest' }]) {
  assert.throws(() => getDesktopReleaseStatus('1.1.0', invalid))
}

const authorized = { senderRole: 'main-panel', isMainFrame: true, currentServer: 'https://detachym.top/api/v1', expectedServer: 'https://detachym.top/api/v1' }
assert.equal(getDesktopDownloadPage(authorized), 'https://detachym.top/download')
for (const server of ['http://127.0.0.1:5000/api/v1', 'http://localhost:5000/prefix/api/v2/', 'https://private.example/prefix/api/v1']) {
  assert.equal(getDesktopDownloadPage({ ...authorized, currentServer: server, expectedServer: server }), `${new URL(server).origin}/download`)
}
for (const changes of [{ senderRole: 'pet' }, { senderRole: null }, { isMainFrame: false }, { expectedServer: 'https://evil.example/api/v1' }, { expectedServer: null }]) {
  assert.throws(() => getDesktopDownloadPage({ ...authorized, ...changes }))
}
for (const server of ['file:///tmp/download', 'javascript:alert(1)', 'https://user:pass@example.com/api/v1', 'https://example.com/api/v1?next=evil', 'https://example.com/api/v1#target', 'not a url']) {
  assert.throws(() => getDesktopDownloadPage({ ...authorized, currentServer: server, expectedServer: server }))
  await assert.rejects(fetchDesktopRelease(server, { fetchImpl: () => { throw new Error('must not fetch') } }))
}

let request
assert.deepEqual(await fetchDesktopRelease('https://detachym.top/api/v1/', {
  fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify(release)) },
}), release)
assert.equal(request.url, 'https://detachym.top/api/v1/public/version/win-x64')
assert.equal(request.options.credentials, 'omit')
assert.equal(request.options.redirect, 'error')
assert.equal(request.options.headers, undefined)
await assert.rejects(fetchDesktopRelease('https://detachym.top/api/v1', { fetchImpl: async () => new Response('', { status: 503 }) }))
await assert.rejects(fetchDesktopRelease('https://detachym.top/api/v1', { fetchImpl: async () => new Response('invalid JSON') }))
let timedOutSignal
await assert.rejects(fetchDesktopRelease('https://detachym.top/api/v1', {
  timeoutMs: 5,
  fetchImpl: async (_url, { signal }) => {
    timedOutSignal = signal
    return { ok: true, json: () => new Promise(() => {}) }
  },
}), { code: 'REQUEST_TIMEOUT' })
assert.equal(timedOutSignal.aborted, true, 'Deadline also aborts a stalled body')
const canceled = new AbortController()
canceled.abort(new Error('source changed'))
await assert.rejects(fetchDesktopRelease('https://detachym.top/api/v1', { signal: canceled.signal }), /source changed/)
console.log('desktop release tests passed')
