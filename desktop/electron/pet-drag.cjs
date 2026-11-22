const { fitPetDragBounds } = require('./window-bounds.cjs')

const RENDERER_MOVE_GRACE_MS = 24
const NATIVE_MOVE_INTERVAL_MS = 12

function isUsableWindow(window) {
  return window && !window.isDestroyed() && window.isVisible()
}

function isDragId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 128)
    || (Number.isSafeInteger(id) && id >= 0)
}

function createPetDragController({
  getWindow, screen, windowSize,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let active = null

  function clearNativeMove(mouse) {
    if (mouse.timer !== null) clearTimer(mouse.timer)
    mouse.timer = null
    mouse.cursor = null
  }

  function cancel() {
    if (active?.mouse) clearNativeMove(active.mouse)
    active = null
  }

  function hasActiveDrag() {
    if (active && (active.window !== getWindow() || !isUsableWindow(active.window))) cancel()
    return active !== null
  }

  function current(id) {
    return hasActiveDrag() && active.id === id
  }

  function begin({ id, offsetX, offsetY, pointerType } = {}) {
    const window = getWindow()
    if (!isUsableWindow(window) || !isDragId(id) || (active?.window === window && active.id === id)
      || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)
      || !['mouse', 'touch', 'pen'].includes(pointerType)) return false
    if (offsetX < 0 || offsetX >= windowSize.width || offsetY < 0 || offsetY >= windowSize.height) return false
    cancel()
    const mouse = pointerType === 'mouse'
      ? { lastRendererMoveAt: now(), lastNativeMoveAt: -Infinity, released: false, timer: null, cursor: null }
      : null
    active = { id, offsetX, offsetY, mouse, window }
    return true
  }

  function positionAt({ window, offsetX, offsetY }, cursor) {
    if (!Number.isFinite(cursor?.x) || !Number.isFinite(cursor?.y)) return false
    const bounds = window.getBounds()
    const next = fitPetDragBounds(screen, { ...windowSize, x: cursor.x - offsetX, y: cursor.y - offsetY }, cursor)
    // On Windows, Electron's setPosition reads the reported window size and
    // passes it back to SetBounds. At fractional DPI that can grow a fixed window.
    if (next.x !== bounds.x || next.y !== bounds.y) window.setBounds(next)
    return true
  }

  function move({ id, screenX, screenY } = {}) {
    if (!current(id) || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return false
    const { mouse } = active
    if (mouse?.released) return false
    // BrowserWindow bounds and Electron's native cursor are both in DIPs.
    // Touch and pen can move independently of the system mouse cursor.
    if (!mouse) return positionAt(active, { x: screenX, y: screenY })
    clearNativeMove(mouse)
    mouse.lastRendererMoveAt = now()
    return positionAt(active, screen.getCursorScreenPoint())
  }

  function observeMouseInput(input) {
    if (!hasActiveDrag() || !active.mouse || active.mouse.released
      || !['mouseMove', 'mouseUp'].includes(input?.type) || !Array.isArray(input.modifiers)) return
    const drag = active
    const { mouse } = drag
    // Electron 35 emits the lowercase spelling. Mouse-up for a second button
    // still reports the left button held and must not end the drag.
    const leftHeld = input.modifiers.includes('leftbuttondown') || input.modifiers.includes('leftButtonDown')
    if (!leftHeld) {
      mouse.released = true
      clearNativeMove(mouse)
      return
    }
    const receivedAt = now()
    if (input.type !== 'mouseMove' || receivedAt - mouse.lastRendererMoveAt < RENDERER_MOVE_GRACE_MS) return

    // The browser's input event has button state but no screen coordinates.
    // Capture the cursor now, before a queued update can outlive this input.
    const cursor = screen.getCursorScreenPoint()
    if (!Number.isFinite(cursor?.x) || !Number.isFinite(cursor?.y)) return
    mouse.cursor = { x: cursor.x, y: cursor.y }
    if (mouse.timer !== null) return

    const delay = Math.max(0, Math.ceil(mouse.lastNativeMoveAt + NATIVE_MOVE_INTERVAL_MS - receivedAt))
    mouse.timer = setTimer(() => {
      const latest = mouse.cursor
      mouse.timer = null
      mouse.cursor = null
      if (!latest || active !== drag || !hasActiveDrag() || mouse.released) return
      mouse.lastNativeMoveAt = now()
      positionAt(drag, latest)
    }, delay)
  }

  function end({ id, screenX, screenY, cancelled } = {}) {
    if (!current(id)) return false
    const drag = active
    cancel()
    // The mouse may already have moved away by the time the IPC arrives.
    if (cancelled !== true) positionAt(drag, { x: screenX, y: screenY })
    return true
  }

  return { begin, move, end, cancel, observeMouseInput }
}

module.exports = { createPetDragController }
