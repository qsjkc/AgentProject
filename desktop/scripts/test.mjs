import assert from 'node:assert/strict'

import { normalizeApiBaseUrl } from '../src/shared/api-base-url.js'
import { getPetMessagePool, normalizeLanguage, t } from '../src/shared/i18n.js'
import { normalizeSubtitleItems, stripMarkdown, truncateForPetBubble } from '../src/shared/voice-format.js'
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

const authError = createVoiceAuthError()
assert.equal(authError.code, VOICE_AUTH_ERROR_CODE)
assert.equal(isVoiceAuthError(authError), true)
assert.equal(isVoiceAuthError(new Error('Could not validate credentials')), true)
assert.equal(isVoiceAuthError(new Error('other error')), false)

console.log('desktop tests passed')
