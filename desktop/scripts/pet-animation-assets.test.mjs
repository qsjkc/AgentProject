import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SHA256 = /^[a-f0-9]{64}$/
const ROW_ACTIONS = {
  core: ['idle', 'walk', 'jump', 'happy', 'confused'],
  care: ['reminding', 'sleeping', 'pat', 'eat', 'clean'],
}

function assetUrl(petType, file) {
  return new URL(`../../frontend/src/assets/pets/${petType}/animations/${file}`, import.meta.url)
}

function readManifest(petType) {
  return JSON.parse(readFileSync(assetUrl(petType, 'manifest.json'), 'utf8'))
}

function assertRectInside(rect, outer, label) {
  assert.ok(rect && typeof rect === 'object', label)
  for (const field of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isInteger(rect[field]), `${label}.${field} must be an integer`)
  }
  assert.ok(rect.width > 0 && rect.height > 0, `${label} must have positive area`)
  assert.ok(rect.x >= outer.x && rect.y >= outer.y, `${label} starts outside its owner`)
  assert.ok(rect.x + rect.width <= outer.x + outer.width, `${label} crosses its owner's right edge`)
  assert.ok(rect.y + rect.height <= outer.y + outer.height, `${label} crosses its owner's bottom edge`)
}

function rectsOverlap(left, right) {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y)
}

