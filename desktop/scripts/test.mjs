import assert from 'node:assert/strict'

import { normalizeApiBaseUrl } from '../src/shared/api-base-url.js'
import { getPetMessagePool, normalizeLanguage, t } from '../src/shared/i18n.js'

assert.equal(normalizeApiBaseUrl('detachym.top'), 'http://detachym.top/api/v1')
assert.equal(normalizeApiBaseUrl('https://detachym.top/api'), 'https://detachym.top/api/v1')
assert.equal(normalizeApiBaseUrl('https://detachym.top/api/v2/'), 'https://detachym.top/api/v2')

assert.equal(normalizeLanguage('zh'), 'zh-CN')
assert.equal(normalizeLanguage('en-US'), 'en')

assert.equal(t('en', 'welcomeUser', { username: 'Alice' }), 'Welcome, Alice')
assert.notEqual(t('zh-CN', 'welcomeUser', { username: 'Alice' }), 'welcomeUser')

assert.ok(getPetMessagePool('zh-CN', 'cat', 'TapMessages').length > 0)
assert.ok(getPetMessagePool('en', 'dog', 'IdleMessages').length > 0)

console.log('desktop tests passed')
