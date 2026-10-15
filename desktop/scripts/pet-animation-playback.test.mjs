import assert from 'node:assert/strict'
import test from 'node:test'
import { createPetAnimationPlayback } from '../src/shared/pet-animation-playback.js'

function harness(options = {}) {
  const pending = new Map()
  const frames = []
  let nextId = 0
  let completions = 0
  const playback = createPetAnimationPlayback({
    frameCount: 3, frameDuration: 110, looping: false,
    onFrame: (frame) => frames.push(frame),
    onComplete: () => { completions += 1 },
    schedule: (callback, delay) => { const id = ++nextId; pending.set(id, { callback, delay }); return id },
    cancel: (id) => pending.delete(id),
    ...options,
  })
  return {
    playback, pending, frames,
    get completions() { return completions },
    tick() {
      const [id, task] = pending.entries().next().value || []
      assert(task, 'a timer must be scheduled')
      pending.delete(id)
      task.callback()
      return task.delay
    },
  }
}

test('a care animation completes exactly once and leaves no recurring timer', () => {
  const run = harness()
  run.tick(); run.tick(); run.tick()
  assert.deepEqual(run.frames, [0, 1, 2, 0])
  assert.equal(run.completions, 1)
  assert.equal(run.pending.size, 0)
  run.playback.updatePolicy({ visible: false })
  run.playback.updatePolicy({ visible: true })
  assert.equal(run.pending.size, 0)
})

test('hidden pets pause all visual timers and resume at their retained frame', () => {
  const run = harness({ looping: true })
  run.tick()
  run.playback.updatePolicy({ visible: false })
  assert.equal(run.pending.size, 0)
  assert.deepEqual(run.frames, [0, 1])
  run.playback.updatePolicy({ visible: true })
  run.tick()
  assert.deepEqual(run.frames, [0, 1, 2])
  run.playback.dispose()
  assert.equal(run.pending.size, 0)
})

test('reduced motion has no idle timer and still completes a static care action', () => {
  const idle = harness({ looping: true, reducedMotion: true })
  assert.equal(idle.pending.size, 0)
  const care = harness({ reducedMotion: true })
  assert.equal(care.tick(), 330)
  assert.deepEqual(care.frames, [0])
  assert.equal(care.completions, 1)
  assert.equal(care.pending.size, 0)
})

test('live motion preference changes reset the visual without locking playback', () => {
  const run = harness({ looping: true })
  run.tick()
  run.playback.updatePolicy({ reducedMotion: true })
  assert.deepEqual(run.frames, [0, 1, 0])
  assert.equal(run.pending.size, 0)
  run.playback.updatePolicy({ reducedMotion: false })
  run.tick()
  assert.deepEqual(run.frames, [0, 1, 0, 1])
  run.playback.dispose()
})

test('hidden one-shot actions wait for visibility and canceled cycles never complete', () => {
  const run = harness({ frameCount: 1, visible: false })
  assert.equal(run.pending.size, 0)
  run.playback.updatePolicy({ visible: true })
  assert.equal(run.tick(), 660)
  assert.equal(run.completions, 1)
  const canceled = harness()
  const staleCallback = [...canceled.pending.values()][0].callback
  canceled.playback.dispose()
  staleCallback()
  assert.equal(canceled.completions, 0)
  assert.deepEqual(canceled.frames, [0])
})
