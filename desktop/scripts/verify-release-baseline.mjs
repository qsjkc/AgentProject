// Read-only release preflight. It does not install, launch, or deploy the app.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_PATHS = [
  'desktop/src', 'desktop/electron', 'desktop/build',
  'desktop/package.json', 'desktop/package-lock.json', 'desktop/vite.config.js',
  'desktop/pet.html', 'desktop/main-panel.html', 'desktop/quick-chat.html',
  'frontend/src/assets',
]

export async function verifyReleaseBaseline({ root, manifestPath, publicBaseUrl }) {
  const checks = []
  const check = async (name, run) => {
    try {
      const result = await run()
      checks.push({ name, ...result, status: result.ok ? 'passed' : 'failed' })
    } catch (error) {
      checks.push({ name, status: 'failed', error: error.message })
    }
  }
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!/^[a-f0-9]{40}$/i.test(manifest.sourceCommit || '')
    || !/^[a-f0-9]{64}$/i.test(manifest.sha256 || '')
    || typeof manifest.filename !== 'string'
    || /[\\/]/.test(manifest.filename)
    || basename(manifest.filename) !== manifest.filename
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0
    || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('Invalid release manifest: version, filename, bytes, sha256 and full sourceCommit are required')
  }
  await check('checkout-version', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'desktop/package.json'), 'utf8'))
    return { ok: pkg.version === manifest.version, expected: manifest.version, actual: pkg.version }
  })
  await check('checkout-source', async () => {
    // Compare actual files with the release tree, including skip-worktree files.
    // hash-object applies Git's normal text filters so CRLF checkouts are supported.
    const entries = git('ls-tree', '-r', '--name-only', manifest.sourceCommit, '--', ...SOURCE_PATHS)
      .split('\n').filter(Boolean)
    if (!entries.length) throw new Error('Release source tree is empty')
    const changed = []
    for (const path of entries) {
      try {
        const expected = git('rev-parse', `${manifest.sourceCommit}:${path}`)
        const actual = git('hash-object', `--path=${path}`, '--', path)
        if (actual !== expected) changed.push(path)
      } catch {
        changed.push(path)
      }
    }
    const additions = git('ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATHS)
      .split('\n').filter((path) => path && !entries.includes(path))
    changed.push(...additions)
    return { ok: changed.length === 0, sourceCommit: manifest.sourceCommit, changedFiles: [...new Set(changed)] }
  })
  await check('installer', async () => {
    const installer = resolve(root, manifest.filename)
    const bytes = (await stat(installer)).size
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(installer)) hash.update(chunk)
    const sha256 = hash.digest('hex')
    return { ok: bytes === manifest.bytes && sha256 === manifest.sha256.toLowerCase(), bytes, sha256 }
  })
  if (publicBaseUrl) {
    const base = new URL(publicBaseUrl)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error('Public base URL must use HTTP(S) without credentials')
    }
    const get = async (path) => {
      const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }
    await check('public-readiness', async () => {
      const result = await get('/health/ready')
      return { ok: result.status === 'ready', actual: result.status }
    })
    await check('public-version', async () => {
      const result = await get('/api/v1/public/version/win-x64')
      return {
        ok: result.available === true && result.version === manifest.version && result.filename === manifest.filename,
        version: result.version, filename: result.filename, available: result.available,
      }
    })
  }
  return {
    checkedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    scope: 'Source comparison, local installer checksum, optional public readiness and version only; not desktop or installation acceptance',
    checks,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  try {
    const report = await verifyReleaseBaseline({
      root,
      manifestPath: resolve(root, process.argv[2] || 'P1L-release-manifest.json'),
      publicBaseUrl: process.argv[3],
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', error: error.message }, null, 2))
    process.exitCode = 1
  }
}
