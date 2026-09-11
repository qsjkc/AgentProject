import assert from 'node:assert/strict'

import { normalizeApiBaseUrl } from '../src/shared/api-base-url.js'
import { getPetMessagePool, normalizeLanguage, t } from '../src/shared/i18n.js'
import {
  ANIMATION_ACTIONS,
  createInitialPetAnimationState,
  isLoopingPetAnimation,
  petAnimationReducer,
} from '../src/shared/pet-animation-state.js'
import { getPetCareActions, getPetCareToolbarLabel } from '../src/shared/pet-care-actions.js'
import { getPetRelationshipEventCopy } from '../src/shared/pet-personality.js'
import {
  createRewardIdempotencyKey,
  didEquippedOutfitChange,
  getRelationshipStageLabel,
  normalizePetRelationship,
} from '../src/shared/pet-relationship.js'
import {
  getPetOutfitCatalog,
  getPetOutfitSlotLabel,
  normalizePetOutfitState,
} from '../src/shared/pet-outfits.js'
import { parseOneTimeReminder } from '../src/shared/reminder-parser.js'
import {
  decodeRtsSubtitlePayload,
  normalizeRtsSubtitleItems,
  normalizeSubtitleItems,
  stripMarkdown,
  truncateForPetBubble,
} from '../src/shared/voice-format.js'
import { createVoiceAuthError, isVoiceAuthError, VOICE_AUTH_ERROR_CODE } from '../src/shared/voice-errors.js'
import {
  createInitialVoiceUiState,
  DEFAULT_VOICE_SETTINGS,
  normalizeVoiceSettings,
  VOICE_OUTPUT_MODES,
  VOICE_PHASES,
  voiceStateReducer,
} from '../src/shared/voice-state.js'

assert.equal(normalizeApiBaseUrl('detachym.top'), 'http://detachym.top/api/v1')
assert.equal(normalizeApiBaseUrl('https://detachym.top/api'), 'https://detachym.top/api/v1')
assert.equal(normalizeApiBaseUrl('https://detachym.top/api/v2/'), 'https://detachym.top/api/v2')

assert.equal(normalizeLanguage('zh'), 'zh-CN')
assert.equal(normalizeLanguage('en-US'), 'en')

assert.equal(t('en', 'welcomeUser', { username: 'Alice' }), 'Welcome, Alice')
assert.notEqual(t('zh-CN', 'welcomeUser', { username: 'Alice' }), 'welcomeUser')

assert.ok(getPetMessagePool('zh-CN', 'cat', 'TapMessages').length > 0)
assert.ok(getPetMessagePool('en', 'dog', 'IdleMessages').length > 0)

const normalizedVoiceSettings = normalizeVoiceSettings({
  desktop_voice_output_mode: VOICE_OUTPUT_MODES.VOICE_AND_TEXT,
  desktop_voice_idle_timeout_seconds: 12,
})
assert.equal(normalizedVoiceSettings.desktop_voice_output_mode, VOICE_OUTPUT_MODES.VOICE_AND_TEXT)
assert.equal(normalizedVoiceSettings.desktop_voice_idle_timeout_seconds, 12)
assert.equal(normalizedVoiceSettings.desktop_voice_global_shortcut, DEFAULT_VOICE_SETTINGS.desktop_voice_global_shortcut)
assert.equal(DEFAULT_VOICE_SETTINGS.desktop_voice_output_mode, VOICE_OUTPUT_MODES.VOICE_AND_TEXT)
assert.equal(DEFAULT_VOICE_SETTINGS.desktop_voice_global_shortcut, 'CommandOrControl+Alt+D')
assert.equal(
  normalizeVoiceSettings({ desktop_voice_global_shortcut: 'CommandOrControl+Shift+Space' }).desktop_voice_global_shortcut,
  'CommandOrControl+Shift+Space',
)
assert.equal(normalizeVoiceSettings({ desktop_voice_enabled: false }).desktop_voice_enabled, false)

const initialVoiceState = createInitialVoiceUiState()
const armedState = voiceStateReducer(initialVoiceState, {
  type: 'VOICE_ARMED',
  bubbleText: 'hold D',
})
assert.equal(armedState.phase, VOICE_PHASES.VOICE_ARMED)
const listeningState = voiceStateReducer(armedState, {
  type: 'VOICE_LISTENING',
  bubbleText: 'listening',
})
assert.equal(listeningState.phase, VOICE_PHASES.LISTENING)
const replyState = voiceStateReducer(listeningState, {
  type: 'VOICE_REPLYING',
  bubbleText: 'reply',
  replyText: 'reply',
})
assert.equal(replyState.phase, VOICE_PHASES.REPLYING)
assert.equal(replyState.lastReplyText, 'reply')

