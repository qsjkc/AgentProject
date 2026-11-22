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

function subtractWorkArea(rectangle, area) {
  const { left, top, right, bottom } = rectangle
  const overlapLeft = Math.max(left, area.x)
  const overlapTop = Math.max(top, area.y)
  const overlapRight = Math.min(right, area.x + area.width)
  const overlapBottom = Math.min(bottom, area.y + area.height)
  if (overlapLeft >= overlapRight || overlapTop >= overlapBottom) return [rectangle]
  return [
    { left, top, right, bottom: overlapTop },
    { left, top: overlapBottom, right, bottom },
    { left, top: overlapTop, right: overlapLeft, bottom: overlapBottom },
    { left: overlapRight, top: overlapTop, right, bottom: overlapBottom },
  ].filter((part) => part.left < part.right && part.top < part.bottom)
}

function fitWindowAcrossWorkAreas(requested, display, screen, options) {
  const fitted = fitWindowBounds(requested, display.workArea, options)
  if (Object.keys(fitted).every((key) => fitted[key] === requested[key])) return fitted
  // A seam may divide a fully visible window between several displays. Subtract
  // their work areas so taskbars, gaps and staggered edges still count as offscreen.
  let uncovered = [{ left: requested.x, top: requested.y,
    right: requested.x + requested.width, bottom: requested.y + requested.height }]
  for (const candidate of screen.getAllDisplays()) {
    uncovered = uncovered.flatMap((rectangle) => subtractWorkArea(rectangle, candidate.workArea))
    if (!uncovered.length) return requested
  }
  return fitted
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
  if (hasPosition && options.allowAcrossDisplays) return fitWindowAcrossWorkAreas(requested, display, screen, options)
  return fitWindowBounds(requested, display.workArea, options)
}

function fitPetDragBounds(screen, bounds, cursor) {
  const requested = normalizeWindowBounds(bounds)
  return fitWindowAcrossWorkAreas(requested, screen.getDisplayNearestPoint(cursor), screen, { resizeToFit: false })
}

function recoverWindowBounds(windowInstance, screen, options = {}) {
  if (
    !windowInstance || windowInstance.isDestroyed()
    || windowInstance.isMinimized() || windowInstance.isMaximized() || windowInstance.isFullScreen()
  ) return false
  const previous = windowInstance.getBounds()
  const requested = { ...previous, ...options.fixedSize }
  const next = restoreWindowBounds(screen, requested, requested, options)
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
  fitPetDragBounds,
  fitWindowBounds,
  recoverWindowBounds,
  restoreWindowBounds,
}
