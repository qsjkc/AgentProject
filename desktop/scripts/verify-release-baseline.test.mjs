import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyReleaseBaseline } from './verify-release-baseline.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'detachym-release-baseline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Release Test')
  git('config', 'user.email', 'release-test@example.com')
  git('config', 'core.autocrlf', 'false')
  await mkdir(join(root, 'desktop/src'), { recursive: true })
  await writeFile(join(root, 'desktop/package.json'), '{"version":"1.1.0-rc.1"}\n')
  await writeFile(join(root, 'desktop/src/app.js'), 'original\n')
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture')
  const installer = Buffer.from('synthetic installer')
  await writeFile(join(root, 'candidate.exe'), installer)
  const manifest = {
    version: '1.1.0-rc.1', filename: 'candidate.exe', bytes: installer.length,
    sha256: createHash('sha256').update(installer).digest('hex'), sourceCommit: git('rev-parse', 'HEAD'),
  }
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { root, git, manifest, manifestPath, run: () => verifyReleaseBaseline({ root, manifestPath }) }
}

test('matching release passes, documentation-only changes do not invalidate runtime sources', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'notes.md'), 'new documentation')
  const report = await f.run()
  assert.equal(report.status, 'passed')
  assert.deepEqual(report.checks.map((item) => item.name), ['checkout-version', 'checkout-source', 'installer'])
})

test('detects changed source even when skip-worktree hides it from status', async (t) => {
  const f = await fixture(t)
  f.git('update-index', '--skip-worktree', 'desktop/src/app.js')
  await writeFile(join(f.root, 'desktop/src/app.js'), 'changed\n')
  const report = await f.run()
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.checks.find((item) => item.name === 'checkout-source').changedFiles, ['desktop/src/app.js'])
})

test('rejects different version, added source and corrupt installer', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'desktop/package.json'), '{"version":"1.0.0"}')
  await writeFile(join(f.root, 'desktop/src/extra.js'), 'unexpected')
  // Keep the same byte count to prove the checksum matters independently of size.
  await writeFile(join(f.root, 'candidate.exe'), 'Synthetic installer')
  const report = await f.run()
  assert.equal(report.status, 'failed')
  assert.ok(report.checks.every((item) => item.status === 'failed'))
  assert.ok(report.checks[1].changedFiles.includes('desktop/src/extra.js'))
})

test('missing source commit fails closed while still checking installer', async (t) => {
  const f = await fixture(t)
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, sourceCommit: '0'.repeat(40) }))
  const report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(report.checks[1].status, 'failed')
  assert.equal(report.checks[2].status, 'passed')
})

test('rejects manifest path traversal', async (t) => {
  const f = await fixture(t)
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, filename: '../candidate.exe' }))
  await assert.rejects(f.run, /Invalid release manifest/)
})

test('public health alone cannot pass when the published version differs', async (t) => {
  const f = await fixture(t)
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/health/ready'
      ? { status: 'ready' }
      : { version: '1.0.0', filename: 'candidate.exe', available: true }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const report = await verifyReleaseBaseline({
    root: f.root, manifestPath: f.manifestPath, publicBaseUrl: `http://127.0.0.1:${server.address().port}`,
  })
  assert.equal(report.status, 'failed')
  assert.equal(report.checks.find((item) => item.name === 'public-readiness').status, 'passed')
  assert.equal(report.checks.find((item) => item.name === 'public-version').status, 'failed')
})