assert.equal(stripMarkdown('**bold** `code` [link](https://example.com)'), 'bold code link')
assert.ok(truncateForPetBubble('a'.repeat(120), 'en').includes('Open the main panel'))

const subtitleItems = normalizeSubtitleItems([
  {
    userId: 'ai-user',
    text: '你好',
    definite: true,
    sequence: 1,
  },
  {
    streamKey: { userId: 'local-user' },
    content: '测试',
    final: false,
    sequence: 2,
  },
])
assert.equal(subtitleItems.length, 2)
assert.equal(subtitleItems[0].speakerId, 'ai-user')
assert.equal(subtitleItems[0].isFinal, true)
assert.equal(subtitleItems[1].speakerId, 'local-user')
assert.equal(subtitleItems[1].isFinal, false)

const nestedSubtitleItems = normalizeSubtitleItems([
  {
    speaker: { userId: 'ai-user' },
    result: {
      text: 'reply text',
      definite: true,
      sequence: 9,
    },
  },
  {
    stream_key: { user_id: 'local-user' },
    subtitle: {
      text: 'local text',
      definite: false,
      sequence: 10,
    },
  },
])
assert.equal(nestedSubtitleItems.length, 2)
assert.equal(nestedSubtitleItems[0].speakerId, 'ai-user')
assert.equal(nestedSubtitleItems[0].isFinal, true)
assert.equal(nestedSubtitleItems[0].sequence, 9)
assert.equal(nestedSubtitleItems[1].speakerId, 'local-user')
assert.equal(nestedSubtitleItems[1].isFinal, false)

const rtsSubtitleJson = JSON.stringify([
  {
    userId: 'ai-user',
    text: 'final reply',
    definite: true,
    sequence: 11,
  },
])
const rtsSubtitleBytes = new TextEncoder().encode(rtsSubtitleJson)
const rtsSubtitlePayload = new Uint8Array(8 + rtsSubtitleBytes.byteLength)
rtsSubtitlePayload[0] = 's'.charCodeAt(0)
rtsSubtitlePayload[1] = 'u'.charCodeAt(0)
rtsSubtitlePayload[2] = 'b'.charCodeAt(0)
rtsSubtitlePayload[3] = 'v'.charCodeAt(0)
new DataView(rtsSubtitlePayload.buffer).setUint32(4, rtsSubtitleBytes.byteLength, false)
rtsSubtitlePayload.set(rtsSubtitleBytes, 8)

assert.deepEqual(decodeRtsSubtitlePayload(rtsSubtitlePayload.buffer), JSON.parse(rtsSubtitleJson))
const rtsSubtitleItems = normalizeRtsSubtitleItems(rtsSubtitlePayload)
assert.equal(rtsSubtitleItems.length, 1)
assert.equal(rtsSubtitleItems[0].speakerId, 'ai-user')
assert.equal(rtsSubtitleItems[0].isFinal, true)
assert.equal(rtsSubtitleItems[0].text, 'final reply')

const wrappedRtsSubtitleJson = JSON.stringify({
  type: 'subtitle',
  data: [
    {
      UserId: 'ai-user',
      Text: 'wrapped final reply',
      Definite: true,
      Sequence: 12,
    },
  ],
})
const wrappedRtsSubtitleBytes = new TextEncoder().encode(wrappedRtsSubtitleJson)
const wrappedRtsSubtitlePayload = new Uint8Array(8 + wrappedRtsSubtitleBytes.byteLength)
wrappedRtsSubtitlePayload[0] = 's'.charCodeAt(0)
wrappedRtsSubtitlePayload[1] = 'u'.charCodeAt(0)
wrappedRtsSubtitlePayload[2] = 'b'.charCodeAt(0)
wrappedRtsSubtitlePayload[3] = 'v'.charCodeAt(0)
new DataView(wrappedRtsSubtitlePayload.buffer).setUint32(4, wrappedRtsSubtitleBytes.byteLength, true)
wrappedRtsSubtitlePayload.set(wrappedRtsSubtitleBytes, 8)

const wrappedRtsSubtitleItems = normalizeRtsSubtitleItems(wrappedRtsSubtitlePayload.buffer)
assert.equal(wrappedRtsSubtitleItems.length, 1)
assert.equal(wrappedRtsSubtitleItems[0].speakerId, 'ai-user')
assert.equal(wrappedRtsSubtitleItems[0].isFinal, true)
assert.equal(wrappedRtsSubtitleItems[0].sequence, 12)
assert.equal(wrappedRtsSubtitleItems[0].text, 'wrapped final reply')

