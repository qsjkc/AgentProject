import assert from 'node:assert/strict'
import test from 'node:test'

import { createVoiceAuthError, isVoiceAuthError } from '../src/shared/voice-errors.js'

test('voice permission and provider errors do not expire the application login', () => {
  assert.equal(isVoiceAuthError(Object.assign(new Error('Unauthorized voice feature'), { status: 403 })), false)
  assert.equal(isVoiceAuthError(new Error('403 Forbidden')), false)
  assert.equal(isVoiceAuthError(new Error('Provider error 1401')), false)
})

test('voice authentication failures remain recognizable', () => {
  assert.equal(isVoiceAuthError(createVoiceAuthError()), true)
  assert.equal(isVoiceAuthError(Object.assign(new Error('Expired'), { status: 401 })), true)
  assert.equal(isVoiceAuthError(new Error('Could not validate credentials')), true)
})
