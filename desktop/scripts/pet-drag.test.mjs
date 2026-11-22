import assert from 'node:assert/strict'
import { test } from 'node:test'
import petDrag from '../electron/pet-drag.cjs'
import windowBounds from '../electron/window-bounds.cjs'

const { createPetDragController } = petDrag
const { fitPetDragBounds, recoverWindowBounds, restoreWindowBounds } = windowBounds
const size = { width: 220, height: 240 }

function display(x, y, width, height) {
  return { workArea: { x, y, width, height } }
}

function makeScreen(displays) {
  const distance = ({ x, y }, { workArea: area }) => (
    Math.hypot(Math.max(area.x - x, x - area.x - area.width, 0), Math.max(area.y - y, y - area.y - area.height, 0))
  )
  const nearest = (point) => displays.reduce((result, entry) => distance(point, entry) < distance(point, result) ? entry : result)
  return {
    cursor: { x: 0, y: 0 },
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: ({ x, y, width, height }) => nearest({ x: x + width / 2, y: y + height / 2 }),
    getDisplayNearestPoint: nearest,
    getAllDisplays: () => displays,
    getCursorScreenPoint() { return this.cursor },
  }
}

function makeWindow(x, y) {
  return {
    bounds: { x, y, ...size },
    visible: true,
    destroyed: false,
    moves: [],
    writes: [],
    isDestroyed() { return this.destroyed },
    isVisible() { return this.visible },
    getBounds() { return this.bounds },
    setBounds(bounds) {
      this.moves.push({ x: bounds.x, y: bounds.y })
      this.writes.push(bounds)
      this.bounds = bounds
    },
  }
}

test('a sustained mouse drag follows a fixed grab point across both directions of an aligned display seam', () => {
  const screen = makeScreen([display(-1920, 0, 1920, 1040), display(0, 0, 1920, 1040)])
  const window = makeWindow(-220, 250)
  const drag = createPetDragController({ getWindow: () => window, screen, windowSize: size })
  const id = 'mouse-drag'
  const offsetX = 90
  const offsetY = 160
  assert.equal(drag.begin({ id, offsetX, offsetY, pointerType: 'mouse' }), true)
  // Simulate modest individual samples where rebasing against the old top-left
  // display clamp would otherwise keep the window permanently at x=-220.
  const rightward = Array.from({ length: 100 }, (_, index) => -130 + (index + 1) * 6)
  const leftward = [...rightward].reverse().slice(1)
  for (const x of [...rightward, ...leftward]) {
    screen.cursor = { x, y: 410 }
    assert.equal(drag.move({ id, screenX: 0, screenY: 0 }), true)
    assert.equal(window.bounds.x, x - offsetX)
    assert.equal(window.bounds.y, 250)
  }
  assert.equal(window.moves.length, rightward.length + leftward.length)
  assert.equal(drag.end({ id, screenX: -130, screenY: 410, cancelled: false }), true)
  assert.deepEqual(window.bounds, { x: -220, y: 250, ...size })
  assert.equal(drag.move({ id, screenX: 0, screenY: 0 }), false)
})

test('a mouse release stays at its captured point when the live cursor moves before processing', () => {
  const screen = makeScreen([display(0, 0, 1800, 1040)])
  const window = makeWindow(400, 200)
  const drag = createPetDragController({ getWindow: () => window, screen, windowSize: size })
  const id = 'release-race'
  assert.equal(drag.begin({ id, offsetX: 90, offsetY: 120, pointerType: 'mouse' }), true)
  screen.cursor = { x: 610, y: 390 }
  assert.equal(drag.move({ id, screenX: 0, screenY: 0 }), true)
  assert.deepEqual(window.bounds, { x: 520, y: 270, ...size })

  screen.cursor = { x: 1300, y: 750 }
  assert.equal(drag.end({ id, screenX: 620, screenY: 400, cancelled: false }), true)
  assert.deepEqual(window.bounds, { x: 530, y: 280, ...size })
  assert.equal(drag.move({ id, screenX: 1300, screenY: 750 }), false)
})

test('preserves a covered vertical or horizontal seam while clamping uncovered work-area gaps', () => {
  const horizontal = makeScreen([display(-1000, 0, 1000, 700), display(0, 0, 1000, 700)])
  const seam = { x: -100, y: 200, ...size }
  assert.deepEqual(fitPetDragBounds(horizontal, seam, { x: 20, y: 300 }), seam)
  assert.deepEqual(restoreWindowBounds(horizontal, seam, {}, { resizeToFit: false, allowAcrossDisplays: true }), seam)
  assert.equal(restoreWindowBounds(horizontal, seam).x, 0, 'other windows still use a single work area')

  const vertical = makeScreen([display(0, -700, 1000, 700), display(0, 0, 1000, 700)])
  const verticalSeam = { x: 350, y: -120, ...size }
  assert.deepEqual(fitPetDragBounds(vertical, verticalSeam, { x: 440, y: 40 }), verticalSeam)

  const horizontalGap = makeScreen([display(-1000, 0, 950, 700), display(0, 0, 1000, 700)])
  assert.deepEqual(fitPetDragBounds(horizontalGap, seam, { x: 20, y: 300 }), { ...seam, x: 0 })
  assert.deepEqual(restoreWindowBounds(horizontalGap, seam, {}, { resizeToFit: false, allowAcrossDisplays: true }), { ...seam, x: 0 })

  const staggered = makeScreen([display(-1000, 0, 1000, 700), display(0, 250, 1000, 450)])
  assert.deepEqual(fitPetDragBounds(staggered, seam, { x: 20, y: 300 }), { ...seam, x: 0, y: 250 })
  assert.deepEqual(fitPetDragBounds(horizontal, { ...seam, x: 900, y: 600 }, { x: 990, y: 680 }), { ...seam, x: 780, y: 460 })
})

