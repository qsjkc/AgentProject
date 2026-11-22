import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import windowBounds from '../electron/window-bounds.cjs'

const { createBoundsPersistence, createQuickChatPlacement, fitWindowBounds, recoverWindowBounds, restoreWindowBounds, windowBoundsMatch } = windowBounds
const primary = { workArea: { x: 0, y: 0, width: 1366, height: 728 } }
const left = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
const screen = {
  getPrimaryDisplay: () => primary,
  getDisplayMatching: (bounds) => bounds.x < 0 ? left : primary,
}

test('restores a main panel from a disconnected display entirely inside the remaining work area', () => {
  assert.deepEqual(restoreWindowBounds(screen, { x: 2800, y: 1200, width: 1100, height: 780 }), {
    x: 266, y: 0, width: 1100, height: 728,
  })
})

test('preserves a valid saved position on a negative-coordinate monitor', () => {
  const saved = { x: -1800, y: 90, width: 1100, height: 780 }
  assert.deepEqual(restoreWindowBounds(screen, saved), saved)
})

test('centers first launch and fits small high-DPI work areas without covering the taskbar', () => {
  assert.deepEqual(restoreWindowBounds(screen, {}, { width: 1100, height: 780 }), {
    x: 133, y: 0, width: 1100, height: 728,
  })
  const compactScreen = { ...screen, getPrimaryDisplay: () => ({ workArea: { x: 0, y: 24, width: 800, height: 540 } }) }
  assert.deepEqual(restoreWindowBounds(compactScreen, {}, { width: 1100, height: 780 }), {
    x: 0, y: 24, width: 800, height: 540,
  })
})

test('oversized fixed windows keep their controls anchored inside the work area', () => {
  assert.deepEqual(fitWindowBounds({ x: 40, y: 50, width: 430, height: 420 }, {
    x: 20, y: 30, width: 400, height: 300,
  }, { resizeToFit: false }), { x: 20, y: 30, width: 430, height: 420 })
})

test('invalid saved positions and dimensions cannot reach native window APIs', () => {
  const restored = restoreWindowBounds(screen, { x: Infinity, y: NaN, width: Infinity, height: NaN }, {
    width: 1100, height: 780,
  })
  assert.deepEqual(restored, { x: 133, y: 0, width: 1100, height: 728 })
  assert.deepEqual(fitWindowBounds({ x: 0, y: 0, width: -50, height: 0 }, primary.workArea), {
    x: 0, y: 0, width: 1, height: 1,
  })
})

function createWindow() {
  const windowInstance = new EventEmitter()
  Object.assign(windowInstance, {
    bounds: { x: 80, y: 90, width: 1100, height: 650 },
    minimized: false,
    maximized: false,
    fullScreen: false,
    destroyed: false,
    updates: [],
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    isMaximized() { return this.maximized },
    isFullScreen() { return this.fullScreen },
    getBounds() { return { ...this.bounds } },
    getNormalBounds() { return { ...this.bounds } },
    setBounds(bounds) { this.bounds = bounds; this.updates.push(bounds) },
  })
  return windowInstance
}

test('display recovery moves hidden windows without showing them or disturbing maximized windows', () => {
  const windowInstance = createWindow()
  windowInstance.bounds.x = 3000
  assert.equal(recoverWindowBounds(windowInstance, screen), true)
  assert.equal(windowInstance.bounds.x, 266)
  assert.equal(recoverWindowBounds(windowInstance, screen), false)
  for (const state of ['minimized', 'maximized', 'fullScreen', 'destroyed']) {
    windowInstance[state] = true
    windowInstance.bounds.x = 3000
    assert.equal(recoverWindowBounds(windowInstance, screen), false, state)
    windowInstance[state] = false
  }
  assert.equal(windowInstance.updates.length, 1)
})

function persistenceHarness(options = {}) {
  const windowInstance = createWindow()
  const timers = new Map()
  const writes = []
  let timerId = 0
  let stored = windowInstance.getBounds()
  const persistence = createBoundsPersistence({
    windowInstance,
    read: () => stored,
    write: (value) => { stored = value; writes.push(value) },
    setTimer: (callback) => { timers.set(++timerId, callback); return timerId },
    clearTimer: (id) => timers.delete(id),
    ...options,
  })
  const tick = () => {
    const callbacks = [...timers.values()]
    timers.clear()
    callbacks.forEach((callback) => callback())
  }
  return { windowInstance, persistence, writes, timers, tick }
}

test('a 100-frame drag writes only the final position and unchanged events do not write', () => {
  const { windowInstance, writes, timers, tick } = persistenceHarness()
  for (let index = 0; index < 100; index += 1) {
    windowInstance.bounds.x = index
    windowInstance.emit('move')
  }
  assert.equal(writes.length, 0)
  assert.equal(timers.size, 1)
  tick()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].x, 99)
  windowInstance.emit('resize')
  tick()
  assert.equal(writes.length, 1)
})

test('hide, close and quit flush the latest bounds even before the debounce expires', () => {
  for (const event of ['hide', 'close', 'quit']) {
    const { windowInstance, persistence, writes, timers } = persistenceHarness()
    windowInstance.bounds.x = 220
    windowInstance.emit('move')
    if (event === 'quit') persistence.flush()
    else windowInstance.emit(event)
    assert.equal(writes[0].x, 220, event)
    assert.equal(timers.size, 0, event)
  }
})

test('minimized coordinates do not overwrite the last normal bounds and closed windows clean timers', () => {
  const { windowInstance, writes, timers, tick } = persistenceHarness()
  windowInstance.bounds.x = 200
  windowInstance.emit('move')
  windowInstance.minimized = true
  windowInstance.bounds.x = -32000
  windowInstance.emit('move')
  windowInstance.emit('close')
  assert.equal(writes[0].x, 200)
  windowInstance.destroyed = true
  windowInstance.emit('closed')
  assert.equal(timers.size, 0)
  assert.equal(windowInstance.listenerCount('move'), 0)
  tick()
  assert.equal(writes.length, 1)
})

