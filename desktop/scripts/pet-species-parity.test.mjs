import assert from 'node:assert/strict'
import { test } from 'node:test'
import onboarding from '../electron/pet-onboarding-store.cjs'
import playbackStore from '../electron/pet-milestone-playback-store.cjs'
import { getPetCareActions, getPetCareToolbarLabel } from '../src/shared/pet-care-actions.js'
import { getPetCompanionCopy, getPetRelationshipMilestoneCopy } from '../src/shared/pet-personality.js'
import { getPetWeeklyCompanionCopy } from '../src/shared/pet-weekly-summary.js'
import {
  createPetOnboardingContextKey, createPetOnboardingSampleReminderPayload,
  isPetOnboardingStateCurrent, normalizePetOnboardingMainStateResponse,
  selectPetOnboardingStateForContext,
} from '../src/shared/pet-onboarding-main.js'
import {
  getPetOnboardingCopy, isPetOnboardingSafe, normalizePetOnboardingStateResponse,
} from '../src/shared/pet-onboarding-state.js'
import onboardingDto from '../electron/pet-onboarding-dto.cjs'
import {
  createPetMilestonePlaybackState, isPetMilestoneClaimSafe, isPetMilestonePlaybackSafe,
  normalizePetRelationshipMilestone,
} from '../src/shared/pet-milestone-state.js'

const now = new Date('2026-10-15T10:00:00Z')
const token = '62072044-8b44-4ef6-b86c-6c14187c70c7'
const quietContext = {
  hasSession: true, userId: 17, visibilityState: 'visible', systemIdleSeconds: 0,
  voicePhase: 'idle', animationState: { action: 'idle', locked: false }, now,
}