const authError = createVoiceAuthError()
assert.equal(authError.code, VOICE_AUTH_ERROR_CODE)
assert.equal(isVoiceAuthError(authError), true)
assert.equal(isVoiceAuthError(new Error('Could not validate credentials')), true)
assert.equal(isVoiceAuthError(new Error('other error')), false)

const initialPetAnimation = createInitialPetAnimationState()
assert.equal(initialPetAnimation.action, ANIMATION_ACTIONS.IDLE)
assert.deepEqual(
  new Set(Object.values(ANIMATION_ACTIONS)),
  new Set([
    'idle',
    'walk',
    'jump',
    'happy',
    'confused',
    'reminding',
    'sleeping',
    'wake',
    'poke',
    'drag',
    'pat',
    'eat',
    'clean',
    'dress_up',
    'level_up',
  ]),
)
assert.equal(isLoopingPetAnimation(ANIMATION_ACTIONS.IDLE), true)
assert.equal(isLoopingPetAnimation(ANIMATION_ACTIONS.SLEEPING), true)
assert.equal(isLoopingPetAnimation(ANIMATION_ACTIONS.WAKE), false)

const remindingPetAnimation = petAnimationReducer(initialPetAnimation, {
  type: 'REMINDER_DUE',
  message: '15:00 meeting',
})
assert.equal(remindingPetAnimation.action, ANIMATION_ACTIONS.REMINDING)
assert.equal(remindingPetAnimation.locked, true)

const ignoredIdle = petAnimationReducer(remindingPetAnimation, { type: 'IDLE_TICK' })
assert.equal(ignoredIdle.action, ANIMATION_ACTIONS.REMINDING)

const released = petAnimationReducer(remindingPetAnimation, { type: 'ANIMATION_DONE' })
assert.equal(released.action, ANIMATION_ACTIONS.IDLE)
assert.equal(released.locked, false)

const confused = petAnimationReducer(initialPetAnimation, { type: 'REMINDER_PARSE_FAILED' })
assert.equal(confused.action, ANIMATION_ACTIONS.CONFUSED)

const normalizedRelationship = normalizePetRelationship({
  pet_type: 'pig',
  intimacy_xp: 145,
  level: 2,
  relationship_stage: 'getting_familiar',
  current_mood: 'idle',
  progress: {
    current: 45,
    required: 160,
    percent: 28.12,
  },
})
assert.equal(normalizedRelationship.pet_type, 'pig')
assert.equal(normalizedRelationship.level, 2)
assert.deepEqual(normalizedRelationship.progress, {
  current: 45,
  required: 160,
  percent: 28.12,
})
assert.equal(getRelationshipStageLabel('zh-CN', 'getting_familiar'), '有点熟')
assert.equal(getRelationshipStageLabel('en', 'deep_bond'), 'Deeply bonded')
assert.match(createRewardIdempotencyKey('pig', 'poke'), /^pet:pig:poke:/)
assert.deepEqual(
  getPetOutfitCatalog('pig', 'zh-CN').map(({ id, slot, unlockLevel, label }) => ({
    id,
    slot,
    unlockLevel,
    label,
  })),
  [
    { id: 'pig_basic_scarf', slot: 'neck', unlockLevel: 1, label: '基础小围巾' },
    { id: 'pig_sleep_cap', slot: 'head', unlockLevel: 2, label: '软绵睡帽' },
    { id: 'pig_bell', slot: 'side', unlockLevel: 3, label: '提醒铃铛' },
    { id: 'pig_work_badge', slot: 'side', unlockLevel: 4, label: '搭档工作牌' },
    { id: 'pig_star_hat', slot: 'head', unlockLevel: 5, label: '星星小帽' },
  ],
)
assert.equal(getPetOutfitSlotLabel('neck', 'en'), 'Neck')
assert.deepEqual(
  normalizePetOutfitState(
    {
      unlocked_outfit_ids: ['pig_basic_scarf', 'unknown'],
      equipped_outfits: {
        neck: 'pig_basic_scarf',
        head: 'pig_star_hat',
      },
    },
    'pig',
    2,
  ),
  {
    unlocked_outfit_ids: ['pig_basic_scarf', 'pig_sleep_cap'],
    equipped_outfits: {
      neck: 'pig_basic_scarf',
    },
  },
)

const levelUpAnimation = petAnimationReducer(initialPetAnimation, { type: 'LEVEL_UP' })
assert.equal(levelUpAnimation.action, ANIMATION_ACTIONS.LEVEL_UP)
assert.equal(levelUpAnimation.locked, true)

