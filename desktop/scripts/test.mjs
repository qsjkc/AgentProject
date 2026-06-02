import assert from 'node:assert/strict'

import { normalizeApiBaseUrl } from '../src/shared/api-base-url.js'
import { getPetMessagePool, normalizeLanguage, t } from '../src/shared/i18n.js'
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
assert.equal(DEFAULT_VOICE_SETTINGS.desktop_voice_output_mode, VOICE_OUTPUT_MODES.TEXT_ONLY)

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

console.log('desktop tests passed')
