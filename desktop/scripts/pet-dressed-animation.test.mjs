import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ANIMATION_ACTIONS } from '../src/shared/pet-animation-state.js'
import { getPetOutfitCatalog } from '../src/shared/pet-outfits.js'
import { createDressedAnimation, DRESSED_ACTIONS, DRESSED_OUTFIT_KEYS, getDressedOutfitKey } from '../src/shared/pet-dressed-animation.js'
import { getAtlasFrameLayout } from '../src/shared/pet-sprite-animation.js'

function outfitFor(pet, key) {
  const [neck, head, side] = key.split('__')
  return {
    unlocked_outfit_ids: getPetOutfitCatalog(pet).map((item) => item.id),
    equipped_outfits: Object.fromEntries(Object.entries({ neck, head, side })
      .filter(([, suffix]) => suffix !== 'none')
      .map(([slot, suffix]) => [slot, `${pet}_${suffix === 'scarf' ? 'basic_scarf' : suffix}`])),
  }
}

test('all three pets preserve every simultaneously equipped slot during care and celebrations', () => {
  assert.equal(DRESSED_OUTFIT_KEYS.length, 17)
  for (const pet of ['pig', 'cat', 'dog']) {
    for (const key of DRESSED_OUTFIT_KEYS) {
      const outfit = outfitFor(pet, key)
      for (const action of Object.values(ANIMATION_ACTIONS)) {
        const resolved = getDressedOutfitKey(pet, action, outfit)
        const expected = key.split('__')
        if (action === 'sleeping' && expected[1] === 'none') expected[1] = 'sleep_cap'
        if (action === 'reminding' && expected[2] === 'none') expected[2] = 'bell'
        assert.equal(resolved, expected.join('__'), `${pet}/${action}/${key}`)
      }
    }
    assert.equal(getDressedOutfitKey(pet, 'idle', null), null)
    const outfit = outfitFor(pet, 'scarf__star_hat__work_badge')
    const before = structuredClone(outfit)
    assert.equal(getDressedOutfitKey(pet, 'level_up', outfit, `${pet}_sleep_cap`), 'scarf__sleep_cap__work_badge')
    assert.deepEqual(outfit, before, 'milestone previews must not persist outfit changes')
  }
})

test('locked, foreign-species and wrong-slot outfits cannot enter the rendered costume', () => {
  assert.equal(getDressedOutfitKey('cat', 'idle', {
    unlocked_outfit_ids: ['cat_basic_scarf', 'dog_sleep_cap', 'cat_star_hat'],
    equipped_outfits: { neck: 'cat_basic_scarf', head: 'dog_sleep_cap', side: 'cat_star_hat' },
  }, 'cat_work_badge'), 'scarf__none__none')
  assert.equal(getDressedOutfitKey('pig', 'idle', {
    unlocked_outfit_ids: [], equipped_outfits: { head: 'pig_star_hat' },
  }), null)
  assert.equal(getDressedOutfitKey('unknown', 'idle', {}), null)
})

test('painted jump airtime is retained without lifting a ground shadow twice', () => {
  const frames = Array.from({ length: 30 }, (_, index) => ({
    x: (index % 6) * 200, y: Math.floor(index / 6) * 200, width: 150, height: 170,
  }))
  const sprite = { width: 1200, height: 1000, frames, src: 'dressed.png' }
  const grounded = createDressedAnimation(sprite, 'jump', 'scarf__none__none')
  assert.equal(grounded.geometry.frameLifts[7], 0)
  frames[7] = { ...frames[7], height: 135 }
  const airborne = createDressedAnimation(sprite, 'jump', 'scarf__none__none')
  assert.equal(airborne.geometry.frameLifts[7], 35)
  const middle = getAtlasFrameLayout(airborne, 2)
  assert.ok(middle.y + middle.height < 122)
})

for (const pet of ['pig', 'cat', 'dog']) {
  test(`${pet} has complete painted costumes for all 17 combinations and 10 actions`, () => {
    const directory = new URL(`../../frontend/src/assets/pets/${pet}/outfits/${pet === 'pig' ? 'dressed/' : ''}`, import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
    assert.equal(manifest.petType, pet)
    assert.deepEqual(manifest.actions, DRESSED_ACTIONS)
    assert.deepEqual(Object.keys(manifest.variants).sort(), [...DRESSED_OUTFIT_KEYS].sort())
    assert.deepEqual(Object.keys(manifest.sprites).sort(), [...DRESSED_OUTFIT_KEYS].sort())
    for (const key of DRESSED_OUTFIT_KEYS) {
      const variant = manifest.variants[key]
      const sprite = manifest.sprites[key]
      const png = readFileSync(new URL(variant.file, directory))
      assert.equal(createHash('sha256').update(png).digest('hex'), variant.sha256, `${key} image changed after audit`)
      assert.equal(png.readUInt32BE(16), sprite.width)
      assert.equal(png.readUInt32BE(20), sprite.height)
      assert.equal(png[25], 6, 'costumes must preserve RGBA transparency')
      assert.equal(sprite.frames.length, 30)
      assert.deepEqual(sprite.frames, variant.frames)
      assert.equal(variant.frameHashes.length, 30)
      assert.ok(variant.alphaZeroFraction > 0 && variant.alphaZeroFraction < 1)
      for (let action = 0; action < 10; action++) {
        assert.equal(new Set(variant.frameHashes.slice(action * 3, action * 3 + 3)).size, 3, `${key}/${DRESSED_ACTIONS[action]} needs three separate poses`)
      }
      for (const rect of sprite.frames) {
        for (const value of Object.values(rect)) assert.ok(Number.isFinite(value))
        assert.ok(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0)
        assert.ok(rect.x + rect.width <= sprite.width && rect.y + rect.height <= sprite.height)
        for (const other of sprite.frames) {
          if (rect === other) continue
          const overlaps = Math.min(rect.x + rect.width, other.x + other.width) > Math.max(rect.x, other.x)
            && Math.min(rect.y + rect.height, other.y + other.height) > Math.max(rect.y, other.y)
          assert.equal(overlaps, false, `${key} source crop includes a neighboring frame`)
        }
      }
      for (const action of Object.values(ANIMATION_ACTIONS)) {
        const animation = createDressedAnimation({ ...sprite, src: variant.file }, action, key)
        assert.ok(new Set(animation.frameIndices).size >= 3)
        assert.equal(animation.outfitKey, key)
        for (let frame = 0; frame < animation.frameCount; frame++) {
          const layout = getAtlasFrameLayout(animation, frame)
          assert.ok(layout.x >= 0 && layout.y >= 0, `${key}/${action} clips top or left`)
          assert.ok(layout.x + layout.width <= 126 && layout.y + layout.height <= 126, `${key}/${action} clips bottom or right`)
        }
        assert.deepEqual(getAtlasFrameLayout(animation, 100), getAtlasFrameLayout(animation, 0))
      }
    }
  })
}
