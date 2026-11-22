const { fitPetDragBounds } = require('./window-bounds.cjs')

function isUsableWindow(window) {
  return window && !window.isDestroyed() && window.isVisible()
}

function isDragId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 128)
    || (Number.isSafeInteger(id) && id >= 0)
}

function createPetDragController({ getWindow, screen, windowSize }) {
  let active = null

  function current(id) {
    if (active && (active.window !== getWindow() || !isUsableWindow(active.window))) active = null
    return active !== null && active.id === id
  }

  function begin({ id, offsetX, offsetY, pointerType } = {}) {
    const window = getWindow()
    if (!isUsableWindow(window) || !isDragId(id) || (active?.window === window && active.id === id)
      || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)
      || !['mouse', 'touch', 'pen'].includes(pointerType)) return false
    if (offsetX < 0 || offsetX >= windowSize.width || offsetY < 0 || offsetY >= windowSize.height) return false
    active = { id, offsetX, offsetY, pointerType, window }
    return true
  }

  function move({ id, screenX, screenY } = {}) {
    if (!current(id) || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return false
    // BrowserWindow bounds and Electron's native cursor are both in DIPs.
    // Touch and pen can move independently of the system mouse cursor.
    const cursor = active.pointerType === 'mouse' ? screen.getCursorScreenPoint() : { x: screenX, y: screenY }
    if (!Number.isFinite(cursor?.x) || !Number.isFinite(cursor?.y)) return false
    const { window, offsetX, offsetY } = active
    const bounds = window.getBounds()
    const next = fitPetDragBounds(screen, { ...windowSize, x: cursor.x - offsetX, y: cursor.y - offsetY }, cursor)
    // On Windows, Electron's setPosition reads the reported window size and
    // passes it back to SetBounds. At fractional DPI that can grow a fixed window.
    if (next.x !== bounds.x || next.y !== bounds.y) window.setBounds(next)
    return true
  }

  function end(payload = {}) {
    if (!current(payload.id)) return false
    try {
      if (payload.cancelled !== true) move(payload)
      return true
    } finally {
      active = null
    }
  }

  return { begin, move, end, cancel() { active = null } }
}

module.exports = { createPetDragController }
