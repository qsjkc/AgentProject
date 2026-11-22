import assert from 'node:assert/strict'
import { test } from 'node:test'
import petDrag from '../electron/pet-drag.cjs'
import windowBounds from '../electron/window-bounds.cjs'

const { createPetDragController } = petDrag
const { fitPetDragBounds, restoreWindowBounds } = windowBounds
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
    isDestroyed() { return this.destroyed },
    isVisible() { return this.visible },
    getBounds() { return this.bounds },
    setPosition(x, y) { this.moves.push({ x, y }); this.bounds = { ...this.bounds, x, y } },
  }
}

test('a sustained mouse drag follows a fixed grab point across both directions of an aligned display seam', () => {
  const screen = makeScreen([display(-1920, 0, 1920, 1040), display(0, 0, 1920, 1040)])
  const window = makeWindow(-220, 250)
  const drag = createPetDragController({ getWindow: () => window, screen })
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
  screen.cursor = { x: -130, y: 410 }
  assert.equal(drag.end({ id, screenX: 0, screenY: 0, cancelled: false }), true)
  assert.deepEqual(window.bounds, { x: -220, y: 250, ...size })
  assert.equal(drag.move({ id, screenX: 0, screenY: 0 }), false)
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
  const drag = createPetDragController({ getWindow: () => window, screen })
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
  const drag = createPetDragController({ getWindow: () => window, screen })
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
