import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { ANIMATION_ACTIONS } from '../src/shared/pet-animation-state.js'
import { createAtlasGeometry, getAtlasFrameLayout, getCompanionSpriteAnimation, getSpriteFrameOffset, getSpriteFramePosition } from '../src/shared/pet-sprite-animation.js'

test('nonuniform dog poses retain complete source bounds, scale and jump height', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../frontend/src/assets/pets/dog/animations/manifest.json', import.meta.url)))
  const geometry = createAtlasGeometry(manifest.sheets, manifest.actions)
  const atlases = { core: 'core', care: 'care', geometry }
  for (const action of Object.values(ANIMATION_ACTIONS)) {
    const animation = getCompanionSpriteAnimation(atlases, action)
    assert.equal(animation.type, 'atlas')
    for (let index = 0; index < animation.frameCount; index++) {
      const { rect, x, y, width, height } = getAtlasFrameLayout(animation, index)
      assert.ok(Math.abs(width / rect.width - 0.46) < 1e-12)
      assert.ok(Math.abs(height / rect.height - 0.46) < 1e-12)
      assert.ok(x >= 0 && y >= 0 && x + width <= 126 && y + height <= 126)
    }
    assert.deepEqual(getAtlasFrameLayout(animation, 100), getAtlasFrameLayout(animation, 0))
  }
  assert.ok(Math.max(...geometry.core.frameLifts) > 10)
  assert.ok(geometry.care.frameLifts.every((lift) => lift === 0))
})

test('every companion event plays six real poses inside its own atlas', () => {
  for (const action of Object.values(ANIMATION_ACTIONS)) {
    const animation = getCompanionSpriteAnimation({ core: 'core.png', care: 'care.png' }, action)
    assert.equal(new Set(animation.frameIndices).size >= 6, true, action)
    assert.equal(animation.frameCount, animation.frameIndices.length)
    assert.ok(animation.frameIndices.every((frame) => frame >= 0 && frame < 30), action)
    for (let index = 0; index < animation.frameCount; index++) {
      const { x, y } = getSpriteFramePosition(animation, index)
      assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100, action)
    }
  }
  const cat = getCompanionSpriteAnimation({ core: 'cat-core', care: 'cat-care' }, 'eat')
  const dog = getCompanionSpriteAnimation({ core: 'dog-core', care: 'dog-care' }, 'eat')
  assert.equal(cat.src, 'cat-care')
  assert.equal(dog.src, 'dog-care')
  assert.deepEqual(cat.frameIndices, [18, 19, 20, 21, 22, 23])
})

test('switching from a long celebration to care cannot bleed into a neighboring row', () => {
  const animation = getCompanionSpriteAnimation({ core: 'core', care: 'care' }, 'pat')
  assert.deepEqual(getSpriteFramePosition(animation, 9), { x: 0, y: 50 })
  assert.deepEqual(getSpriteFramePosition(animation, 5), { x: 100, y: 50 })
  assert.deepEqual(getSpriteFramePosition({ columns: 3, rows: 2, frameCount: 6 }, 5), { x: 100, y: 100 })
})

test('composite celebrations retain the placement of each source action', () => {
  const animation = getCompanionSpriteAnimation({ core: 'core', care: 'care', coreRowOffsets: [0, 9, 10, 19, 28] }, 'level_up')
  assert.equal(getSpriteFrameOffset(animation, 0), 19)
  assert.equal(getSpriteFrameOffset(animation, 2), 10)
  assert.equal(getSpriteFrameOffset(animation, 9), 19)
  assert.equal(getSpriteFrameOffset(animation, 20), 19)
  assert.equal(getSpriteFrameOffset({ columns: 3, frameCount: 6 }, 0), 0)
})
