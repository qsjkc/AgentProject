import type { DesktopRelease } from '../types/index.js'

export function resolveDownloadUrlWithOrigin(apiOrigin: string, release: DesktopRelease): string {
  if (release.download_url.startsWith('http')) {
    return release.download_url
  }

  return `${apiOrigin}${release.download_url}`
}
