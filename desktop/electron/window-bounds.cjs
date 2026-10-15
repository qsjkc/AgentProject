function finiteInteger(value, fallback) {
  return Number.isFinite(value) ? Math.round(value) : fallback
}

function normalizeWindowBounds(bounds = {}, defaults = {}) {
  return {
    x: finiteInteger(bounds.x, finiteInteger(defaults.x, 0)),
    y: finiteInteger(bounds.y, finiteInteger(defaults.y, 0)),
    width: Math.max(1, finiteInteger(bounds.width, finiteInteger(defaults.width, 1))),
    height: Math.max(1, finiteInteger(bounds.height, finiteInteger(defaults.height, 1))),
  }
}

function fitWindowBounds(bounds, workArea, { resizeToFit = true } = {}) {
  const requested = normalizeWindowBounds(bounds)
  const area = normalizeWindowBounds(workArea)
  const width = resizeToFit ? Math.min(requested.width, area.width) : requested.width
  const height = resizeToFit ? Math.min(requested.height, area.height) : requested.height
  return {
    x: Math.min(Math.max(requested.x, area.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(requested.y, area.y), area.y + Math.max(0, area.height - height)),
    width,
    height,
  }
}

function restoreWindowBounds(screen, bounds = {}, defaults = {}, options = {}) {
  const requested = normalizeWindowBounds(bounds, defaults)
  const hasPosition = Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
  const display = hasPosition
    ? screen.getDisplayMatching(requested)
    : screen.getPrimaryDisplay()
  if (!hasPosition) {
    requested.x = display.workArea.x + Math.round((display.workArea.width - requested.width) / 2)
    requested.y = display.workArea.y + Math.round((display.workArea.height - requested.height) / 2)
  }
  return fitWindowBounds(requested, display.workArea, options)
}

function recoverWindowBounds(windowInstance, screen, options = {}) {
  if (
    !windowInstance || windowInstance.isDestroyed()
    || windowInstance.isMinimized() || windowInstance.isMaximized() || windowInstance.isFullScreen()
  ) return false
  const previous = windowInstance.getBounds()
  const next = restoreWindowBounds(screen, previous, previous, options)
  if (Object.keys(next).every((key) => next[key] === previous[key])) return false
  windowInstance.setBounds(next)
  return true
}

// Window move events also fire on every animation/drag frame. Persist the final
// normal bounds once the burst settles, and flush before hiding or quitting.
function createBoundsPersistence({
  windowInstance,
  read,
  write,
  saveSize = true,
  delayMs = 200,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null
  let pending = null
  let disposed = false

  const flush = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!pending) return
    const bounds = pending
    pending = null
    const previous = read() || {}
    const next = saveSize ? bounds : { ...previous, x: bounds.x, y: bounds.y }
    if (Object.keys(next).some((key) => next[key] !== previous[key])) write(next)
  }
  const capture = () => {
    if (disposed || windowInstance.isDestroyed() || windowInstance.isMinimized()) return
    pending = { ...windowInstance.getNormalBounds() }
    if (timer !== null) clearTimer(timer)
    timer = setTimer(flush, delayMs)
    timer?.unref?.()
  }
  const captureAndFlush = () => {
    capture()
    flush()
  }
  const dispose = () => {
    flush()
    disposed = true
    windowInstance.removeListener('move', capture)
    windowInstance.removeListener('resize', capture)
    windowInstance.removeListener('hide', captureAndFlush)
    windowInstance.removeListener('close', captureAndFlush)
    windowInstance.removeListener('closed', dispose)
  }
  windowInstance.on('move', capture)
  windowInstance.on('resize', capture)
  windowInstance.on('hide', captureAndFlush)
  windowInstance.on('close', captureAndFlush)
  windowInstance.on('closed', dispose)
  return { flush: captureAndFlush, dispose }
}

module.exports = {
  createBoundsPersistence,
  fitWindowBounds,
  recoverWindowBounds,
  restoreWindowBounds,
}