for (const petType of ['cat', 'dog']) {
  test(`${petType} animation atlas files match the audited manifest and PNG dimensions`, () => {
    const manifest = readManifest(petType)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.petType, petType)
    assert.equal(manifest.alphaVisibilityThreshold, 32)
    assert.equal(manifest.renderReferenceSize, 126)
    assert.equal(Boolean(manifest.requiresSourceRects), petType === 'dog')
    assert.deepEqual(Object.keys(manifest.sheets).sort(), ['care', 'core'])

    for (const [sheetId, actions] of Object.entries(ROW_ACTIONS)) {
      const sheet = manifest.sheets[sheetId]
      assert.equal(sheet.file, `${sheetId}-atlas.png`)
      const png = readFileSync(assetUrl(petType, sheet.file))
      assert.match(sheet.sha256, SHA256)
      assert.equal(createHash('sha256').update(png).digest('hex'), sheet.sha256, `${sheet.file} changed without a matching asset audit`)
      assert.ok(png.length >= 33)
      assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE)
      assert.equal(png.readUInt32BE(8), 13, 'PNG must begin with a standard IHDR chunk')
      assert.equal(png.toString('ascii', 12, 16), 'IHDR')
      assert.equal(png.readUInt32BE(16), sheet.width)
      assert.equal(png.readUInt32BE(20), sheet.height)
      assert.equal(png[24], 8, 'sprites use 8-bit color channels')
      assert.equal(png[25], 6, 'PNG color type 6 supplies RGBA, including alpha')
      assert.equal(png[26], 0)
      assert.equal(png[27], 0)
      assert.ok([0, 1].includes(png[28]))
      assert.equal(sheet.mode, 'RGBA')
      assert.equal(sheet.columns, 6)
      assert.equal(sheet.rows, 5)
      assert.equal(sheet.width, 6 * sheet.cellWidth)
      assert.equal(sheet.height, 5 * sheet.cellHeight)
      assert.ok(Number.isInteger(sheet.cellWidth) && sheet.cellWidth > 1)
      assert.equal(sheet.cellWidth, sheet.cellHeight)
      assert.deepEqual(sheet.rowActions, actions)
      assert.equal(Boolean(sheet.requiresSourceRects), petType === 'dog')
      if (manifest.requiresSourceRects) {
        assert.equal(sheet.layout, 'source-rects')
        assert.equal(sheet.alpha.connectedSubjectCount, 30)
      }

      // These are reviewed pixel measurements, not pixels decoded by this test.
      // The complete PNG digest above binds the checked-in measurements to the
      // exact audited image; replacing it with static art invalidates that digest.
      assert.equal(sheet.alpha.minimum, 0)
      assert.equal(sheet.alpha.maximum, 255)
      assert.ok(sheet.alpha.zeroPixelFraction > 0 && sheet.alpha.zeroPixelFraction < 1)
      const expectedLines = [
        ...Array.from({ length: 5 }, (_, index) => `x:${(index + 1) * sheet.cellWidth}`),
        ...Array.from({ length: 4 }, (_, index) => `y:${(index + 1) * sheet.cellHeight}`),
      ]
      assert.deepEqual(sheet.alpha.gridLines.map((line) => `${line.axis}:${line.position}`).sort(), expectedLines.sort())
      for (const line of sheet.alpha.gridLines) {
        assert.ok(Number.isInteger(line.visiblePixelCount) && line.visiblePixelCount >= 0)
        assert.ok(Number.isInteger(line.maxAlpha) && line.maxAlpha >= 0 && line.maxAlpha <= 255)
        // The dog atlas intentionally uses measured source rectangles. Its
        // nominal grid is metadata for action order, not a valid crop boundary.
        if (!manifest.requiresSourceRects) {
          assert.equal(line.visiblePixelCount, 0, `${sheet.file} has recorded artwork crossing a frame boundary`)
          assert.ok(line.maxAlpha <= manifest.alphaVisibilityThreshold)
        }
      }
    }
  })

  test(`${petType} audited animation frames cover every action without duplicated frame hashes or invalid crops`, () => {
    const manifest = readManifest(petType)
    assert.deepEqual(Object.keys(manifest.actions).sort(), Object.values(ROW_ACTIONS).flat().sort())
    const allFrameHashes = []

    for (const [sheetId, actionNames] of Object.entries(ROW_ACTIONS)) {
      const sheet = manifest.sheets[sheetId]
      const imageRect = { x: 0, y: 0, width: sheet.width, height: sheet.height }
      const sheetFrames = actionNames.flatMap((name) => manifest.actions[name].frames)
      actionNames.forEach((actionName, row) => {
        const action = manifest.actions[actionName]
        const label = `${petType}/${actionName}`
        assert.equal(action.sheet, sheetId, label)
        assert.equal(action.row, row, label)
        assert.equal(action.frameStart, row * 6, label)
        assert.equal(action.frameCount, 6, label)
        assert.equal(action.uniqueFrameCount, 6, label)
        assert.equal(action.frames.length, 6, label)
        assert.equal(action.frameRects.length, 6, label)
        const frameHashes = []

        action.frames.forEach((frame, column) => {
          const frameLabel = `${label}/${column}`
          // Dog measurements number frames within each action; the cat audit
          // numbers them within the atlas. frameStart provides the common index.
          assert.equal(frame.frameIndex, manifest.requiresSourceRects ? column : row * 6 + column, frameLabel)
          assert.deepEqual(frame.cellRect, {
            x: column * sheet.cellWidth, y: row * sheet.cellHeight,
            width: sheet.cellWidth, height: sheet.cellHeight,
          }, frameLabel)
          assertRectInside(frame.cellRect, imageRect, frameLabel)
          const bounds = frame.visibleBoundsInCell
          assert.ok(Array.isArray(bounds) && bounds.length === 4, frameLabel)
          const [left, top, right, bottom] = bounds
          assert.deepEqual(frame.visibleSourceRect, {
            x: frame.cellRect.x + left, y: frame.cellRect.y + top,
            width: right - left, height: bottom - top,
          }, frameLabel)
          const cropOwner = manifest.requiresSourceRects ? imageRect : frame.cellRect
          assertRectInside(frame.visibleSourceRect, cropOwner, frameLabel)
          assertRectInside(frame.safeSourceRect, cropOwner, frameLabel)
          assertRectInside(frame.visibleSourceRect, frame.safeSourceRect, frameLabel)
          assert.deepEqual(action.frameRects[column], frame.safeSourceRect, frameLabel)
          for (const other of sheetFrames) {
            if (other !== frame) {
              assert.equal(rectsOverlap(frame.safeSourceRect, other.visibleSourceRect), false, `${frameLabel} includes a neighboring subject`)
            }
          }
          assert.deepEqual(frame.boundsAt126px, bounds.map((value) => Number((value * 126 / sheet.cellWidth).toFixed(3))), frameLabel)
          assert.match(frame.sha256, SHA256, frameLabel)
          frameHashes.push(frame.sha256)
        })

        assert.equal(new Set(frameHashes).size, 6, `${label} requires six separately audited poses`)
        const bottoms = action.frames.map((frame) => frame.visibleBoundsInCell[3]).sort((left, right) => left - right)
        // The dog audit records a median baseline to avoid action outliers;
        // the uniform cat atlas records its maximum visible bottom.
        const baseline = manifest.requiresSourceRects ? (bottoms[2] + bottoms[3]) / 2 : bottoms.at(-1)
        const groundBaseline = baseline * 126 / sheet.cellHeight
        assert.equal(action.groundBaselineAt126px, Number(groundBaseline.toFixed(3)), label)
        allFrameHashes.push(...frameHashes)
      })
    }
    assert.equal(new Set(allFrameHashes).size, 60, 'each pet has sixty individually audited RGBA frames')
  })
}

test('cat and dog atlas files have distinct audited image identities', () => {
  const hashes = ['cat', 'dog'].flatMap((petType) => (
    Object.values(readManifest(petType).sheets).map((sheet) => sheet.sha256)
  ))
  assert.equal(hashes.length, 4)
  assert.equal(new Set(hashes).size, 4)
})