for (const petType of ['pig', 'cat', 'dog']) {
  const otherPet = petType === 'cat' ? 'dog' : 'cat'
  const relationship = { id: 29, user_id: 17, pet_type: petType, level: 1, created_at: now.toISOString() }
  const context = { has_session: true, user_id: 17, pet_type: petType, relationship }

  test(`${petType} onboarding retains independent storage and rejects mismatched pets and accounts`, () => {
    const first = onboarding.readPetOnboardingEntry({ states: {}, context, now })
    assert.equal(first.state.pet_type, petType)
    const key = onboarding.createPetOnboardingKey(17, 29, petType)
    assert.ok(first.states[key])
    const otherContext = { ...context, pet_type: otherPet, relationship: { ...relationship, pet_type: otherPet } }
    const second = onboarding.readPetOnboardingEntry({ states: first.states, context: otherContext, now })
    assert.equal(second.state.pet_type, otherPet)
    assert.deepEqual(second.states[key], first.state)
    assert.equal(Object.keys(second.states).length, 2)
    assert.equal(onboarding.normalizePetOnboardingContext({ ...context, pet_type: otherPet }), null)
    assert.equal(onboarding.normalizePetOnboardingContext({ ...context, user_id: 18 }), null)

    const claimed = onboarding.claimPetOnboardingPresentation(first.state, petType, 'meet_pet', token, now)
    assert.equal(claimed.ok, true)
    assert.equal(onboarding.claimPetOnboardingPresentation(first.state, otherPet, 'meet_pet', token, now).ok, false)
    assert.equal(onboarding.ackPetOnboardingPresentation(claimed.state, otherPet, 'meet_pet', token, now).ok, false)
    assert.equal(onboarding.releasePetOnboardingPresentation(claimed.state, otherPet, 'meet_pet', token, now).ok, false)
    assert.equal(onboarding.ackPetOnboardingPresentation(claimed.state, petType, 'meet_pet', token, now).ok, true)

    const petState = normalizePetOnboardingStateResponse(onboardingDto.projectPetOnboardingStateForPet(first.state))
    const mainState = normalizePetOnboardingMainStateResponse(onboardingDto.projectPetOnboardingStateForMain(first.state))
    assert.equal(petState.pet_type, petType)
    assert.equal(mainState.pet_type, petType)
    const safe = { ...quietContext, petType, relationship, onboardingState: petState }
    assert.equal(isPetOnboardingSafe(safe), true)
    assert.equal(isPetOnboardingSafe({ ...safe, onboardingState: { ...petState, pet_type: otherPet } }), false)
    assert.equal(isPetOnboardingSafe({ ...safe, relationship: { ...relationship, id: 30 } }), false)
    const mainContext = { authenticated: true, petType, userId: 17, relationship, state: mainState, documentVisible: true, now }
    assert.equal(isPetOnboardingStateCurrent(mainContext), true)
    assert.equal(isPetOnboardingStateCurrent({ ...mainContext, state: { ...mainState, pet_type: otherPet } }), false)
    assert.equal(createPetOnboardingContextKey({ userId: 17, relationshipId: 29, petType }), `17:29:${petType}`)
    assert.equal(selectPetOnboardingStateForContext(null, mainState, { userId: 17, relationshipId: 29, petType: otherPet }), null)
    assert.equal(createPetOnboardingSampleReminderPayload('zh-CN', now, petType).pet_type, petType)
    assert.match(getPetOnboardingCopy('meet_pet', 'en', relationship).body, new RegExp(`Give ${petType[0].toUpperCase()}${petType.slice(1)} a pat`))
  })

  test(`${petType} milestones preserve pet and account isolation through claim and persistence`, () => {
    const milestone = normalizePetRelationshipMilestone({ id: 5, pet_type: petType, level: 2, claim_token: token, reward_outfit_id: `${petType}_sleep_cap` })
    assert.equal(milestone.pet_type, petType)
    const playback = createPetMilestonePlaybackState({ petType, claimToken: token, milestone, status: 'playing' })
    assert.equal(playback.pet_type, petType)
    assert.equal(createPetMilestonePlaybackState({ petType: otherPet, claimToken: token, milestone, status: 'playing' }), null)
    const ready = { ...relationship, level: 2, outfit: { unlocked_outfit_ids: [`${petType}_sleep_cap`] } }
    const safe = { ...quietContext, petType, relationship: ready, milestone }
    assert.equal(isPetMilestoneClaimSafe(safe), true)
    assert.equal(isPetMilestonePlaybackSafe(safe), true)
    assert.equal(isPetMilestonePlaybackSafe({ ...safe, milestone: { ...milestone, pet_type: otherPet } }), false)
    assert.equal(isPetMilestoneClaimSafe({ ...safe, relationship: { ...ready, pet_type: otherPet } }), false)
    const result = playbackStore.setPetMilestonePlaybackEntry({ playbackByPet: {}, petType, storageKey: `17:${petType}`, accountUserId: 17, playback, expectedRevision: 0, updatedAt: now.toISOString() })
    assert.equal(result.ok, true)
    assert.equal(playbackStore.isValidPetMilestonePlayback(result.playback, petType, { accountUserId: 17 }), true)
    assert.equal(playbackStore.isValidPetMilestonePlayback(result.playback, otherPet, { accountUserId: 17 }), false)
    assert.equal(playbackStore.isValidPetMilestonePlayback(result.playback, petType, { accountUserId: 18 }), false)
    const otherRead = playbackStore.readPetMilestonePlaybackEntry(result.playbackByPet, otherPet, { storageKey: `17:${otherPet}`, accountUserId: 17 })
    assert.equal(otherRead.playback, null)
    assert.deepEqual(otherRead.playbackByPet, result.playbackByPet)
  })

  test(`${petType} care, companionship, memories and milestone copy use the selected pet`, () => {
    for (const language of ['zh-CN', 'en']) {
      const care = getPetCareActions(language, petType)
      assert.deepEqual(care.map((item) => item.id), ['pat', 'feed', 'clean'])
      assert.ok(care.every((item) => item.message && item.label))
      assert.ok(getPetCareToolbarLabel(language, petType))
      for (const eventType of ['daily_greeting', 'welcome_back', 'proactive_moment']) {
        for (const timeContext of ['morning', 'midday', 'afternoon', 'evening', 'late_night']) {
          const event = { type: eventType, timeContext }
          const copy = getPetCompanionCopy(petType, language, event, relationship)
          assert.ok(copy?.text)
          assert.ok(copy.id.startsWith(`${petType}-`))
          assert.equal(getPetCompanionCopy(petType, language, event, { ...relationship, pet_type: otherPet }), null)
        }
      }
      const event = { type: 'daily_greeting', timeContext: 'morning' }
      const daily = { pet_type: petType, local_date: '2026-10-15', interaction_count: 1, care_count: 1 }
      const memory = getPetCompanionCopy(petType, language, event, relationship, [], daily)
      assert.ok(memory.id.startsWith(`${petType}-memory-`))
      const foreignMemory = getPetCompanionCopy(petType, language, event, relationship, [], { ...daily, pet_type: otherPet })
      assert.equal(foreignMemory.id.includes('-memory-'), false)
      const weekly = { pet_type: petType, eligible: true, is_new: true, review_key: '2026-10-05', interaction_count: 1 }
      assert.ok(getPetWeeklyCompanionCopy(language, weekly).id.startsWith(`${petType}-weekly-`))
      assert.ok(getPetCompanionCopy(petType, language, event, relationship, [], daily, weekly).id.startsWith(`${petType}-weekly-`))
      for (const level of [2, 3, 4, 5]) assert.ok(getPetRelationshipMilestoneCopy(petType, language, { level }))
      if (petType !== 'pig') {
        assert.ok(care.every((item) => !/小猪|pig|哼唧/.test(item.message)))
      }
    }
  })
}

test('unsupported species cannot create onboarding, care, companion or milestone state', () => {
  assert.equal(onboarding.createPetOnboardingKey(17, 29, 'rabbit'), null)
  assert.equal(createPetOnboardingContextKey({ userId: 17, relationshipId: 29, petType: 'rabbit' }), null)
  assert.throws(() => createPetOnboardingSampleReminderPayload('en', now, 'rabbit'), TypeError)
  assert.deepEqual(getPetCareActions('en', 'rabbit'), [])
  assert.equal(getPetCompanionCopy('rabbit', 'en', { type: 'daily_greeting', timeContext: 'morning' }), null)
  assert.equal(createPetMilestonePlaybackState({ petType: 'rabbit', claimToken: token }), null)
  assert.equal(createPetMilestonePlaybackState({
    petType: 'cat', claimToken: token,
    milestone: { id: 5, pet_type: 'rabbit', level: 2, claim_token: token },
  }), null)
})
