import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, '.test-dist')
const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc')

function runTypeScriptCompile() {
  const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.test.json'], {
    cwd: rootDir,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function importCompiledModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

async function main() {
  try {
    runTypeScriptCompile()

    const { getErrorMessage } = await importCompiledModule('src/lib/errors.js')
    const { formatRetentionRate, formatReviewPeriod } = await importCompiledModule(
      'src/lib/retention.js',
    )
    const { resolveDownloadUrlWithOrigin } = await importCompiledModule('src/services/url.js')

    assert.equal(formatReviewPeriod('2026-08-03_2026-08-09'), '2026-08-03 至 2026-08-09')
    assert.equal(formatReviewPeriod('unexpected-key'), 'unexpected-key')
    assert.equal(formatRetentionRate(0), '0%')
    assert.equal(formatRetentionRate(0.6667), '66.7%')
    assert.equal(formatRetentionRate(1), '100%')
    assert.equal(formatRetentionRate(Number.NaN), '—')
    assert.equal(formatRetentionRate(-0.1), '—')
    assert.equal(formatRetentionRate(1.1), '—')

    assert.equal(
      getErrorMessage(
        {
          response: {
            data: {
              detail: 'backend detail',
            },
          },
        },
        'fallback',
      ),
      'backend detail',
    )
    assert.equal(getErrorMessage(new Error('plain error'), 'fallback'), 'plain error')
    assert.equal(getErrorMessage(null, 'fallback'), 'fallback')

    assert.equal(
      resolveDownloadUrlWithOrigin('https://detachym.top', {
        platform: 'win-x64',
        version: 'DetachymAgentPet1.0',
        filename: 'DetachymAgentPet1.0.exe',
        download_url: 'https://cdn.example.com/DetachymAgentPet1.0.exe',
        available: true,
      }),
      'https://cdn.example.com/DetachymAgentPet1.0.exe',
    )
    assert.equal(
      resolveDownloadUrlWithOrigin('https://detachym.top', {
        platform: 'win-x64',
        version: 'DetachymAgentPet1.0',
        filename: 'DetachymAgentPet1.0.exe',
        download_url: '/download/DetachymAgentPet1.0.exe',
        available: true,
      }),
      'https://detachym.top/download/DetachymAgentPet1.0.exe',
    )

    console.log('frontend tests passed')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

await main()