const draggingAnimation = petAnimationReducer(initialPetAnimation, { type: 'PET_DRAG_START' })
assert.equal(draggingAnimation.action, ANIMATION_ACTIONS.DRAG)
const dragReleasedAnimation = petAnimationReducer(draggingAnimation, { type: 'PET_DRAG_RELEASE' })
assert.equal(dragReleasedAnimation.action, ANIMATION_ACTIONS.HAPPY)

assert.equal(
  petAnimationReducer(initialPetAnimation, { type: 'PET_CLICK' }).action,
  ANIMATION_ACTIONS.POKE,
)
assert.equal(
  petAnimationReducer(initialPetAnimation, { type: 'PET_DRESS_UP' }).action,
  ANIMATION_ACTIONS.DRESS_UP,
)
const sleepingAnimation = petAnimationReducer(initialPetAnimation, { type: 'SLEEP' })
assert.equal(
  petAnimationReducer(sleepingAnimation, { type: 'WAKE' }).action,
  ANIMATION_ACTIONS.WAKE,
)
assert.equal(
  petAnimationReducer(initialPetAnimation, { type: 'WAKE' }).action,
  ANIMATION_ACTIONS.IDLE,
)

assert.equal(
  petAnimationReducer(initialPetAnimation, { type: 'PET_PAT' }).action,
  ANIMATION_ACTIONS.PAT,
)
assert.equal(
  petAnimationReducer(initialPetAnimation, { type: 'PET_FEED' }).action,
  ANIMATION_ACTIONS.EAT,
)
assert.equal(
  petAnimationReducer(initialPetAnimation, { type: 'PET_CLEAN' }).action,
  ANIMATION_ACTIONS.CLEAN,
)

const pigCareActions = getPetCareActions('zh-CN', 'pig')
assert.deepEqual(
  pigCareActions.map(({ id, animationEvent, rewardAction }) => ({
    id,
    animationEvent,
    rewardAction,
  })),
  [
    { id: 'pat', animationEvent: 'PET_PAT', rewardAction: 'pat' },
    { id: 'feed', animationEvent: 'PET_FEED', rewardAction: 'feed' },
    { id: 'clean', animationEvent: 'PET_CLEAN', rewardAction: 'clean' },
  ],
)
assert.equal(pigCareActions[0].label, '摸摸')
assert.match(pigCareActions[1].message, /小饼干/)
assert.equal(getPetCareActions('zh-CN', 'cat').length, 0)
assert.equal(getPetCareToolbarLabel('en'), 'Care for pig')
assert.match(getPetRelationshipEventCopy('pig', 'zh-CN', 'wake'), /醒啦/)
assert.match(
  getPetRelationshipEventCopy('pig', 'zh-CN', 'level_up', { level: 4 }),
  /Lv\.4/,
)
assert.equal(
  didEquippedOutfitChange(
    { outfit: { equipped_outfits: { neck: 'pig_basic_scarf' } } },
    { outfit: { equipped_outfits: { neck: 'pig_basic_scarf' } } },
  ),
  false,
)
assert.equal(
  didEquippedOutfitChange(
    { outfit: { equipped_outfits: { neck: 'pig_basic_scarf' } } },
    { outfit: { equipped_outfits: { head: 'pig_sleep_cap' } } },
  ),
  true,
)

const fixedNow = new Date('2026-07-06T10:00:00+08:00')

const todayMeeting = parseOneTimeReminder('下午三点有一个会议', fixedNow)
assert.equal(todayMeeting.ok, true)
assert.equal(todayMeeting.title, '开会')
assert.equal(todayMeeting.remindAt.getTime(), new Date('2026-07-06T15:00:00+08:00').getTime())

const tomorrowTask = parseOneTimeReminder('明早九点交材料', fixedNow)
assert.equal(tomorrowTask.ok, true)
assert.equal(tomorrowTask.title, '交材料')
assert.equal(tomorrowTask.remindAt.getTime(), new Date('2026-07-07T09:00:00+08:00').getTime())

const unclear = parseOneTimeReminder('提醒我一下', fixedNow)
assert.equal(unclear.ok, false)
assert.equal(unclear.reason, 'missing_time')

const afternoonGreeting = parseOneTimeReminder('下午好', fixedNow)
assert.equal(afternoonGreeting.ok, false)
assert.equal(afternoonGreeting.reason, 'not_reminder')

const tomorrowQuestion = parseOneTimeReminder('明天有哪些计划？', fixedNow)
assert.equal(tomorrowQuestion.ok, false)
assert.equal(tomorrowQuestion.reason, 'not_reminder')

console.log('desktop tests passed')
