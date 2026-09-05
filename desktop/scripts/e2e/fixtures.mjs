const HOUR_MS = 60 * 60 * 1000

export const E2E_PROTOCOL_VERSION = 1
export const CAPABILITY_TTL_MS = 30_000

export const USERS = Object.freeze({
  A: Object.freeze({
    id: 101,
    username: 'p1k-a',
    email: 'p1k-a@example.test',
    password: 'p1k-password-a',
  }),
  B: Object.freeze({
    id: 202,
    username: 'p1k-b',
    email: 'p1k-b@example.test',
    password: 'p1k-password-b',
  }),
})

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function createJwt(user, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000)
  return [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({
      sub: user.id,
      username: user.username,
      iat: issuedAt,
      exp: issuedAt + 3600,
      e2e: true,
    }),
    'e2e-signature',
  ].join('.')
}

export function decodeJwtSubject(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    const subject = Number(payload.sub)
    return Number.isInteger(subject) && subject > 0 ? subject : null
  } catch {
    return null
  }
}

export function createPreferences(user, petType = 'pig', now = new Date()) {
  return {
    id: user.id + 1_000,
    user_id: user.id,
    pet_type: petType,
    quick_chat_enabled: true,
    bubble_frequency: 120,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }
}

export function createUserResponse(user, preferences, now = new Date()) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    status: 'active',
    is_active: true,
    is_superuser: false,
    created_at: new Date(now.getTime() - HOUR_MS).toISOString(),
    last_login_at: now.toISOString(),
    preferences,
  }
}

export function createRelationship(user, petType = 'pig', now = new Date()) {
  const createdAt = new Date(now.getTime() - HOUR_MS)
  return {
    id: user.id * 10 + (petType === 'pig' ? 3 : petType === 'dog' ? 2 : 1),
    user_id: user.id,
    pet_type: petType,
    intimacy_xp: 0,
    level: 1,
    relationship_stage: 'new_friend',
    current_mood: 'calm',
    progress: { current: 0, required: 100, percent: 0 },
    outfit: { unlocked_outfit_ids: [], equipped_outfits: {} },
    last_active_at: now.toISOString(),
    last_greeting_at: null,
    last_level_up_at: null,
    created_at: createdAt.toISOString(),
    updated_at: now.toISOString(),
  }
}

export function createDailySummary(petType = 'pig', now = new Date()) {
  return {
    pet_type: petType,
    local_date: now.toISOString().slice(0, 10),
    timezone: 'Asia/Shanghai',
    interaction_count: 0,
    xp_gained: 0,
    action_counts: {},
    care_count: 0,
    meaningful_chat_count: 0,
    reminders_created_count: 0,
    reminders_completed_count: 0,
    first_interaction_at: null,
    last_interaction_at: null,
  }
}

export function createWeeklySummary(petType = 'pig') {
  return {
    pet_type: petType,
    review_key: '2026-08-17_2026-08-23',
    week_start: '2026-08-17',
    week_end: '2026-08-23',
    timezone: 'Asia/Shanghai',
    eligible: false,
    is_new: false,
    reviewed_at: null,
    active_days: 0,
    interaction_count: 0,
    xp_gained: 0,
    action_counts: {},
    care_count: 0,
    meaningful_chat_count: 0,
    reminders_created_count: 0,
    reminders_completed_count: 0,
    level_at_start: 1,
    level_at_end: 1,
    levels_gained: 0,
    relationship_stage_at_end: 'new_friend',
    first_interaction_at: null,
    last_interaction_at: null,
  }
}

export function createReminderRecord({
  id,
  user,
  petType = 'pig',
  title = '一分钟后看看小猪',
  sourceText = title,
  remindAt = new Date(Date.now() + 60_000),
  now = new Date(),
} = {}) {
  return {
    id,
    user_id: user.id,
    pet_type: petType,
    title,
    source_text: sourceText,
    remind_at: remindAt.toISOString(),
    status: 'pending',
    triggered_at: null,
    completed_at: null,
    cancellation_source: null,
    series_id: null,
    recurrence_type: 'once',
    occurrence_sequence: null,
    creation_source: 'user',
    email_enabled: false,
    email_status: 'disabled',
    email_sent_at: null,
    email_attempt_count: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }
}

export function createStubFixture(now = new Date()) {
  const accounts = new Map()
  for (const user of Object.values(USERS)) {
    const preferences = createPreferences(user, 'pig', now)
    accounts.set(user.id, {
      user,
      token: createJwt(user, now.getTime()),
      preferences,
      relationshipByPet: new Map([
        ['pig', createRelationship(user, 'pig', now)],
        ['cat', createRelationship(user, 'cat', now)],
        ['dog', createRelationship(user, 'dog', now)],
      ]),
      sessions: [],
      reminders: [],
    })
  }
  return { accounts, nextReminderId: 1, nextSessionId: 1, now }
}

export function mainProcessResetFixture(user = USERS.A) {
  return {
    protocolVersion: E2E_PROTOCOL_VERSION,
    account: {
      token: createJwt(user),
      userId: user.id,
      petType: 'pig',
    },
    relationship: createRelationship(user),
    onboarding: { reset: true },
  }
}