test('position-only persistence retains the stored fixed window size', () => {
  const { windowInstance, writes, tick } = persistenceHarness({ saveSize: false })
  windowInstance.bounds = { x: 180, y: 160, width: 300, height: 300 }
  windowInstance.emit('move')
  tick()
  assert.deepEqual(writes[0], { x: 180, y: 160, width: 1100, height: 650 })
})

const quickSize = { width: 430, height: 420 }

function quickPlacementHarness(savedBounds) {
  const primaryDisplay = { workArea: { x: 0, y: 0, width: 1200, height: 900 } }
  const externalDisplay = { workArea: { x: 1200, y: 0, width: 1200, height: 900 } }
  let displays = [primaryDisplay, externalDisplay]
  let anchor = { x: 234, y: 90 }
  const placementScreen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => primaryDisplay,
    getDisplayMatching: (bounds) => displays.length === 2 && bounds.x + bounds.width / 2 >= 1200
      ? externalDisplay : primaryDisplay,
  }
  return {
    placement: createQuickChatPlacement({ screen: placementScreen, size: quickSize, savedBounds, getAnchor: () => anchor }),
    moveAnchor: (position) => { anchor = position },
    removeExternalDisplay: () => { displays = [primaryDisplay] },
  }
}

test('default and known docked Quick Chat uses the current pet anchor when reopened', () => {
  for (const saved of [{}, { x: 235, y: 90 }, { x: 1050, y: 60, placement: 'docked' }]) {
    const { placement, moveAnchor } = quickPlacementHarness(saved)
    const oldAnchor = { x: 234, y: 90, ...quickSize }
    assert.equal(placement.isManual(), false)
    assert.deepEqual(placement.initialBounds, oldAnchor)
    moveAnchor({ x: 852, y: 210 })
    const newAnchor = { x: 852, y: 210, ...quickSize }
    assert.deepEqual(placement.resolveBounds(oldAnchor), newAnchor)
    assert.deepEqual(placement.serialize(newAnchor), { ...newAnchor, placement: 'docked' })
  }
})

test('manual Quick Chat retains its current position on a surviving display independently of the pet', () => {
  for (const saved of [{ x: 650, y: 60 }, { x: 234, y: 90, placement: 'manual' }]) {
    const { placement, moveAnchor, removeExternalDisplay } = quickPlacementHarness(saved)
    const { x, y } = saved
    assert.equal(placement.isManual(), true)
    assert.deepEqual(placement.initialBounds, { x, y, ...quickSize })
    moveAnchor({ x: 750, y: 210 })
    removeExternalDisplay()
    // The user may reopen before the debounce has saved the latest native move.
    const live = { x: x + 40, y: y + 20, width: 431, height: 421 }
    assert.deepEqual(placement.resolveBounds(live), { x: live.x, y: live.y, ...quickSize })
  }
})

test('manual Quick Chat allows a covered seam and clamps its own position when a display is removed', () => {
  const { placement, moveAnchor, removeExternalDisplay } = quickPlacementHarness({ x: 1050, y: 60 })
  const onSeam = { x: 1050, y: 60, ...quickSize }
  assert.deepEqual(placement.initialBounds, onSeam)
  moveAnchor({ x: 40, y: 300 })
  removeExternalDisplay()
  const fitted = { x: 770, y: 60, ...quickSize }
  assert.deepEqual(placement.resolveBounds(onSeam), fitted)
  assert.deepEqual(placement.serialize(fitted), { ...fitted, placement: 'manual' })
})

test('a manual drag returning to the saved coordinates still records the placement choice once', () => {
  const { placement } = quickPlacementHarness({})
  const { windowInstance, writes, tick } = persistenceHarness({ serialize: placement.serialize })
  const initial = windowInstance.getBounds()
  placement.noteManualMove(initial, initial)
  assert.equal(placement.isManual(), false)
  const moved = { ...initial, x: initial.x + 40 }
  placement.noteManualMove(initial, moved)
  windowInstance.bounds = moved
  windowInstance.emit('move')
  windowInstance.bounds = initial
  windowInstance.emit('move')
  assert.equal(writes.length, 0)
  tick()
  assert.deepEqual(writes, [{ ...initial, ...quickSize, placement: 'manual' }])
  windowInstance.emit('move')
  tick()
  assert.equal(writes.length, 1)
})

test('manual Quick Chat tolerates rounded native size without nudging its position', () => {
  const { placement } = quickPlacementHarness({ x: 449, y: 108, placement: 'manual' })
  const window = createWindow()
  const rounded = { ...placement.initialBounds, width: 431 }
  window.bounds = rounded
  const options = { resizeToFit: false, fixedSize: quickSize, sizeTolerance: 1 }
  for (let resizeEvent = 0; resizeEvent < 3; resizeEvent += 1) {
    assert.equal(recoverWindowBounds(window, screen, options), false)
  }
  assert.equal(window.updates.length, 0)
  const reopened = placement.resolveBounds(window.getBounds())
  assert.equal(windowBoundsMatch(rounded, reopened, 1), true)
  assert.equal(windowBoundsMatch(rounded, reopened), false)
  assert.deepEqual(placement.serialize(rounded), { ...reopened, placement: 'manual' })

  window.bounds = { ...rounded, x: 2800 }
  assert.equal(recoverWindowBounds(window, screen, options), true)
  assert.deepEqual(window.getBounds(), { x: 936, y: 108, ...quickSize })
})
