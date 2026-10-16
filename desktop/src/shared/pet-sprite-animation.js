const CORE_ROWS = ['idle', 'walk', 'jump', 'happy', 'confused']
const CARE_ROWS = ['reminding', 'sleeping', 'pat', 'eat', 'clean']
const ALIASES = {
  wake: 'happy', poke: 'jump', drag: 'walk', dress_up: 'idle',
  run: 'walk', stretch: 'idle', look_around: 'confused', yawn: 'sleeping',
  welcome_back: 'happy', level_up: 'happy',
}
const DURATIONS = { run: 72, stretch: 145, look_around: 165, yawn: 175, welcome_back: 92, level_up: 92 }

export function createAtlasGeometry(sheets, actions) {
  return Object.fromEntries(Object.entries({ core: CORE_ROWS, care: CARE_ROWS }).map(([sheet, rows]) => {
    const frameRects = rows.flatMap((action) => actions[action].frameRects)
    const jumpBottom = sheet === 'core'
      ? Math.max(...actions.jump.frameRects.map((rect) => rect.y + rect.height)) : 0
    return [sheet, {
      width: sheets[sheet].width, height: sheets[sheet].height, frameRects,
      // One scale for every pose preserves body proportions; retain jump airtime.
      scale: 0.46,
      frameLifts: frameRects.map((rect, index) => sheet === 'core' && index >= 12 && index < 18
        ? jumpBottom - rect.y - rect.height : 0),
    }]
  }))
}

export function getCompanionSpriteAnimation(atlases, action) {
  const sourceAction = ALIASES[action] || action
  const careRow = CARE_ROWS.indexOf(sourceAction)
  const row = careRow >= 0 ? careRow : Math.max(0, CORE_ROWS.indexOf(sourceAction))
  const frameIndices = Array.from({ length: 6 }, (_, frame) => row * 6 + frame)
  // Preserve the duration of the companion events while playing real poses.
  if (action === 'run' || action === 'stretch') frameIndices.push(row * 6 + 4, row * 6 + 3)
  if (action === 'welcome_back') frameIndices.push(row * 6)
  if (action === 'level_up') frameIndices.splice(2, 4, 12, 13, 14, 15, 16, 17, row * 6 + 4, row * 6 + 5)
  const geometry = atlases.geometry?.[careRow >= 0 ? 'care' : 'core']
  return {
    type: geometry ? 'atlas' : 'sprite', src: careRow >= 0 ? atlases.care : atlases.core,
    geometry,
    rowOffsets: careRow >= 0 ? atlases.careRowOffsets : atlases.coreRowOffsets,
    columns: 6, rows: 5, frameIndices, frameCount: frameIndices.length,
    frameDuration: DURATIONS[action] || 110,
  }
}

export function getAtlasFrameLayout(animation, index) {
  const current = index >= 0 && index < animation.frameCount ? index : 0
  const frame = animation.frameIndices[current]
  const { frameRects, frameLifts, scale } = animation.geometry
  const rect = frameRects[frame]
  const width = rect.width * scale
  const height = rect.height * scale
  return { rect, width, height, x: (126 - width) / 2, y: 122 - height - frameLifts[frame] * scale }
}

export function getSpriteFrameOffset(animation, index) {
  const current = index >= 0 && index < animation.frameCount ? index : 0
  const frame = animation.frameIndices?.[current] ?? current
  return animation.rowOffsets?.[Math.floor(frame / animation.columns)] || 0
}

export function getSpriteFramePosition(animation, index) {
  // An action can change before the playback effect resets its previous index.
  const current = index >= 0 && index < animation.frameCount ? index : 0
  const frame = animation.frameIndices?.[current] ?? current
  const column = frame % animation.columns
  const row = Math.floor(frame / animation.columns)
  return {
    x: animation.columns > 1 ? column / (animation.columns - 1) * 100 : 0,
    y: animation.rows > 1 ? row / (animation.rows - 1) * 100 : 0,
  }
}
