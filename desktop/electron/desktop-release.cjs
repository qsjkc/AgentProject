function getDesktopDownloadPage({ senderRole, isMainFrame, currentServer, expectedServer }) {
  if (senderRole !== 'main-panel' || !isMainFrame || typeof currentServer !== 'string' || currentServer !== expectedServer) {
    throw new Error('The release source has changed. Check again.')
  }
  const server = new URL(currentServer)
  if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) {
    throw new Error('Invalid release source.')
  }
  // Only the configured service's portal can open externally. Never accept a
  // renderer-supplied target or the arbitrary download_url from an API response.
  return new URL('/download', server.origin).href
}

module.exports = { getDesktopDownloadPage }
