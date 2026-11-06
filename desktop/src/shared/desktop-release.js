import { runWithRequestDeadline } from './request-deadline.js'

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(value)
  if (!match) return null
  const prerelease = match[4]?.split('.') || []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null
  return { core: match.slice(1, 4).map(BigInt), prerelease }
}

export function compareDesktopVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX !== numericY) return numericX ? -1 : 1
    return (numericX ? BigInt(x) > BigInt(y) : x > y) ? 1 : -1
  }
  return 0
}

export function getDesktopReleaseStatus(currentVersion, release) {
  if (release?.platform !== 'win-x64' || typeof release.available !== 'boolean') throw new Error('invalid-release')
  const comparison = compareDesktopVersions(release.version, currentVersion)
  if (comparison === null) throw new Error('invalid-version')
  if (!release.available) return 'unavailable'
  return comparison > 0 ? 'update' : comparison === 0 ? 'current' : 'ahead'
}

export async function fetchDesktopRelease(apiBaseUrl, { signal, fetchImpl = fetch, timeoutMs } = {}) {
  const server = new URL(apiBaseUrl)
  if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) {
    throw new Error('invalid-server')
  }
  const endpoint = `${server.href.replace(/\/+$/, '')}/public/version/win-x64`
  return runWithRequestDeadline(async (requestSignal) => {
    // Public release metadata never needs the user's session or cookies. Do not
    // follow a redirect that could turn a configured source into another origin.
    const response = await fetchImpl(endpoint, { signal: requestSignal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
    if (!response.ok) throw new Error('release-unavailable')
    return response.json()
  }, { signal, timeoutMs })
}