test('clamped repeats never write native positions again and touch uses its own finite sample', () => {
  const screen = makeScreen([display(0, 0, 800, 600)])
  screen.cursor = { x: 30, y: 40 }
  const window = makeWindow(578, 200)
  const drag = createPetDragController({ getWindow: () => window, screen, windowSize: size })
  const id = 'touch-drag'
  assert.equal(drag.begin({ id, offsetX: 50, offsetY: 90, pointerType: 'touch' }), true)
  for (const screenX of [631, 640, 650, 670]) drag.move({ id, screenX, screenY: 290 })
  assert.deepEqual(window.moves, [{ x: 580, y: 200 }])
  assert.equal(drag.move({ id, screenX: Infinity, screenY: 290 }), false)
  assert.equal(drag.end({ id, screenX: 0, screenY: 0, cancelled: true }), true)
  assert.deepEqual(window.moves, [{ x: 580, y: 200 }])
})

test('rejects invalid starts and discards stale input after replacement, hide or cancellation', () => {
  const screen = makeScreen([display(0, 0, 900, 700)])
  let window = makeWindow(200, 200)
  const drag = createPetDragController({ getWindow: () => window, screen, windowSize: size })
  const start = { id: 1, offsetX: 70, offsetY: 100, pointerType: 'pen' }
  const move = { id: 1, screenX: 400, screenY: 300 }
  assert.equal(drag.move({}), false)
  assert.equal(drag.begin({ ...start, offsetX: 220 }), false)
  assert.equal(drag.begin({ ...start, offsetY: -1 }), false)
  assert.equal(drag.begin({ ...start, id: '' }), false)
  assert.equal(drag.begin({ ...start, pointerType: 'unknown' }), false)
  assert.equal(drag.begin(start), true)
  assert.equal(drag.begin(start), false)
  assert.equal(drag.begin({ ...start, id: 2 }), true)
  assert.equal(drag.end(move), false)
  assert.equal(drag.move({ ...move, id: 2 }), true)
  assert.deepEqual(window.moves, [{ x: 330, y: 200 }])

  window.visible = false
  assert.equal(drag.move({ ...move, id: 2 }), false)
  window.visible = true
  assert.equal(drag.move({ ...move, id: 2 }), false)
  assert.equal(drag.begin(start), true)
  window = makeWindow(50, 50)
  assert.equal(drag.move(move), false)
  assert.equal(drag.begin(start), true)
  drag.cancel()
  assert.equal(drag.end(move), false)
  assert.deepEqual(window.moves, [])
})

test('repeated fractional-DPI reports cannot grow the fixed pet or shrink its drag region', () => {
  const screen = makeScreen([display(0, 0, 1800, 1000)])
  const window = makeWindow(300, 200)
  // Model a getBounds round-trip that reports the fixed rectangle two DIPs
  // larger. A SetPosition-style operation would pass those values back.
  window.getBounds = () => ({ ...window.bounds, width: window.bounds.width + 2, height: window.bounds.height + 2 })
  const drag = createPetDragController({ getWindow: () => window, screen, windowSize: size })
  const id = 'fractional-dpi'
  assert.equal(drag.begin({ id, offsetX: 90, offsetY: 150, pointerType: 'mouse' }), true)
  for (let index = 1; index <= 240; index += 1) {
    screen.cursor = { x: 390 + index * 5, y: 350 + index }
    assert.equal(drag.move({ id, screenX: 0, screenY: 0 }), true)
    assert.deepEqual(window.bounds, { x: 300 + index * 5, y: 200 + index, ...size })
  }
  assert.equal(window.writes.length, 240)
  assert.equal(window.writes.every(({ width, height }) => width === size.width && height === size.height), true)
  assert.equal(drag.end({ id, screenX: 1799, screenY: 999, cancelled: false }), true)
  assert.deepEqual(window.bounds, { x: 1580, y: 760, ...size })
})

test('fixed-window display recovery fits nominal size without reapplying rounded reports', () => {
  const screen = makeScreen([display(0, 0, 800, 600)])
  const window = makeWindow(90, 90)
  Object.assign(window, {
    bounds: { x: 670, y: 490, width: 450, height: 400 },
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
  })
  assert.equal(recoverWindowBounds(window, screen, { resizeToFit: false, fixedSize: size }), true)
  assert.deepEqual(window.bounds, { x: 580, y: 360, ...size })
})
