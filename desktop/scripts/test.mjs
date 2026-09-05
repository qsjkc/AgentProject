import assert from 'node:assert/strict'

import petMilestonePlaybackStore from '../electron/pet-milestone-playback-store.cjs'
import petOnboardingBroadcast from '../electron/pet-onboarding-broadcast.cjs'
import petOnboardingDto from '../electron/pet-onboarding-dto.cjs'
import petOnboardingStore from '../electron/pet-onboarding-store.cjs'
import rendererTelemetry from '../electron/renderer-telemetry.cjs'
import accountBoundary from '../electron/account-boundary.cjs'
import mainPanelIntent from '../electron/main-panel-intent.cjs'
import { createMainPanelIntentConsumerController } from '../src/shared/main-panel-intent-controller.js'
import { normalizeApiBaseUrl } from '../src/shared/api-base-url.js'
import { getPetMessagePool, normalizeLanguage, t } from '../src/shared/i18n.js'
import {
  ANIMATION_ACTIONS,
  createInitialPetAnimationState,
  doesPetAnimationBlockCare,
  isLoopingPetAnimation,
  petAnimationReducer,
} from '../src/shared/pet-animation-state.js'
import { getPetCareActions, getPetCareToolbarLabel } from '../src/shared/pet-care-actions.js'
import {
  COMPANION_EVENT_TYPES,
  COMPANION_MODES,
  DEFAULT_COMPANION_SETTINGS,
  evaluateCompanionOpportunity,
  getCompanionStatusKey,
  isCompanionQuietTime,
  normalizeCompanionSettings,
  normalizeCompanionState,
  recordCompanionCopy,
} from '../src/shared/pet-companion.js'
import {
  getPetDailySummaryHighlights,
  getPetDailySummaryMessage,
  normalizePetDailySummary,
} from '../src/shared/pet-daily-summary.js'
import {
  getPetWeeklyCompanionCopy,
  getPetWeeklySummaryHighlights,
  getPetWeeklySummaryMessage,
  normalizePetWeeklySummary,
} from '../src/shared/pet-weekly-summary.js'
import { getPetCompanionCopy, getPetRelationshipEventCopy } from '../src/shared/pet-personality.js'
import {
  createRewardIdempotencyKey,
  didEquippedOutfitChange,
  getRelationshipStageLabel,
  normalizePetRelationship,
} from '../src/shared/pet-relationship.js'
import {
  applyPetOutfitPreview,
  getPetOutfitCatalog,
  getPetOutfitSlotLabel,
  normalizePetOutfitState,
} from '../src/shared/pet-outfits.js'
import {
  AUTH_CONTEXT_CHANGED_CODE,
  canCommitRelationshipReward,
  commitAccountOperation,
  createAccountOperationGate,
  createSessionOperationContext,
  createRelationshipScopedRuntimeReset,
  createMainPanelRelationshipNullReset,
  createLocalOperationContext,
  deriveQuickChatPetStateContext,
  adoptRelationshipCapability,
  adoptPetStateCapability,
  createPetAccountContextKey,
  executeSessionBoundRequest,
  isPetAccountOperationCurrent,
  isPetAccountContextCurrent,
  isPetRelationshipForAccountContext,
  isSessionSnapshotCurrent,
  runAccountOperation,
} from '../src/shared/pet-account-context.js'
import {
  createPetOnboardingContextKey,
  createPetOnboardingSampleReminderPayload,
  derivePetOnboardingScene,
  isPetOnboardingReminderMatch,
  isPetOnboardingMainPanelIntent,
  isPetOnboardingStateForContext,
  isPetOnboardingStateCurrent,
  normalizePetOnboardingMainStateResponse,
  PET_ONBOARDING_CAPABILITIES as PANEL_ONBOARDING_CAPABILITIES,
  PET_ONBOARDING_MAIN_PANEL_INTENT,
  PET_ONBOARDING_SCENES,
  selectPetOnboardingStateForContext,
  unwrapPetOnboardingStateResponse,
} from '../src/shared/pet-onboarding-main.js'
import {
  canCommitPetCompanionResult,
  createPetOnboardingPresentationToken,
  deriveNextPetOnboardingStep,
  getPetOnboardingCopy,
  getPetOnboardingEngagementDelta,
  getPetOnboardingGuideCooldownUntil,
  getPetOnboardingGuideTimeoutAction,
  isPetOnboardingContextCurrent as isPetOnboardingRendererContextCurrent,
  isPetOnboardingGuideCoolingDown,
  isPetOnboardingSafe,
  normalizePetOnboardingStateResponse,
  PET_ONBOARDING_CAPABILITIES as RENDERER_ONBOARDING_CAPABILITIES,
  PET_ONBOARDING_STEPS as RENDERER_ONBOARDING_STEPS,
  shouldRecordPetOnboardingInteraction,
} from '../src/shared/pet-onboarding-state.js'
import {
  createPetMilestoneClaimToken,
  createPetMilestonePlaybackState,
  getPetMilestonePersistenceConflict,
  isInvalidPetMilestoneClaimError,
  isMissingPetRelationshipMilestoneError,
  isPetMilestoneClaimSafe,
  isPetMilestonePlaybackContextCurrent,
  isPetMilestonePlaybackSafe,
  isPetRelationshipReadyForMilestone,
  normalizePetRelationshipMilestone,
  normalizePetMilestonePlaybackState,
  PET_MILESTONE_PLAYBACK_STATUS,
  updatePetMilestonePlaybackStatus,
} from '../src/shared/pet-milestone-state.js'
import { parseOneTimeReminder, parseReminder } from '../src/shared/reminder-parser.js'
import { getReminderRecurrenceLabel } from '../src/shared/reminder-recurrence.js'
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

const {
  clearPetMilestonePlaybackEntry,
  clearPetMilestonePlaybackSnapshot,
  readPetMilestonePlaybackEntry,
  setPetMilestonePlaybackEntry,
} = petMilestonePlaybackStore
const {
  createAuthoritativeOperationContextState,
  createOperationCapabilityRegistry,
} = accountBoundary

const {
  authorizeAccountMutation,
  authorizeNotification,
  authorizeSessionClear,
  authorizeSwitchPet,
  createStableAccountContextKey,
} = accountBoundary

const {
  createMainPanelIntentCoordinator,
  createMainPanelIntentListenerRegistry,
} = mainPanelIntent

const {
  PET_ONBOARDING_CAPABILITIES,
  PET_ONBOARDING_ENGAGEMENT_LIMIT_MS,
  PET_ONBOARDING_FINISH_REASONS,
  PET_ONBOARDING_PRESENTATION_LEASE_MS,
  PET_ONBOARDING_STATUS,
  PET_ONBOARDING_STEPS,
  ackPetOnboardingPresentation,
  calculatePetOnboardingEngagementSample,
  claimPetOnboardingPresentation,
  createPetOnboardingKey,
  dismissPetOnboarding,
  isPetOnboardingContextEligible,
  normalizePetOnboardingContext,
  normalizePetOnboardingState,
  readPetOnboardingEntry,
  recordPetOnboardingEngagement,
  recordPetOnboardingObservation,
  releasePetOnboardingPresentation,
  snoozePetOnboarding,
} = petOnboardingStore

const { createPetOnboardingStateBroadcaster } = petOnboardingBroadcast
const {
  PET_ONBOARDING_MAIN_DTO_FIELDS,
  PET_ONBOARDING_PET_DTO_FIELDS,
  projectPetOnboardingStateForMain,
  projectPetOnboardingStateForPet,
  projectPetOnboardingStateForRole,
} = petOnboardingDto
const {
  RENDERER_TELEMETRY_MARKERS,
  createRendererHeartbeatRecord,
  createRendererTelemetryRecord,
  sanitizeRendererTelemetryPayload,
} = rendererTelemetry

const onboardingNow = new Date('2026-08-12T10:00:00.000Z')
const onboardingContext = {
  has_session: true,
  user_id: 17,
  pet_type: 'pig',
  relationship: {
    id: 29,
    user_id: 17,
    pet_type: 'pig',
    level: 1,
    created_at: '2026-08-12T09:00:00.000Z',
  },
}
assert.equal(createPetOnboardingKey(17, 29), '17:29:pig:v1')
assert.equal(isPetOnboardingContextEligible(onboardingContext, onboardingNow), true)
assert.equal(
  normalizePetOnboardingContext({ ...onboardingContext, user_id: 18 }),
  null,
)
assert.equal(
  normalizePetOnboardingContext({
    ...onboardingContext,
    relationship: { ...onboardingContext.relationship, pet_type: 'cat' },
  }),
  null,
)
assert.equal(
  isPetOnboardingContextEligible({
    ...onboardingContext,
    relationship: { ...onboardingContext.relationship, level: 2 },
  }, onboardingNow),
  false,
)
const oldOnboardingRead = readPetOnboardingEntry({
  states: {},
  context: {
    ...onboardingContext,
    relationship: {
      ...onboardingContext.relationship,
      created_at: '2026-08-11T09:59:59.999Z',
    },
  },
  now: onboardingNow,
})
assert.equal(oldOnboardingRead.state, null)
assert.equal(oldOnboardingRead.changed, false)
assert.equal(oldOnboardingRead.reason, 'not-eligible')
assert.equal(
  isPetOnboardingContextEligible({
    ...onboardingContext,
    relationship: { ...onboardingContext.relationship, created_at: '2026-08-11T09:59:59.999Z' },
  }, onboardingNow),
  false,
)

const onboardingCreated = readPetOnboardingEntry({
  states: {},
  context: onboardingContext,
  now: onboardingNow,
})
assert.equal(onboardingCreated.changed, true)
assert.equal(onboardingCreated.reason, 'created')
assert.equal(onboardingCreated.state.revision, 0)
assert.equal(onboardingCreated.state.status, PET_ONBOARDING_STATUS.ACTIVE)
assert.deepEqual(onboardingCreated.state.shown_step_ids, [])
assert.deepEqual(onboardingCreated.state.observed_capability_ids, [])

const onboardingCanonicalRead = readPetOnboardingEntry({
  states: onboardingCreated.states,
  context: onboardingContext,
  now: new Date(onboardingNow.getTime() + 1000),
})
assert.equal(onboardingCanonicalRead.changed, false)
assert.equal(onboardingCanonicalRead.state.revision, 0)
assert.deepEqual(onboardingCanonicalRead.states, onboardingCreated.states)

const onboardingClockRollback = new Date('2026-08-12T08:00:00.000Z')
const rollbackEngagement = recordPetOnboardingEngagement(
  onboardingCreated.state,
  1000,
  onboardingClockRollback,
)
assert.equal(rollbackEngagement.ok, true)
assert.equal(rollbackEngagement.state.updated_at, onboardingCreated.state.updated_at)
assert.equal(normalizePetOnboardingState(rollbackEngagement.state)?.revision, 1)
const rollbackClaim = claimPetOnboardingPresentation(
  onboardingCreated.state,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  onboardingClockRollback,
)
assert.equal(rollbackClaim.ok, true)
assert.equal(rollbackClaim.state.updated_at, onboardingCreated.state.updated_at)
assert.equal(normalizePetOnboardingState(rollbackClaim.state)?.revision, 1)
const rollbackFinished = dismissPetOnboarding(
  onboardingCreated.state,
  onboardingClockRollback,
)
assert.equal(rollbackFinished.ok, true)
assert.equal(rollbackFinished.state.updated_at, onboardingCreated.state.updated_at)
assert.equal(rollbackFinished.state.completed_at, onboardingCreated.state.updated_at)
assert.equal(normalizePetOnboardingState(rollbackFinished.state)?.revision, 1)

const firstEngagementSample = calculatePetOnboardingEngagementSample({
  contextKey: '17:29:pig:v1',
  requestedDeltaMs: 5000,
  monotonicNowMs: 100,
})
assert.equal(firstEngagementSample.acceptedDeltaMs, 0)
assert.equal(firstEngagementSample.reason, 'baseline')
const measuredEngagementSample = calculatePetOnboardingEngagementSample({
  previousSample: firstEngagementSample.sample,
  contextKey: '17:29:pig:v1',
  requestedDeltaMs: 9000,
  monotonicNowMs: 850,
})
assert.equal(measuredEngagementSample.acceptedDeltaMs, 750)
const requestedEngagementSample = calculatePetOnboardingEngagementSample({
  previousSample: measuredEngagementSample.sample,
  contextKey: '17:29:pig:v1',
  requestedDeltaMs: 400,
  monotonicNowMs: 1850,
})
assert.equal(requestedEngagementSample.acceptedDeltaMs, 400)
const cappedEngagementSample = calculatePetOnboardingEngagementSample({
  previousSample: requestedEngagementSample.sample,
  contextKey: '17:29:pig:v1',
  requestedDeltaMs: 9000,
  monotonicNowMs: 10850,
})
assert.equal(cappedEngagementSample.acceptedDeltaMs, 5000)
const switchedEngagementSample = calculatePetOnboardingEngagementSample({
  previousSample: cappedEngagementSample.sample,
  contextKey: '18:30:pig:v1',
  requestedDeltaMs: 5000,
  monotonicNowMs: 10900,
})
assert.equal(switchedEngagementSample.acceptedDeltaMs, 0)
assert.equal(switchedEngagementSample.reason, 'baseline')

const secondOnboardingContext = {
  ...onboardingContext,
  user_id: 18,
  relationship: {
    ...onboardingContext.relationship,
    id: 30,
    user_id: 18,
  },
}
const isolatedOnboarding = readPetOnboardingEntry({
  states: onboardingCanonicalRead.states,
  context: secondOnboardingContext,
  now: onboardingNow,
})
assert.equal(isolatedOnboarding.state.user_id, 18)
assert.equal(isolatedOnboarding.state.relationship_id, 30)
assert.equal(Object.hasOwn(isolatedOnboarding.states, createPetOnboardingKey(17, 29)), true)
assert.equal(Object.hasOwn(isolatedOnboarding.states, createPetOnboardingKey(18, 30)), true)

const onboardingCorrupted = readPetOnboardingEntry({
  states: {
    [createPetOnboardingKey(17, 29)]: {
      ...onboardingCreated.state,
      shown_step_ids: 'not-an-array',
    },
  },
  context: onboardingContext,
  now: new Date(onboardingNow.getTime() + 2000),
})
assert.equal(onboardingCorrupted.changed, true)
assert.equal(onboardingCorrupted.reason, 'recovered-corruption')
assert.equal(onboardingCorrupted.state.status, PET_ONBOARDING_STATUS.DISMISSED)
assert.equal(onboardingCorrupted.state.revision, 1)
const onboardingCorruptionSecondRead = readPetOnboardingEntry({
  states: onboardingCorrupted.states,
  context: onboardingContext,
  now: new Date(onboardingNow.getTime() + 3000),
})
assert.equal(onboardingCorruptionSecondRead.changed, false)
assert.equal(onboardingCorruptionSecondRead.state.revision, 1)

let onboardingState = onboardingCreated.state
let onboardingResult = recordPetOnboardingEngagement(
  onboardingState,
  9000,
  new Date(onboardingNow.getTime() + 1000),
)
assert.equal(onboardingResult.ok, true)
assert.equal(onboardingResult.state.engaged_elapsed_ms, 5000)
assert.equal(onboardingResult.state.revision, 1)
onboardingState = onboardingResult.state

const meetToken = '11111111-1111-4111-8111-111111111111'
const otherMeetToken = '22222222-2222-4222-8222-222222222222'
onboardingResult = claimPetOnboardingPresentation(
  onboardingState,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  meetToken,
  new Date(onboardingNow.getTime() + 2000),
)
assert.equal(onboardingResult.ok, true)
assert.equal(
  Date.parse(onboardingResult.presentation.lease_expires_at),
  onboardingNow.getTime() + 2000 + PET_ONBOARDING_PRESENTATION_LEASE_MS,
)
onboardingState = onboardingResult.state
const busyClaim = claimPetOnboardingPresentation(
  onboardingState,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  otherMeetToken,
  new Date(onboardingNow.getTime() + 3000),
)
assert.equal(busyClaim.ok, false)
assert.equal(busyClaim.reason, 'presentation-busy')
assert.equal(
  ackPetOnboardingPresentation(
    onboardingState,
    'pig',
    PET_ONBOARDING_STEPS.MEET_PET,
    meetToken,
    new Date(onboardingNow.getTime() + 2000 + PET_ONBOARDING_PRESENTATION_LEASE_MS),
  ).reason,
  'lease-expired',
)
assert.equal(
  releasePetOnboardingPresentation(
    onboardingState,
    'pig',
    PET_ONBOARDING_STEPS.MEET_PET,
    meetToken,
    new Date(onboardingNow.getTime() + 2000 + PET_ONBOARDING_PRESENTATION_LEASE_MS),
  ).reason,
  'lease-expired',
)
assert.equal(
  claimPetOnboardingPresentation(
    onboardingState,
    'pig',
    PET_ONBOARDING_STEPS.MEET_PET,
    'not-a-uuid',
    new Date(onboardingNow.getTime() + 3000),
  ).reason,
  'invalid-claim',
)
const renewedClaim = claimPetOnboardingPresentation(
  onboardingState,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  meetToken.toUpperCase(),
  new Date(onboardingNow.getTime() + 4000),
)
assert.equal(renewedClaim.ok, true)
assert.equal(renewedClaim.state.presentation.token, meetToken)
const takeoverClaim = claimPetOnboardingPresentation(
  renewedClaim.state,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  otherMeetToken,
  new Date(onboardingNow.getTime() + 20000),
)
assert.equal(takeoverClaim.ok, true)
assert.equal(takeoverClaim.state.presentation.token, otherMeetToken)
assert.equal(
  ackPetOnboardingPresentation(
    takeoverClaim.state,
    'pig',
    PET_ONBOARDING_STEPS.MEET_PET,
    meetToken,
    new Date(onboardingNow.getTime() + 21000),
  ).reason,
  'presentation-mismatch',
)
onboardingResult = releasePetOnboardingPresentation(
  takeoverClaim.state,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  otherMeetToken,
  new Date(onboardingNow.getTime() + 21000),
)
assert.equal(onboardingResult.ok, true)
assert.equal(onboardingResult.state.presentation, null)
assert.equal(
  releasePetOnboardingPresentation(
    onboardingResult.state,
    'pig',
    PET_ONBOARDING_STEPS.MEET_PET,
    otherMeetToken,
    new Date(onboardingNow.getTime() + 22000),
  ).reason,
  'presentation-mismatch',
)

onboardingResult = claimPetOnboardingPresentation(
  onboardingResult.state,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  meetToken,
  new Date(onboardingNow.getTime() + 23000),
)
onboardingResult = ackPetOnboardingPresentation(
  onboardingResult.state,
  'pig',
  PET_ONBOARDING_STEPS.MEET_PET,
  meetToken,
  new Date(onboardingNow.getTime() + 24000),
)
assert.equal(onboardingResult.ok, true)
assert.deepEqual(onboardingResult.state.shown_step_ids, [PET_ONBOARDING_STEPS.MEET_PET])
assert.deepEqual(onboardingResult.state.observed_capability_ids, [])
onboardingState = onboardingResult.state

const relationshipToken = '33333333-3333-4333-8333-333333333333'
onboardingResult = claimPetOnboardingPresentation(
  onboardingState,
  'pig',
  PET_ONBOARDING_STEPS.RELATIONSHIP,
  relationshipToken,
  new Date(onboardingNow.getTime() + 25000),
)
onboardingResult = ackPetOnboardingPresentation(
  onboardingResult.state,
  'pig',
  PET_ONBOARDING_STEPS.RELATIONSHIP,
  relationshipToken,
  new Date(onboardingNow.getTime() + 26000),
)
assert.equal(
  onboardingResult.state.observed_capability_ids.includes(
    PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
  ),
  true,
)
onboardingState = onboardingResult.state

const invalidReminder = recordPetOnboardingObservation(
  onboardingState,
  PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
  { reminder_id: 0 },
  new Date(onboardingNow.getTime() + 27000),
)
assert.equal(invalidReminder.reason, 'invalid-reminder')
onboardingResult = recordPetOnboardingObservation(
  onboardingState,
  PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
  { reminder_id: 91 },
  new Date(onboardingNow.getTime() + 28000),
)
assert.equal(onboardingResult.ok, true)
assert.equal(onboardingResult.state.reminder_id, 91)
const repeatedReminderCreated = recordPetOnboardingObservation(
  onboardingResult.state,
  PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
  { reminder_id: 91 },
  new Date(onboardingNow.getTime() + 28001),
)
assert.equal(repeatedReminderCreated.ok, true)
assert.equal(repeatedReminderCreated.changed, false)
assert.equal(repeatedReminderCreated.state.revision, onboardingResult.state.revision)
const waitingAtLimit = recordPetOnboardingEngagement(
  { ...onboardingResult.state, engaged_elapsed_ms: PET_ONBOARDING_ENGAGEMENT_LIMIT_MS - 1000 },
  1000,
  new Date(onboardingNow.getTime() + 29000),
)
assert.equal(waitingAtLimit.state.status, PET_ONBOARDING_STATUS.ACTIVE)
assert.equal(waitingAtLimit.state.engaged_elapsed_ms, PET_ONBOARDING_ENGAGEMENT_LIMIT_MS)
assert.equal(
  recordPetOnboardingObservation(
    waitingAtLimit.state,
    PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED,
    { reminder_id: 92 },
    new Date(onboardingNow.getTime() + 30000),
  ).reason,
  'reminder-mismatch',
)
const timedOutAfterReminder = recordPetOnboardingObservation(
  waitingAtLimit.state,
  PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED,
  { reminder_id: 91 },
  new Date(onboardingNow.getTime() + 31000),
)
assert.equal(timedOutAfterReminder.state.status, PET_ONBOARDING_STATUS.FINISHED)
assert.equal(timedOutAfterReminder.state.finish_reason, PET_ONBOARDING_FINISH_REASONS.TIMEOUT)
assert.equal(normalizePetOnboardingState(timedOutAfterReminder.state).revision, timedOutAfterReminder.state.revision)

let completedState = onboardingCreated.state
for (const [capabilityId, payload] of [
  [PET_ONBOARDING_CAPABILITIES.PET_INTERACTION, {}],
  [PET_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED, {}],
  [PET_ONBOARDING_CAPABILITIES.REMINDER_CREATED, { reminder_id: 93 }],
  [PET_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED, { reminder_id: 93 }],
]) {
  const result = recordPetOnboardingObservation(completedState, capabilityId, payload, onboardingNow)
  assert.equal(result.ok, true)
  completedState = result.state
}
assert.equal(completedState.status, PET_ONBOARDING_STATUS.FINISHED)
assert.equal(completedState.finish_reason, PET_ONBOARDING_FINISH_REASONS.COMPLETED)

const snoozed = snoozePetOnboarding(onboardingCreated.state, onboardingNow)
assert.equal(snoozed.ok, true)
assert.equal(
  claimPetOnboardingPresentation(
    snoozed.state,
    'pig',
    PET_ONBOARDING_STEPS.MEET_PET,
    meetToken,
    new Date(onboardingNow.getTime() + 1000),
  ).reason,
  'snoozed',
)
const dismissed = dismissPetOnboarding(snoozed.state, new Date(onboardingNow.getTime() + 2000))
assert.equal(dismissed.state.status, PET_ONBOARDING_STATUS.DISMISSED)
assert.equal(dismissPetOnboarding(dismissed.state, onboardingNow).changed, false)
assert.equal(recordPetOnboardingEngagement(dismissed.state, 1000, onboardingNow).reason, 'terminal')
assert.equal(
  claimPetOnboardingPresentation(
    onboardingCreated.state,
    'cat',
    PET_ONBOARDING_STEPS.MEET_PET,
    meetToken,
    onboardingNow,
  ).reason,
  'invalid-claim',
)

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
    'run',
    'stretch',
    'look_around',
    'yawn',
    'welcome_back',
  ]),
)
assert.equal(isLoopingPetAnimation(ANIMATION_ACTIONS.IDLE), true)
assert.equal(isLoopingPetAnimation(ANIMATION_ACTIONS.SLEEPING), true)
assert.equal(isLoopingPetAnimation(ANIMATION_ACTIONS.WAKE), false)
assert.equal(doesPetAnimationBlockCare(ANIMATION_ACTIONS.REMINDING, true), true)
assert.equal(doesPetAnimationBlockCare(ANIMATION_ACTIONS.LEVEL_UP, true), false)

assert.equal(
  petAnimationReducer(initialPetAnimation, {
    type: 'COMPANION_ACTION',
    action: ANIMATION_ACTIONS.WELCOME_BACK,
  }).action,
  ANIMATION_ACTIONS.WELCOME_BACK,
)
assert.equal(
  petAnimationReducer(initialPetAnimation, {
    type: 'COMPANION_ACTION',
    action: 'not-an-action',
  }).action,
  ANIMATION_ACTIONS.IDLE,
)

const companionMorning = new Date(2026, 6, 31, 9, 0, 0)
assert.deepEqual(normalizeCompanionState(null), {
  dayKey: '',
  proactiveCount: 0,
  lastEventAt: null,
  lastEventType: null,
  lastDailyGreetingDay: '',
  recentCopyIds: [],
  wasAway: false,
  awaySince: null,
  currentMood: 'relaxed',
})
const firstCompanionMoment = evaluateCompanionOpportunity({
  now: companionMorning,
  idleSeconds: 4,
  settings: DEFAULT_COMPANION_SETTINGS,
})
assert.equal(firstCompanionMoment.event.type, COMPANION_EVENT_TYPES.DAILY_GREETING)
assert.equal(firstCompanionMoment.event.action, ANIMATION_ACTIONS.STRETCH)
assert.equal(firstCompanionMoment.state.proactiveCount, 1)
assert.equal(firstCompanionMoment.state.currentMood, 'relaxed')

const companionTooSoon = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 9, 30, 0),
  idleSeconds: 5,
  settings: DEFAULT_COMPANION_SETTINGS,
  state: firstCompanionMoment.state,
})
assert.equal(companionTooSoon.event, null)

const companionNextMoment = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 10, 0, 0),
  idleSeconds: 5,
  settings: DEFAULT_COMPANION_SETTINGS,
  state: firstCompanionMoment.state,
})
assert.equal(companionNextMoment.event.type, COMPANION_EVENT_TYPES.PROACTIVE_MOMENT)
assert.equal(companionNextMoment.state.proactiveCount, 2)

const standardDailyLimit = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 17, 0, 0),
  idleSeconds: 0,
  settings: DEFAULT_COMPANION_SETTINGS,
  state: {
    ...companionNextMoment.state,
    proactiveCount: 4,
    lastEventAt: new Date(2026, 6, 31, 15, 0, 0).toISOString(),
  },
})
assert.equal(standardDailyLimit.event, null)

const lowFrequencyState = {
  ...firstCompanionMoment.state,
  lastEventAt: new Date(2026, 6, 31, 9, 0, 0).toISOString(),
}
const lowFrequencySettings = normalizeCompanionSettings({ mode: COMPANION_MODES.LOW })
assert.equal(
  evaluateCompanionOpportunity({
    now: new Date(2026, 6, 31, 11, 29, 0),
    idleSeconds: 0,
    settings: lowFrequencySettings,
    state: lowFrequencyState,
  }).event,
  null,
)
assert.equal(
  evaluateCompanionOpportunity({
    now: new Date(2026, 6, 31, 11, 30, 0),
    idleSeconds: 0,
    settings: lowFrequencySettings,
    state: lowFrequencyState,
  }).event.type,
  COMPANION_EVENT_TYPES.PROACTIVE_MOMENT,
)
assert.equal(
  evaluateCompanionOpportunity({
    now: new Date(2026, 6, 31, 11, 30, 0),
    idleSeconds: 0,
    settings: lowFrequencySettings,
    state: lowFrequencyState,
  }).event.action,
  ANIMATION_ACTIONS.LOOK_AROUND,
)

const afternoonRun = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 16, 0, 0),
  idleSeconds: 0,
  state: {
    ...companionNextMoment.state,
    proactiveCount: 2,
    lastEventAt: new Date(2026, 6, 31, 15, 0, 0).toISOString(),
  },
})
assert.equal(afternoonRun.event.action, ANIMATION_ACTIONS.RUN)

const lateNightYawn = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 22, 30, 0),
  idleSeconds: 0,
  state: {
    ...companionNextMoment.state,
    lastEventAt: new Date(2026, 6, 31, 21, 0, 0).toISOString(),
  },
})
assert.equal(lateNightYawn.event.action, ANIMATION_ACTIONS.YAWN)
assert.equal(lateNightYawn.event.mood, 'sleepy')

const awayCompanion = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 15, 0, 0),
  idleSeconds: 31 * 60,
  state: firstCompanionMoment.state,
})
assert.equal(awayCompanion.event, null)
assert.equal(awayCompanion.state.wasAway, true)
assert.equal(awayCompanion.state.currentMood, 'expectant')

const returnedCompanion = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 15, 1, 0),
  idleSeconds: 3,
  state: awayCompanion.state,
})
assert.equal(returnedCompanion.event.type, COMPANION_EVENT_TYPES.WELCOME_BACK)
assert.equal(returnedCompanion.event.action, ANIMATION_ACTIONS.WELCOME_BACK)
assert.equal(returnedCompanion.state.wasAway, false)

const recentAwayCompanion = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 15, 10, 0),
  idleSeconds: 31 * 60,
  state: {
    ...firstCompanionMoment.state,
    lastEventAt: new Date(2026, 6, 31, 15, 0, 0).toISOString(),
  },
})
const suppressedReturn = evaluateCompanionOpportunity({
  now: new Date(2026, 6, 31, 15, 11, 0),
  idleSeconds: 2,
  state: recentAwayCompanion.state,
})
assert.equal(suppressedReturn.event, null)
assert.equal(suppressedReturn.state.wasAway, false)

const quietCompanionTime = new Date(2026, 6, 31, 23, 30, 0)
assert.equal(isCompanionQuietTime(quietCompanionTime), true)
const quietCompanion = evaluateCompanionOpportunity({
  now: quietCompanionTime,
  idleSeconds: 0,
})
assert.equal(quietCompanion.event, null)
assert.equal(quietCompanion.state.currentMood, 'sleepy')
assert.equal(getCompanionStatusKey({ now: quietCompanionTime }), 'quiet')

const disabledCompanionSettings = normalizeCompanionSettings({ mode: COMPANION_MODES.OFF })
assert.equal(
  evaluateCompanionOpportunity({
    now: companionMorning,
    idleSeconds: 0,
    settings: disabledCompanionSettings,
  }).event,
  null,
)
assert.equal(
  getCompanionStatusKey({
    now: companionMorning,
    settings: disabledCompanionSettings,
  }),
  'off',
)

const firstCompanionCopy = getPetCompanionCopy(
  'pig',
  'zh-CN',
  firstCompanionMoment.event,
  { level: 3 },
)
assert.ok(firstCompanionCopy?.id)
assert.ok(firstCompanionCopy?.text)
const copyState = recordCompanionCopy(firstCompanionMoment.state, firstCompanionCopy.id)
const secondCompanionCopy = getPetCompanionCopy(
  'pig',
  'zh-CN',
  firstCompanionMoment.event,
  { level: 3 },
  copyState.recentCopyIds,
)
assert.notEqual(secondCompanionCopy.id, firstCompanionCopy.id)
assert.equal(getPetCompanionCopy('cat', 'zh-CN', firstCompanionMoment.event), null)

const normalizedDailySummary = normalizePetDailySummary({
  pet_type: 'pig',
  local_date: '2026-07-31',
  timezone: 'Asia/Shanghai',
  interaction_count: 7.8,
  xp_gained: 26,
  action_counts: {
    pat: 2,
    meaningful_chat: 1,
    unknown_action: 99,
  },
  care_count: 2,
  meaningful_chat_count: 1,
  reminders_created_count: 1,
  reminders_completed_count: 1,
})
assert.equal(normalizedDailySummary.interaction_count, 7)
assert.deepEqual(normalizedDailySummary.action_counts, {
  pat: 2,
  meaningful_chat: 1,
})
assert.deepEqual(getPetDailySummaryHighlights('zh-CN', normalizedDailySummary), [
  '照料 2',
  '聊天 1',
  '记下提醒 1',
])
assert.match(getPetDailySummaryMessage('zh-CN', normalizedDailySummary), /完成 1 个提醒/)
assert.equal(normalizePetDailySummary(null), null)

const firstMemoryCopy = getPetCompanionCopy(
  'pig',
  'zh-CN',
  firstCompanionMoment.event,
  { level: 3 },
  [],
  normalizedDailySummary,
)
assert.match(firstMemoryCopy.id, /^pig-memory-reminders/)
assert.match(firstMemoryCopy.text, /我都记得/)
const secondMemoryCopy = getPetCompanionCopy(
  'pig',
  'zh-CN',
  firstCompanionMoment.event,
  { level: 3 },
  [firstMemoryCopy.id],
  normalizedDailySummary,
)
assert.match(secondMemoryCopy.id, /^pig-memory-care/)

const normalizedWeeklySummary = normalizePetWeeklySummary({
  pet_type: 'pig',
  review_key: '2026-07-27_2026-08-02',
  week_start: '2026-07-27',
  week_end: '2026-08-02',
  timezone: 'Asia/Shanghai',
  eligible: true,
  is_new: true,
  active_days: 9,
  interaction_count: 12.9,
  xp_gained: 113,
  action_counts: {
    pat: 2,
    meaningful_chat: 3,
    unknown_action: 99,
  },
  care_count: 2,
  meaningful_chat_count: 3,
  reminders_created_count: 1,
  reminders_completed_count: 2,
  level_at_start: 2,
  level_at_end: 3,
  levels_gained: 1,
  relationship_stage_at_end: 'clingy',
})
assert.equal(normalizedWeeklySummary.active_days, 7)
assert.equal(normalizedWeeklySummary.interaction_count, 12)
assert.deepEqual(normalizedWeeklySummary.action_counts, {
  pat: 2,
  meaningful_chat: 3,
})
assert.deepEqual(getPetWeeklySummaryHighlights('zh-CN', normalizedWeeklySummary), [
  '有记录 7 天',
  '照料 2',
  '聊天 3',
])
assert.match(getPetWeeklySummaryMessage('zh-CN', normalizedWeeklySummary), /Lv\.2/)
assert.match(getPetWeeklySummaryMessage('zh-CN', normalizedWeeklySummary), /Lv\.3/)
const weeklyCopy = getPetWeeklyCompanionCopy('zh-CN', normalizedWeeklySummary)
assert.equal(weeklyCopy.weeklyReviewKey, normalizedWeeklySummary.review_key)
assert.match(weeklyCopy.id, /^pig-weekly-review-zh-CN-/)
assert.equal(
  getPetWeeklyCompanionCopy('zh-CN', {
    ...normalizedWeeklySummary,
    is_new: false,
  }),
  null,
)
assert.equal(normalizePetWeeklySummary(null), null)

const prioritizedWeeklyCopy = getPetCompanionCopy(
  'pig',
  'zh-CN',
  firstCompanionMoment.event,
  { level: 3 },
  [],
  normalizedDailySummary,
  normalizedWeeklySummary,
)
assert.equal(prioritizedWeeklyCopy.id, weeklyCopy.id)
const weeklyCopySuppressed = getPetCompanionCopy(
  'pig',
  'zh-CN',
  firstCompanionMoment.event,
  { level: 3 },
  [weeklyCopy.id],
  normalizedDailySummary,
  normalizedWeeklySummary,
)
assert.match(weeklyCopySuppressed.id, /^pig-memory-/)

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

const milestoneClaimToken = createPetMilestoneClaimToken()
assert.match(
  milestoneClaimToken,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
)
const relationshipMilestone = normalizePetRelationshipMilestone({
  id: 23,
  pet_type: 'pig',
  level: 3,
  relationship_stage: 'clingy',
  reward_outfit_id: 'pig_bell',
  achieved_at: '2026-08-11T09:00:00Z',
  claim_token: milestoneClaimToken,
  claim_expires_at: '2026-08-11T09:05:00Z',
  acknowledged_at: null,
})
assert.equal(relationshipMilestone.id, 23)
assert.equal(relationshipMilestone.reward_outfit_id, 'pig_bell')
assert.equal(normalizePetRelationshipMilestone({ ...relationshipMilestone, pet_type: 'cat' }), null)

const milestoneClaimState = createPetMilestonePlaybackState({
  petType: 'pig',
  status: PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
  claimToken: milestoneClaimToken,
  milestone: relationshipMilestone,
})
const milestonePlayingState = updatePetMilestonePlaybackStatus(
  milestoneClaimState,
  PET_MILESTONE_PLAYBACK_STATUS.PLAYING,
)
assert.equal(milestonePlayingState.status, PET_MILESTONE_PLAYBACK_STATUS.PLAYING)
assert.equal(milestonePlayingState.revision, milestoneClaimState.revision)
const milestoneAckPendingState = createPetMilestonePlaybackState({
  petType: 'pig',
  status: PET_MILESTONE_PLAYBACK_STATUS.ACK_PENDING,
  claimToken: milestoneClaimToken,
  milestone: relationshipMilestone,
  displayed: true,
})
assert.equal(normalizePetMilestonePlaybackState(milestoneAckPendingState).displayed, true)
assert.equal(
  normalizePetMilestonePlaybackState({
    ...milestoneAckPendingState,
    claim_token: 'not-a-uuid',
  }),
  null,
)
assert.equal(
  normalizePetMilestonePlaybackState({
    ...milestoneAckPendingState,
    milestone: {
      ...relationshipMilestone,
      claim_token: createPetMilestoneClaimToken(),
    },
  }),
  null,
)
assert.equal(
  normalizePetMilestonePlaybackState({
    ...milestoneAckPendingState,
    revision: '1',
  }),
  null,
)
assert.equal(
  normalizePetMilestonePlaybackState({
    ...milestoneAckPendingState,
    displayed: false,
  }),
  null,
)
assert.equal(
  createPetMilestonePlaybackState({
    status: PET_MILESTONE_PLAYBACK_STATUS.PLAYING,
    claimToken: milestoneClaimToken,
  }),
  null,
)

const persistedConflictState = createPetMilestonePlaybackState({
  ...milestoneAckPendingState,
  revision: 7,
})
assert.deepEqual(
  getPetMilestonePersistenceConflict({
    ok: false,
    reason: 'revision-conflict',
    current: persistedConflictState,
  }),
  { current: persistedConflictState },
)
assert.deepEqual(
  getPetMilestonePersistenceConflict({
    ok: false,
    reason: 'revision-conflict',
    current: {
      ...persistedConflictState,
      claim_token: 'corrupted-token',
    },
  }),
  { current: null },
)
assert.equal(
  getPetMilestonePersistenceConflict({
    ok: false,
    reason: 'no-session',
    current: persistedConflictState,
  }),
  null,
)
assert.equal(
  isPetMilestonePlaybackContextCurrent({
    expectedEpoch: 4,
    currentEpoch: 4,
    petType: 'pig',
    hasSession: true,
  }),
  true,
)
assert.equal(
  isPetMilestonePlaybackContextCurrent({
    expectedEpoch: 3,
    currentEpoch: 4,
    petType: 'pig',
    hasSession: true,
  }),
  false,
)

const reconcileClaimToken = createPetMilestoneClaimToken()
const reconcileClaimState = createPetMilestonePlaybackState({
  petType: 'pig',
  status: PET_MILESTONE_PLAYBACK_STATUS.CLAIM,
  claimToken: reconcileClaimToken,
  milestone: {
    ...relationshipMilestone,
    claim_token: reconcileClaimToken,
  },
  displayed: true,
  revision: 7,
})
assert.equal(reconcileClaimState.claim_token, reconcileClaimState.milestone.claim_token)
assert.equal(reconcileClaimState.revision, 7)

const unrelatedStoredPlayback = { cat: { untouched: true } }
const corruptedStoredPlayback = {
  ...unrelatedStoredPlayback,
  pig: {
    ...persistedConflictState,
    status: 'corrupted-status',
  },
}
const corruptedTokenStoredPlayback = {
  ...unrelatedStoredPlayback,
  pig: {
    ...persistedConflictState,
    claim_token: 'corrupted-token',
  },
}
const recoveredRead = readPetMilestonePlaybackEntry(corruptedStoredPlayback, 'pig')
assert.equal(recoveredRead.playback, null)
assert.equal(recoveredRead.changed, true)
assert.equal(Object.hasOwn(recoveredRead.playbackByPet, 'pig'), false)
assert.deepEqual(recoveredRead.playbackByPet.cat, unrelatedStoredPlayback.cat)

const recoveredSet = setPetMilestonePlaybackEntry({
  playbackByPet: corruptedTokenStoredPlayback,
  petType: 'pig',
  playback: milestoneClaimState,
  expectedRevision: 0,
  updatedAt: '2026-08-11T10:00:00.000Z',
})
assert.equal(recoveredSet.ok, true)
assert.equal(recoveredSet.recoveredCorruption, true)
assert.equal(recoveredSet.playback.revision, 1)
assert.equal(recoveredSet.playback.claim_token, milestoneClaimToken)
assert.deepEqual(recoveredSet.playbackByPet.cat, unrelatedStoredPlayback.cat)

const recoveredClear = clearPetMilestonePlaybackEntry({
  playbackByPet: corruptedTokenStoredPlayback,
  petType: 'pig',
  claimToken: 'corrupted-token',
  expectedRevision: 7,
})
assert.equal(recoveredClear.ok, true)
assert.equal(recoveredClear.recoveredCorruption, true)
assert.equal(Object.hasOwn(recoveredClear.playbackByPet, 'pig'), false)
assert.deepEqual(recoveredClear.playbackByPet.cat, unrelatedStoredPlayback.cat)

const validStoredConflict = setPetMilestonePlaybackEntry({
  playbackByPet: { pig: persistedConflictState },
  petType: 'pig',
  playback: milestoneClaimState,
  expectedRevision: 0,
  updatedAt: '2026-08-11T10:00:00.000Z',
})
assert.equal(validStoredConflict.ok, false)
assert.equal(validStoredConflict.reason, 'revision-conflict')
assert.equal(validStoredConflict.current.revision, 7)

const invalidIncomingPlayback = setPetMilestonePlaybackEntry({
  playbackByPet: {},
  petType: 'pig',
  playback: { ...milestoneClaimState, status: 'corrupted-status' },
  expectedRevision: 0,
  updatedAt: '2026-08-11T10:00:00.000Z',
})
assert.equal(invalidIncomingPlayback.ok, false)
assert.equal(invalidIncomingPlayback.reason, 'invalid-playback')

const milestoneReadyRelationship = {
  pet_type: 'pig',
  level: 4,
  outfit: {
    unlocked_outfit_ids: ['pig_basic_scarf', 'pig_sleep_cap', 'pig_bell', 'pig_work_badge'],
    equipped_outfits: {},
  },
}
const milestoneSafeContext = {
  petType: 'pig',
  hasSession: true,
  visibilityState: 'visible',
  voicePhase: 'idle',
  pointerActive: false,
  settlingPointer: false,
  activeCareAction: '',
  transientBubble: '',
  animationState: initialPetAnimation,
  relationship: milestoneReadyRelationship,
  milestone: relationshipMilestone,
}
assert.equal(isPetMilestoneClaimSafe(milestoneSafeContext), true)
assert.equal(isPetRelationshipReadyForMilestone(milestoneReadyRelationship, relationshipMilestone), true)
assert.equal(isPetMilestonePlaybackSafe(milestoneSafeContext), true)
assert.equal(
  isPetMilestonePlaybackSafe({
    ...milestoneSafeContext,
    relationship: {
      ...milestoneReadyRelationship,
      level: 1,
      outfit: { unlocked_outfit_ids: [], equipped_outfits: {} },
    },
  }),
  false,
)
assert.equal(
  isPetMilestonePlaybackSafe({
    ...milestoneSafeContext,
    relationship: {
      ...milestoneReadyRelationship,
      outfit: { unlocked_outfit_ids: ['pig_sleep_cap'], equipped_outfits: {} },
    },
  }),
  false,
)
assert.equal(isPetMilestoneClaimSafe({ ...milestoneSafeContext, visibilityState: 'hidden' }), false)
assert.equal(isPetMilestoneClaimSafe({ ...milestoneSafeContext, voicePhase: 'replying' }), false)
assert.equal(isInvalidPetMilestoneClaimError({ status: 409 }), true)
assert.equal(isInvalidPetMilestoneClaimError(new Error('network_error')), false)
assert.equal(isMissingPetRelationshipMilestoneError({ status: 404 }), true)
assert.equal(isMissingPetRelationshipMilestoneError({ status: 409 }), false)

const persistedOutfit = {
  unlocked_outfit_ids: ['pig_sleep_cap', 'pig_star_hat'],
  equipped_outfits: { head: 'pig_sleep_cap' },
}
const previewedOutfit = applyPetOutfitPreview(persistedOutfit, 'pig', 'pig_star_hat')
assert.equal(previewedOutfit.equipped_outfits.head, 'pig_star_hat')
assert.equal(persistedOutfit.equipped_outfits.head, 'pig_sleep_cap')
assert.deepEqual(
  applyPetOutfitPreview(persistedOutfit, 'pig', 'pig_bell'),
  persistedOutfit,
)

const levelUpAnimation = petAnimationReducer(initialPetAnimation, { type: 'LEVEL_UP' })
assert.equal(levelUpAnimation.action, ANIMATION_ACTIONS.LEVEL_UP)
assert.equal(levelUpAnimation.locked, true)

const milestoneLevelUpAnimation = petAnimationReducer(initialPetAnimation, {
  type: 'LEVEL_UP',
  milestoneId: relationshipMilestone.id,
})
assert.equal(milestoneLevelUpAnimation.milestoneId, relationshipMilestone.id)
assert.equal(
  petAnimationReducer(milestoneLevelUpAnimation, { type: 'ANIMATION_DONE' }).action,
  ANIMATION_ACTIONS.LEVEL_UP,
)
assert.equal(
  petAnimationReducer(milestoneLevelUpAnimation, {
    type: 'ANIMATION_DONE',
    milestoneId: relationshipMilestone.id + 1,
  }).action,
  ANIMATION_ACTIONS.LEVEL_UP,
)
assert.equal(
  petAnimationReducer(milestoneLevelUpAnimation, {
    type: 'ANIMATION_DONE',
    milestoneId: relationshipMilestone.id,
  }).action,
  ANIMATION_ACTIONS.IDLE,
)
assert.equal(
  petAnimationReducer(milestoneLevelUpAnimation, {
    type: 'REMINDER_DUE',
    message: 'priority reminder',
  }).action,
  ANIMATION_ACTIONS.REMINDING,
)

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

const onboardingUiNow = new Date('2026-08-12T08:00:00.000Z')
const onboardingRelationship = {
  id: 41,
  user_id: 7,
  pet_type: 'pig',
  level: 2,
  relationship_stage: 'getting_familiar',
  progress: { current: 3, required: 10 },
}
const onboardingBaseState = {
  version: 1,
  user_id: 7,
  relationship_id: 41,
  pet_type: 'pig',
  status: 'active',
  observed_capability_ids: [],
  reminder_id: null,
  snoozed_until: null,
  revision: 2,
}
assert.equal(
  createPetOnboardingContextKey({ userId: 7, relationshipId: 41, petType: 'pig' }),
  '7:41:pig',
)
assert.equal(
  isPetOnboardingStateForContext(onboardingBaseState, {
    userId: 7,
    relationshipId: 41,
    petType: 'pig',
  }),
  true,
)
assert.equal(
  isPetOnboardingStateForContext(onboardingBaseState, {
    userId: 8,
    relationshipId: 41,
    petType: 'pig',
  }),
  false,
)
assert.equal(
  selectPetOnboardingStateForContext(
    { ...onboardingBaseState, revision: 4 },
    { ok: true, state: { ...onboardingBaseState, revision: 3 } },
    { userId: 7, relationshipId: 41, petType: 'pig' },
  ).revision,
  4,
)
assert.equal(
  selectPetOnboardingStateForContext(
    { ...onboardingBaseState, revision: 4 },
    null,
    { userId: 7, relationshipId: 41, petType: 'pig' },
  ).revision,
  4,
)
assert.equal(
  isPetOnboardingStateCurrent({
    authenticated: true,
    petType: 'pig',
    userId: 7,
    relationship: onboardingRelationship,
    state: onboardingBaseState,
    documentVisible: true,
    now: onboardingUiNow,
  }),
  true,
)
assert.equal(
  isPetOnboardingStateCurrent({
    authenticated: true,
    petType: 'pig',
    userId: 8,
    relationship: onboardingRelationship,
    state: onboardingBaseState,
    documentVisible: true,
    now: onboardingUiNow,
  }),
  false,
)
assert.equal(
  isPetOnboardingStateCurrent({
    authenticated: true,
    petType: 'pig',
    userId: 7,
    relationship: onboardingRelationship,
    state: {
      ...onboardingBaseState,
      snoozed_until: '2026-08-13T08:00:00.000Z',
    },
    documentVisible: true,
    now: onboardingUiNow,
  }),
  false,
)
assert.equal(
  derivePetOnboardingScene(onboardingBaseState),
  PET_ONBOARDING_SCENES.RELATIONSHIP,
)
const onboardingRelationshipSeen = {
  ...onboardingBaseState,
  observed_capability_ids: [PANEL_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED],
}
assert.equal(
  derivePetOnboardingScene(onboardingRelationshipSeen),
  PET_ONBOARDING_SCENES.REMINDER_OFFER,
)
const onboardingWaiting = {
  ...onboardingRelationshipSeen,
  observed_capability_ids: [
    PANEL_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
    PANEL_ONBOARDING_CAPABILITIES.REMINDER_CREATED,
  ],
  reminder_id: 73,
}
assert.equal(
  derivePetOnboardingScene(onboardingWaiting),
  PET_ONBOARDING_SCENES.REMINDER_WAITING,
)
assert.equal(
  derivePetOnboardingScene({
    ...onboardingBaseState,
    reminder_id: 73,
    observed_capability_ids: [PANEL_ONBOARDING_CAPABILITIES.REMINDER_CREATED],
  }),
  PET_ONBOARDING_SCENES.REMINDER_WAITING,
)
assert.equal(
  derivePetOnboardingScene({
    ...onboardingWaiting,
    observed_capability_ids: [
      ...onboardingWaiting.observed_capability_ids,
      PANEL_ONBOARDING_CAPABILITIES.REMINDER_COMPLETED,
    ],
  }),
  null,
)
const onboardingSampleReminder = createPetOnboardingSampleReminderPayload('zh-CN', onboardingUiNow)
assert.equal(onboardingSampleReminder.pet_type, 'pig')
assert.equal(onboardingSampleReminder.title, '喝水')
assert.equal(
  Date.parse(onboardingSampleReminder.remind_at) - onboardingUiNow.getTime(),
  60_000,
)
assert.equal(isPetOnboardingReminderMatch(73, '73'), true)
assert.equal(isPetOnboardingReminderMatch(73, 74), false)
assert.deepEqual(
  unwrapPetOnboardingStateResponse({ ok: true, state: onboardingWaiting }),
  normalizePetOnboardingMainStateResponse(onboardingWaiting),
)
assert.equal(unwrapPetOnboardingStateResponse({ ok: false, reason: 'stale' }), null)
assert.equal(isPetOnboardingMainPanelIntent(PET_ONBOARDING_MAIN_PANEL_INTENT), true)
assert.equal(isPetOnboardingMainPanelIntent({ intent: PET_ONBOARDING_MAIN_PANEL_INTENT }), true)
assert.equal(isPetOnboardingMainPanelIntent({ intent: 'unrelated' }), false)

const projectedPetOnboarding = projectPetOnboardingStateForPet(onboardingCreated.state)
const projectedMainOnboarding = projectPetOnboardingStateForMain(onboardingCreated.state)
assert.deepEqual(
  Object.keys(projectedPetOnboarding).sort(),
  [...PET_ONBOARDING_PET_DTO_FIELDS].sort(),
)
assert.deepEqual(
  Object.keys(projectedMainOnboarding).sort(),
  [...PET_ONBOARDING_MAIN_DTO_FIELDS].sort(),
)
assert.equal(Object.hasOwn(projectedPetOnboarding, 'reminder_id'), false)
assert.equal(Object.hasOwn(projectedPetOnboarding, 'created_at'), false)
assert.equal(Object.hasOwn(projectedMainOnboarding, 'presentation'), false)
assert.equal(Object.hasOwn(projectedMainOnboarding, 'engaged_elapsed_ms'), false)
assert.equal(JSON.stringify(projectedMainOnboarding).includes('created_at'), false)
assert.equal(projectPetOnboardingStateForRole(onboardingCreated.state, 'quick-chat'), null)
projectedPetOnboarding.shown_step_ids.push('renderer-only')
assert.equal(onboardingCreated.state.shown_step_ids.includes('renderer-only'), false)
assert.deepEqual(
  normalizePetOnboardingStateResponse(projectPetOnboardingStateForPet(onboardingCreated.state)),
  projectPetOnboardingStateForPet(onboardingCreated.state),
)
assert.deepEqual(
  normalizePetOnboardingMainStateResponse(projectedMainOnboarding),
  projectedMainOnboarding,
)
assert.equal(normalizePetOnboardingMainStateResponse({
  ...projectedMainOnboarding,
  created_at: onboardingCreated.state.created_at,
}), null)

let latestBroadcastState = { ...onboardingCreated.state, revision: 7 }
let broadcastLoading = true
const broadcastListeners = []
const onboardingBroadcastPayloads = []
const broadcastSender = {
  isDestroyed: () => false,
  isLoading: () => broadcastLoading,
  once: (event, listener) => broadcastListeners.push({ event, listener }),
}
const petBroadcastWindow = {
  __role: 'pet',
  isDestroyed: () => false,
  webContents: broadcastSender,
}
const onboardingBroadcaster = createPetOnboardingStateBroadcaster({
  getCurrentState: () => latestBroadcastState,
  projectStateForRole: projectPetOnboardingStateForRole,
  send: (_target, payload) => onboardingBroadcastPayloads.push(payload),
})
assert.equal(onboardingBroadcaster.sendLatest(petBroadcastWindow), true)
latestBroadcastState = { ...latestBroadcastState, revision: 8 }
assert.equal(onboardingBroadcaster.sendLatest(petBroadcastWindow), true)
assert.equal(broadcastListeners.length, 1)
assert.equal(onboardingBroadcastPayloads.length, 0)
broadcastLoading = false
broadcastListeners[0].listener()
assert.equal(onboardingBroadcastPayloads.length, 1)
assert.equal(onboardingBroadcastPayloads[0].revision, 8)
assert.equal(onboardingBroadcaster.isPending(petBroadcastWindow), false)
assert.equal(onboardingBroadcaster.sendLatest({
  ...petBroadcastWindow,
  __role: 'quick-chat',
}), false)
assert.equal(onboardingBroadcastPayloads.length, 1)

const circularTelemetry = {
  event: 'spoofed-event',
  ts: 'spoofed-time',
  role: 'main-panel',
  view: '__proto__',
  nested: {
    expectedContext: { authoritative: { id: 'secret-capability' } },
    authorization: 'Bearer secret-token',
  },
  count: 1n,
}
circularTelemetry.self = circularTelemetry
const sanitizedTelemetry = sanitizeRendererTelemetryPayload(circularTelemetry)
assert.equal(sanitizedTelemetry.nested.expectedContext, RENDERER_TELEMETRY_MARKERS.REDACTED)
assert.equal(sanitizedTelemetry.nested.authorization, RENDERER_TELEMETRY_MARKERS.REDACTED)
assert.equal(sanitizedTelemetry.self, RENDERER_TELEMETRY_MARKERS.CIRCULAR)
assert.equal(sanitizedTelemetry.count, '1')
const telemetryRecord = createRendererTelemetryRecord({
  role: 'pet',
  event: 'renderer-debug',
  payload: circularTelemetry,
  now: new Date('2026-08-12T10:00:00.000Z'),
})
assert.equal(telemetryRecord.ok, true)
assert.equal(telemetryRecord.record.event, 'renderer-debug')
assert.equal(telemetryRecord.record.role, 'pet')
assert.equal(telemetryRecord.record.ts, '2026-08-12T10:00:00.000Z')
assert.equal(telemetryRecord.record.payload.event, 'spoofed-event')
assert.equal(createRendererTelemetryRecord({ role: 'unknown', event: 'renderer-debug' }).ok, false)
const quickHeartbeat = createRendererHeartbeatRecord({
  role: 'quick-chat',
  payload: { view: 'main-panel', token: 'secret' },
  now: new Date('2026-08-12T10:00:00.000Z'),
})
assert.equal(quickHeartbeat.ok, true)
assert.equal(quickHeartbeat.key, 'quick-chat')
assert.equal(quickHeartbeat.heartbeat.role, 'quick-chat')
assert.equal(quickHeartbeat.heartbeat.payload.token, RENDERER_TELEMETRY_MARKERS.REDACTED)

const fixedNow = new Date('2026-07-06T10:00:00+08:00')

const todayMeeting = parseOneTimeReminder('下午三点有一个会议', fixedNow)
assert.equal(todayMeeting.ok, true)
assert.equal(todayMeeting.title, '开会')
assert.equal(todayMeeting.recurrenceType, 'once')
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

const dailyWater = parseReminder('每天上午九点提醒我喝水', fixedNow)
assert.equal(dailyWater.ok, true)
assert.equal(dailyWater.title, '喝水')
assert.equal(dailyWater.recurrenceType, 'daily')
assert.equal(dailyWater.remindAt.getTime(), new Date('2026-07-07T09:00:00+08:00').getTime())

const conciseDailyWater = parseReminder('每天上午九点喝水', fixedNow)
assert.equal(conciseDailyWater.ok, true)
assert.equal(conciseDailyWater.title, '喝水')
assert.equal(conciseDailyWater.recurrenceType, 'daily')

const weekdayReport = parseReminder('工作日下午三点提醒我交日报', fixedNow)
assert.equal(weekdayReport.ok, true)
assert.equal(weekdayReport.title, '交日报')
assert.equal(weekdayReport.recurrenceType, 'weekdays')
assert.equal(weekdayReport.remindAt.getTime(), new Date('2026-07-06T15:00:00+08:00').getTime())

const weeklyMeeting = parseReminder('每周三下午三点提醒我周会', fixedNow)
assert.equal(weeklyMeeting.ok, true)
assert.equal(weeklyMeeting.title, '周会')
assert.equal(weeklyMeeting.recurrenceType, 'weekly')
assert.equal(weeklyMeeting.remindAt.getTime(), new Date('2026-07-08T15:00:00+08:00').getTime())
assert.equal(getReminderRecurrenceLabel('weekly', weeklyMeeting.remindAt, 'zh-CN'), '每周三')

const missingWeeklyDay = parseReminder('每周下午三点提醒我周会', fixedNow)
assert.equal(missingWeeklyDay.ok, false)
assert.equal(missingWeeklyDay.reason, 'missing_recurrence_day')

const rendererOnboardingState = normalizePetOnboardingStateResponse({
  ok: true,
  state: onboardingCreated.state,
})
assert.equal(rendererOnboardingState.user_id, 17)
assert.equal(
  normalizePetOnboardingStateResponse({ playback: onboardingCreated.state }).relationship_id,
  29,
)
assert.equal(normalizePetOnboardingStateResponse({ ...onboardingCreated.state, version: 2 }), null)
assert.deepEqual(
  normalizePetOnboardingStateResponse({
    ...onboardingCreated.state,
    shown_step_ids: [
      RENDERER_ONBOARDING_STEPS.MEET_PET,
      RENDERER_ONBOARDING_STEPS.MEET_PET,
      'future_step',
    ],
  }).shown_step_ids,
  [RENDERER_ONBOARDING_STEPS.MEET_PET],
)
assert.equal(
  deriveNextPetOnboardingStep(rendererOnboardingState),
  RENDERER_ONBOARDING_STEPS.MEET_PET,
)
assert.equal(
  deriveNextPetOnboardingStep({
    ...rendererOnboardingState,
    observed_capability_ids: [RENDERER_ONBOARDING_CAPABILITIES.PET_INTERACTION],
  }),
  RENDERER_ONBOARDING_STEPS.RELATIONSHIP,
)
assert.equal(
  deriveNextPetOnboardingStep({
    ...rendererOnboardingState,
    shown_step_ids: [RENDERER_ONBOARDING_STEPS.MEET_PET],
  }),
  RENDERER_ONBOARDING_STEPS.RELATIONSHIP,
)
assert.equal(
  deriveNextPetOnboardingStep({
    ...rendererOnboardingState,
    observed_capability_ids: [
      RENDERER_ONBOARDING_CAPABILITIES.PET_INTERACTION,
      RENDERER_ONBOARDING_CAPABILITIES.RELATIONSHIP_VIEWED,
    ],
  }),
  null,
)

const rendererRelationship = {
  id: 29,
  user_id: 17,
  pet_type: 'pig',
  level: 2,
  relationship_stage: 'getting_familiar',
}
const rendererAccountContext = { hasSession: true, userId: 17, petType: 'pig' }
assert.equal(createPetAccountContextKey(rendererAccountContext), '17:pig')
assert.equal(createPetAccountContextKey({ ...rendererAccountContext, hasSession: false }), null)
assert.equal(isPetAccountContextCurrent(
  rendererAccountContext,
  { hasSession: true, userId: '17', petType: 'pig' },
), true)
assert.equal(isPetAccountContextCurrent(
  rendererAccountContext,
  { hasSession: true, userId: 18, petType: 'pig' },
), false)
assert.equal(isPetRelationshipForAccountContext(rendererRelationship, rendererAccountContext), true)
assert.equal(isPetRelationshipForAccountContext(
  { ...rendererRelationship, user_id: 18 },
  rendererAccountContext,
), false)
assert.equal(isPetRelationshipForAccountContext(null, rendererAccountContext), false)
const rendererSafeContext = {
  petType: 'pig',
  hasSession: true,
  userId: 17,
  relationship: rendererRelationship,
  visibilityState: 'visible',
  systemIdleSeconds: 8,
  voicePhase: 'idle',
  pointerActive: false,
  settlingPointer: false,
  activeCareAction: '',
  transientBubble: '',
  animationState: { action: 'idle', locked: false },
  milestonePlayback: null,
  milestoneRequestInFlight: null,
  companionRequestInFlight: null,
  onboardingState: rendererOnboardingState,
  activeGuide: null,
  now: onboardingNow,
}
assert.equal(isPetOnboardingSafe(rendererSafeContext), true)
for (const unsafePatch of [
  { petType: 'cat' },
  { userId: 18 },
  { relationship: { ...rendererRelationship, user_id: 18 } },
  { visibilityState: 'hidden' },
  { systemIdleSeconds: 60 },
  { voicePhase: 'ready' },
  { pointerActive: true },
  { settlingPointer: true },
  { activeCareAction: 'pat' },
  { transientBubble: 'busy' },
  { animationState: { action: 'idle', locked: true } },
  { animationState: { action: 'look_around', locked: false } },
  { milestonePlayback: { status: 'claim' } },
  { milestoneRequestInFlight: { epoch: 1 } },
  { companionRequestInFlight: { type: 'companion' } },
  { activeGuide: { stepId: 'meet_pet' } },
  { onboardingState: { ...rendererOnboardingState, status: 'finished' } },
]) {
  assert.equal(isPetOnboardingSafe({ ...rendererSafeContext, ...unsafePatch }), false)
}
assert.equal(
  isPetOnboardingSafe({
    ...rendererSafeContext,
    onboardingState: {
      ...rendererOnboardingState,
      snoozed_until: new Date(onboardingNow.getTime() + 1000).toISOString(),
    },
  }),
  false,
)
assert.equal(
  isPetOnboardingRendererContextCurrent({
    expectedEpoch: 3,
    currentEpoch: 3,
    expectedUserId: 17,
    currentUserId: 17,
    expectedRelationshipId: 29,
    currentRelationshipId: 29,
    petType: 'pig',
    hasSession: true,
  }),
  true,
)
assert.equal(
  isPetOnboardingRendererContextCurrent({
    expectedEpoch: 3,
    currentEpoch: 4,
    expectedUserId: 17,
    currentUserId: 17,
    expectedRelationshipId: 29,
    currentRelationshipId: 29,
    petType: 'pig',
    hasSession: true,
  }),
  false,
)
assert.equal(
  isPetOnboardingRendererContextCurrent({
    expectedEpoch: 3,
    currentEpoch: 3,
    expectedUserId: null,
    currentUserId: null,
    expectedRelationshipId: null,
    currentRelationshipId: null,
    petType: 'pig',
    hasSession: true,
  }),
  false,
)

assert.equal(getPetOnboardingEngagementDelta({
  previousTickMs: 1000,
  currentTickMs: 1900,
  documentVisible: true,
  systemIdleSeconds: 4,
  state: rendererOnboardingState,
}), 900)
assert.equal(getPetOnboardingEngagementDelta({
  previousTickMs: 1000,
  currentTickMs: 15000,
  documentVisible: true,
  systemIdleSeconds: 4,
  state: rendererOnboardingState,
}), 1000)
assert.equal(getPetOnboardingEngagementDelta({
  previousTickMs: 1000,
  currentTickMs: 1900,
  documentVisible: false,
  systemIdleSeconds: 4,
  state: rendererOnboardingState,
}), 0)
assert.equal(getPetOnboardingEngagementDelta({
  previousTickMs: 1000,
  currentTickMs: 1900,
  documentVisible: true,
  systemIdleSeconds: 60,
  state: rendererOnboardingState,
}), 0)
assert.equal(getPetOnboardingEngagementDelta({
  previousTickMs: onboardingNow.getTime(),
  currentTickMs: onboardingNow.getTime() + 900,
  documentVisible: true,
  systemIdleSeconds: 4,
  state: {
    ...rendererOnboardingState,
    snoozed_until: new Date(onboardingNow.getTime() + 5000).toISOString(),
  },
}), 0)

const meetCopyZh = getPetOnboardingCopy(RENDERER_ONBOARDING_STEPS.MEET_PET, 'zh-CN')
const meetCopyEn = getPetOnboardingCopy(RENDERER_ONBOARDING_STEPS.MEET_PET, 'en')
assert.equal(meetCopyZh.id, meetCopyEn.id)
assert.match(meetCopyZh.body, /摸摸|拖拽/)
const relationshipCopyZh = getPetOnboardingCopy(
  RENDERER_ONBOARDING_STEPS.RELATIONSHIP,
  'zh-CN',
  rendererRelationship,
)
const relationshipCopyEn = getPetOnboardingCopy(
  RENDERER_ONBOARDING_STEPS.RELATIONSHIP,
  'en',
  rendererRelationship,
)
assert.equal(relationshipCopyZh.id, relationshipCopyEn.id)
assert.match(relationshipCopyZh.title, /Lv\.2/)
assert.match(relationshipCopyZh.body, /不会倒退/)
assert.equal(relationshipCopyZh.action, '看看我们')
assert.match(relationshipCopyEn.title, /Lv\.2/)
assert.equal(
  getPetOnboardingGuideTimeoutAction(RENDERER_ONBOARDING_STEPS.MEET_PET),
  'ack',
)
assert.equal(
  getPetOnboardingGuideTimeoutAction(RENDERER_ONBOARDING_STEPS.RELATIONSHIP),
  'release',
)
assert.equal(getPetOnboardingGuideTimeoutAction('unknown'), null)
const relationshipCooldownUntil = getPetOnboardingGuideCooldownUntil({
  stepId: RENDERER_ONBOARDING_STEPS.RELATIONSHIP,
  reason: 'display-timeout',
  nowMs: 12_000,
})
assert.equal(relationshipCooldownUntil, 42_000)
assert.equal(isPetOnboardingGuideCoolingDown(relationshipCooldownUntil, 41_999), true)
assert.equal(isPetOnboardingGuideCoolingDown(relationshipCooldownUntil, 42_000), false)
assert.equal(getPetOnboardingGuideCooldownUntil({
  stepId: RENDERER_ONBOARDING_STEPS.MEET_PET,
  reason: 'display-timeout',
  nowMs: 12_000,
}), null)
assert.equal(getPetOnboardingGuideCooldownUntil({
  stepId: RENDERER_ONBOARDING_STEPS.RELATIONSHIP,
  reason: 'higher-priority-interruption',
  nowMs: 12_000,
}), null)
assert.equal(getPetOnboardingGuideCooldownUntil({
  stepId: RENDERER_ONBOARDING_STEPS.MEET_PET,
  reason: 'lease-rejected',
  nowMs: 12_000,
}), 42_000)
assert.equal(canCommitPetCompanionResult({
  onboardingGuide: null,
  onboardingRequestInFlight: null,
}), true)
assert.equal(canCommitPetCompanionResult({
  onboardingGuide: { stepId: RENDERER_ONBOARDING_STEPS.RELATIONSHIP },
  onboardingRequestInFlight: null,
}), false)
assert.equal(canCommitPetCompanionResult({
  onboardingGuide: null,
  onboardingRequestInFlight: { type: 'claim' },
}), false)
assert.equal(shouldRecordPetOnboardingInteraction({
  loaded: true,
  state: rendererOnboardingState,
}), true)
assert.equal(shouldRecordPetOnboardingInteraction({
  loaded: false,
  state: rendererOnboardingState,
}), false)
assert.equal(shouldRecordPetOnboardingInteraction({ loaded: true, state: null }), false)
assert.equal(shouldRecordPetOnboardingInteraction({
  loaded: true,
  state: { ...rendererOnboardingState, status: 'finished' },
}), false)
assert.match(
  createPetOnboardingPresentationToken(),
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
)

const accountA = { userId: 17, petType: 'pig', relationshipId: 29 }
const accountB = { userId: 18, petType: 'pig', relationshipId: 31 }
assert.equal(createStableAccountContextKey(accountA, { requireRelationship: true }), '17:29:pig')
assert.equal(createStableAccountContextKey({ ...accountA, relationshipId: null }, { requireRelationship: true }), null)
assert.equal(authorizeSessionClear({
  senderRole: 'pet',
  expectedSession: { token: 'token-a', generation: 1 },
  currentSession: { token: 'token-b', generation: 2 },
}), false)
assert.equal(authorizeSessionClear({
  senderRole: 'pet',
  expectedSession: { token: 'token-b', generation: 2 },
  currentSession: { token: 'token-b', generation: 2 },
}), true)
assert.equal(authorizeSessionClear({
  senderRole: 'pet',
  expectedSession: { token: 'token-b', generation: 1 },
  currentSession: { token: 'token-b', generation: 3 },
}), false)
assert.equal(authorizeSessionClear({
  senderRole: 'quick-chat',
  currentSession: { token: 'token-b', generation: 2 },
}), false)
assert.equal(authorizeSessionClear({
  senderRole: 'main-panel',
  currentSession: { token: 'token-b', generation: 2 },
}), true)
assert.deepEqual(authorizeSwitchPet({
  senderRole: 'main-panel',
  expectedUserId: 17,
  currentSessionSubject: 18,
  activeUserId: 18,
}), { ok: false, reason: 'identity-mismatch' })
assert.deepEqual(authorizeSwitchPet({
  senderRole: 'main-panel',
  expectedUserId: 18,
  currentSessionSubject: 18,
  activeUserId: 18,
  expectedSession: { token: 'token-b', generation: 1 },
  currentSession: { token: 'token-b', generation: 3 },
  expectedFromPet: 'cat',
  currentPet: 'cat',
}), { ok: false, reason: 'session-mismatch' })
assert.deepEqual(authorizeSwitchPet({
  senderRole: 'main-panel',
  expectedUserId: 18,
  currentSessionSubject: 18,
  activeUserId: 18,
  expectedSession: { token: 'token-b', generation: 3 },
  currentSession: { token: 'token-b', generation: 3 },
  expectedFromPet: 'dog',
  currentPet: 'cat',
}), { ok: false, reason: 'pet-mismatch' })
assert.deepEqual(authorizeSwitchPet({
  senderRole: 'main-panel',
  expectedUserId: 18,
  currentSessionSubject: 18,
  activeUserId: 18,
  expectedSession: { token: 'token-b', generation: 3 },
  currentSession: { token: 'token-b', generation: 3 },
  expectedFromPet: 'cat',
  currentPet: 'cat',
}), { ok: true })
assert.deepEqual(authorizeAccountMutation({
  senderRole: 'pet',
  allowedRoles: ['pet'],
  expectedContext: accountA,
  currentContext: accountB,
  requireRelationship: true,
}), { ok: false, reason: 'account-mismatch' })
assert.deepEqual(authorizeAccountMutation({
  senderRole: 'pet',
  allowedRoles: ['pet'],
  expectedContext: accountB,
  currentContext: accountB,
  requireRelationship: true,
}), { ok: false, reason: 'session-mismatch' })
assert.deepEqual(authorizeAccountMutation({
  senderRole: 'pet',
  allowedRoles: ['pet'],
  expectedContext: {
    ...accountB,
    session: { token: 'token-b', generation: 2 },
  },
  currentContext: {
    ...accountB,
    session: { token: 'token-b', generation: 3 },
  },
  requireRelationship: true,
}), { ok: false, reason: 'session-mismatch' })
assert.deepEqual(authorizeAccountMutation({
  senderRole: 'pet',
  allowedRoles: ['pet'],
  expectedContext: {
    ...accountB,
    session: { token: 'token-b', generation: 3 },
  },
  currentContext: {
    ...accountB,
    session: { token: 'token-b', generation: 3 },
  },
  requireRelationship: true,
}), { ok: true })

const accountBoundMilestoneStore = setPetMilestonePlaybackEntry({
  playbackByPet: {},
  petType: 'pig',
  storageKey: '17:pig',
  accountUserId: 17,
  playback: milestoneClaimState,
  expectedRevision: 0,
  updatedAt: '2026-08-19T00:00:00.000Z',
})
assert.equal(accountBoundMilestoneStore.ok, true)
assert.equal(accountBoundMilestoneStore.playback.account_user_id, 17)
assert.equal(readPetMilestonePlaybackEntry(
  accountBoundMilestoneStore.playbackByPet,
  'pig',
  { storageKey: '17:pig', accountUserId: 17 },
).playback?.account_user_id, 17)
assert.equal(readPetMilestonePlaybackEntry(
  accountBoundMilestoneStore.playbackByPet,
  'pig',
  { storageKey: '18:pig', accountUserId: 18 },
).playback, null)

const anonymousLegacyMilestone = readPetMilestonePlaybackEntry(
  { pig: milestonePlayingState },
  'pig',
  { storageKey: '17:pig', accountUserId: 17 },
)
assert.equal(anonymousLegacyMilestone.playback, null)
assert.equal(anonymousLegacyMilestone.changed, true)
assert.equal(Object.hasOwn(anonymousLegacyMilestone.playbackByPet, 'pig'), false)
assert.equal(Object.hasOwn(anonymousLegacyMilestone.playbackByPet, '17:pig'), false)

const matchingLegacyPlayback = {
  ...milestoneAckPendingState,
  account_user_id: 17,
  revision: 4,
}
const migratedMatchingLegacy = readPetMilestonePlaybackEntry(
  { pig: matchingLegacyPlayback },
  'pig',
  { storageKey: '17:pig', accountUserId: 17 },
)
assert.equal(migratedMatchingLegacy.changed, true)
assert.deepEqual(migratedMatchingLegacy.playback, matchingLegacyPlayback)
assert.deepEqual(migratedMatchingLegacy.playbackByPet['17:pig'], matchingLegacyPlayback)
assert.equal(Object.hasOwn(migratedMatchingLegacy.playbackByPet, 'pig'), false)

const otherAccountLegacyPlayback = {
  ...milestonePlayingState,
  account_user_id: 18,
  revision: 6,
}
const isolatedOtherAccountLegacy = readPetMilestonePlaybackEntry(
  { pig: otherAccountLegacyPlayback },
  'pig',
  { storageKey: '17:pig', accountUserId: 17 },
)
assert.equal(isolatedOtherAccountLegacy.playback, null)
assert.deepEqual(isolatedOtherAccountLegacy.playbackByPet['18:pig'], otherAccountLegacyPlayback)
assert.equal(Object.hasOwn(isolatedOtherAccountLegacy.playbackByPet, 'pig'), false)

const setAfterAnonymousLegacy = setPetMilestonePlaybackEntry({
  playbackByPet: { pig: milestonePlayingState },
  petType: 'pig',
  storageKey: '17:pig',
  accountUserId: 17,
  playback: milestoneClaimState,
  expectedRevision: 0,
  updatedAt: '2026-08-19T00:01:00.000Z',
})
assert.equal(setAfterAnonymousLegacy.ok, true)
assert.equal(Object.hasOwn(setAfterAnonymousLegacy.playbackByPet, 'pig'), false)
assert.equal(setAfterAnonymousLegacy.playback.revision, 1)

const setAfterMatchingLegacy = setPetMilestonePlaybackEntry({
  playbackByPet: { pig: matchingLegacyPlayback },
  petType: 'pig',
  storageKey: '17:pig',
  accountUserId: 17,
  playback: { ...matchingLegacyPlayback, status: PET_MILESTONE_PLAYBACK_STATUS.CLAIM },
  expectedRevision: 4,
  updatedAt: '2026-08-19T00:02:00.000Z',
})
assert.equal(setAfterMatchingLegacy.ok, true)
assert.equal(setAfterMatchingLegacy.playback.revision, 5)
assert.equal(Object.hasOwn(setAfterMatchingLegacy.playbackByPet, 'pig'), false)

const clearAfterMatchingLegacy = clearPetMilestonePlaybackEntry({
  playbackByPet: { pig: matchingLegacyPlayback },
  petType: 'pig',
  storageKey: '17:pig',
  accountUserId: 17,
  claimToken: matchingLegacyPlayback.claim_token,
  expectedRevision: 4,
})
assert.equal(clearAfterMatchingLegacy.ok, true)
assert.equal(Object.hasOwn(clearAfterMatchingLegacy.playbackByPet, 'pig'), false)
assert.equal(Object.hasOwn(clearAfterMatchingLegacy.playbackByPet, '17:pig'), false)

const currentWithAnonymousLegacy = {
  pig: milestonePlayingState,
  '17:pig': matchingLegacyPlayback,
}
const wrongMigratedClear = clearPetMilestonePlaybackSnapshot({
  playbackByPet: currentWithAnonymousLegacy,
  petType: 'pig',
  storageKey: '17:pig',
  accountUserId: 17,
  claimToken: 'wrong-claim',
  expectedRevision: 4,
})
assert.equal(wrongMigratedClear.ok, false)
assert.equal(wrongMigratedClear.reason, 'revision-conflict')
assert.equal(Object.hasOwn(wrongMigratedClear.playbackByPet, 'pig'), false)
assert.deepEqual(wrongMigratedClear.playbackByPet['17:pig'], matchingLegacyPlayback)
const clearedMigratedCurrent = clearPetMilestonePlaybackSnapshot({
  playbackByPet: currentWithAnonymousLegacy,
  petType: 'pig',
  storageKey: '17:pig',
  accountUserId: 17,
  claimToken: matchingLegacyPlayback.claim_token,
  expectedRevision: 4,
})
assert.equal(clearedMigratedCurrent.ok, true)
assert.equal(Object.hasOwn(clearedMigratedCurrent.playbackByPet, 'pig'), false)
assert.equal(Object.hasOwn(clearedMigratedCurrent.playbackByPet, '17:pig'), false)

assert.equal(isPetAccountOperationCurrent(accountA, accountA, { requireRelationship: true }), true)
assert.equal(isPetAccountOperationCurrent(accountA, accountB, { requireRelationship: true }), false)
assert.equal(isPetAccountOperationCurrent(
  { hasSession: true, userId: 17, petType: 'pig' },
  { hasSession: true, userId: 18, petType: 'pig' },
), false)
assert.deepEqual(createRelationshipScopedRuntimeReset({ milestoneId: 88 }), {
  relationship: null,
  equippedOutfit: null,
  previewOutfit: null,
  intimacyFeedback: '',
  transientBubble: '',
  companionState: 'reset',
  milestonePlayback: null,
  onboardingState: null,
  animationCompletion: { type: 'ANIMATION_DONE', milestoneId: 88 },
})
assert.deepEqual(createMainPanelRelationshipNullReset(), {
  companionState: 'reset',
  petRelationshipLoading: false,
  petDailySummaryLoading: false,
  petOnboardingBusy: false,
  petOnboardingError: '',
  savingPet: false,
  savingOutfit: false,
  savingCompanionSettings: false,
})

const initialSessionSnapshot = Object.freeze({ token: 'token-a', generation: 1 })
assert.equal(isSessionSnapshotCurrent(
  initialSessionSnapshot,
  { token: 'token-a', generation: 1 },
), true)
assert.equal(isSessionSnapshotCurrent(
  initialSessionSnapshot,
  { token: 'token-a', generation: 3 },
), false)
assert.deepEqual(
  createSessionOperationContext(initialSessionSnapshot, { userId: 17, petType: 'pig' }),
  { session: initialSessionSnapshot, userId: 17, petType: 'pig' },
)
for (const forgedSession of [
  null,
  { token: 'token-a', generation: 0 },
  { token: 'token-b', generation: 2 },
]) {
  assert.throws(
    () => createSessionOperationContext(initialSessionSnapshot, {
      userId: 17,
      petType: 'pig',
      session: forgedSession,
    }),
    (error) => error?.code === AUTH_CONTEXT_CHANGED_CODE,
  )
}
assert.deepEqual(
  createSessionOperationContext(initialSessionSnapshot, {
    userId: 17,
    session: { token: 'token-a', generation: 1 },
  }),
  { session: initialSessionSnapshot, userId: 17 },
)
assert.deepEqual(createLocalOperationContext({
  scope: 'relationship',
  userId: 17,
  petType: 'pig',
  relationshipId: 29,
  epoch: 6,
}), {
  scope: 'relationship',
  userId: 17,
  petType: 'pig',
  relationshipId: 29,
  accountEpoch: 6,
  petEpoch: 6,
  relationshipEpoch: 6,
})

const authoritativeState = createAuthoritativeOperationContextState()
const authoritativeBase = {
  hasSession: true,
  session: initialSessionSnapshot,
  userId: 17,
  petType: 'pig',
  relationshipId: 29,
}
let capabilityNow = 1000
let nextCapabilityId = 0
const capabilityState = createAuthoritativeOperationContextState()
const capabilityRegistry = createOperationCapabilityRegistry({
  authoritativeState: capabilityState,
  now: () => capabilityNow,
  ttlMs: 5000,
  createId: () => `cap-${++nextCapabilityId}`,
})
const petSender = { id: 'pet-web-contents' }
const otherPetSender = { id: 'other-pet-web-contents' }
const mainSender = { id: 'main-web-contents' }
const petCapability = capabilityRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'pet',
  currentContext: authoritativeBase,
})
assert.equal(petCapability.id, 'cap-1')
assert.deepEqual(Object.keys(petCapability), ['id'])
assert.equal(JSON.stringify(petCapability).includes('token-a'), false)
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: { ...petCapability, scope: 'relationship', petRevision: 999 },
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).ok, true)
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: { ...petCapability, scope: 'relationship', relationshipRevision: 999 },
  requiredScope: 'relationship',
  currentContext: authoritativeBase,
}).ok, false)
assert.equal(capabilityRegistry.authorize({
  sender: otherPetSender,
  senderRole: 'pet',
  capability: petCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).reason, 'capability-sender-mismatch')
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: null,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).reason, 'capability-required')
assert.equal(capabilityRegistry.issue({
  sender: mainSender,
  senderRole: 'main-panel',
  scope: 'account',
  currentContext: { ...authoritativeBase, hasSession: false },
}), null)
assert.equal(capabilityRegistry.issue({
  sender: mainSender,
  senderRole: 'main-panel',
  scope: 'account',
  currentContext: { ...authoritativeBase, userId: null },
}), null)
assert.equal(capabilityRegistry.issue({
  sender: mainSender,
  senderRole: 'unknown',
  scope: 'account',
  currentContext: authoritativeBase,
}), null)
capabilityNow = 7001
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: petCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).reason, 'capability-expired')
const renewedPetCapability = capabilityRegistry.renew({
  sender: petSender,
  senderRole: 'pet',
  requiredScope: 'pet',
  currentContext: authoritativeBase,
  capability: petCapability,
  expectedSemantic: { userId: 17, petType: 'pig' },
})
assert.deepEqual(renewedPetCapability, petCapability)
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: renewedPetCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).ok, true)
const relationshipCapability = capabilityRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'relationship',
  currentContext: authoritativeBase,
  expectedContext: { ...authoritativeBase, authoritative: renewedPetCapability },
})
let transitionContext = authoritativeBase
const postWrite = capabilityRegistry.transition({
  sender: petSender,
  senderRole: 'pet',
  capability: relationshipCapability,
  requiredScope: 'relationship',
  currentContext: transitionContext,
  nextScope: 'relationship',
  apply: () => {
    transitionContext = { ...authoritativeBase, relationshipId: 31 }
    capabilityState.observe(transitionContext)
    return { id: 31, user_id: 17, pet_type: 'pig' }
  },
  getCurrentContext: () => transitionContext,
})
assert.equal(postWrite.ok, true)
assert.equal(postWrite.value.id, 31)
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: relationshipCapability,
  requiredScope: 'relationship',
  currentContext: transitionContext,
}).ok, false)
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: postWrite.capability,
  requiredScope: 'relationship',
  currentContext: transitionContext,
}).ok, true)
assert.equal(capabilityRegistry.revokeSender(petSender), 1)
assert.equal(capabilityRegistry.authorize({
  sender: petSender,
  senderRole: 'pet',
  capability: relationshipCapability,
  requiredScope: 'relationship',
  currentContext: authoritativeBase,
}).reason, 'capability-not-found')
const upgradePetCapability = capabilityRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'pet',
  currentContext: transitionContext,
})
assert.equal(capabilityRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'relationship',
  currentContext: transitionContext,
  expectedContext: {
    ...transitionContext,
    authoritative: { ...upgradePetCapability, id: 'forged-capability' },
  },
}), null)
assert.equal(capabilityRegistry.issue({
  sender: otherPetSender,
  senderRole: 'pet',
  scope: 'relationship',
  currentContext: transitionContext,
  expectedContext: { ...transitionContext, authoritative: upgradePetCapability },
}), null)
assert.equal(capabilityRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'relationship',
  currentContext: transitionContext,
  expectedContext: { ...transitionContext, authoritative: upgradePetCapability },
})?.id, upgradePetCapability.id)

const boundedRegistry = createOperationCapabilityRegistry({
  authoritativeState: createAuthoritativeOperationContextState(),
  now: () => capabilityNow,
  ttlMs: 5000,
  maxPerSender: 3,
  createId: () => `bounded-${++nextCapabilityId}`,
})
const boundedCapabilities = Array.from({ length: 5 }, () => boundedRegistry.issueTrusted({
  sender: mainSender,
  senderRole: 'main-panel',
  scope: 'pet',
  currentContext: authoritativeBase,
}))
assert.equal(boundedRegistry.sizeForSender(mainSender), 3)
assert.equal(boundedRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: boundedCapabilities[0],
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).reason, 'capability-not-found')

let renewAbaContext = authoritativeBase
const renewAbaState = createAuthoritativeOperationContextState()
const renewAbaRegistry = createOperationCapabilityRegistry({
  authoritativeState: renewAbaState,
  now: () => capabilityNow,
  ttlMs: 10,
  createId: () => `renew-aba-${++nextCapabilityId}`,
})
const renewAbaCapability = renewAbaRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'pet',
  currentContext: renewAbaContext,
})
renewAbaContext = { ...renewAbaContext, petType: 'dog' }
renewAbaState.observe(renewAbaContext)
renewAbaContext = { ...renewAbaContext, petType: 'pig' }
renewAbaState.observe(renewAbaContext)
capabilityNow += 20
assert.equal(renewAbaRegistry.issue({
  sender: petSender,
  senderRole: 'pet',
  scope: 'pet',
  currentContext: renewAbaContext,
  expectedContext: { ...renewAbaContext, authoritative: renewAbaCapability },
}), null)
let accountAbaContext = authoritativeBase
const accountAbaState = createAuthoritativeOperationContextState()
const accountAbaRegistry = createOperationCapabilityRegistry({
  authoritativeState: accountAbaState,
  createId: () => `account-aba-${++nextCapabilityId}`,
})
const accountAbaCapability = accountAbaRegistry.issue({
  sender: mainSender,
  senderRole: 'main-panel',
  scope: 'account',
  currentContext: accountAbaContext,
})
accountAbaContext = { ...accountAbaContext, userId: 18 }
accountAbaState.observe(accountAbaContext)
accountAbaContext = { ...accountAbaContext, userId: 17 }
accountAbaState.observe(accountAbaContext)
assert.equal(accountAbaRegistry.issue({
  sender: mainSender,
  senderRole: 'main-panel',
  scope: 'account',
  currentContext: accountAbaContext,
  expectedContext: { ...accountAbaContext, authoritative: accountAbaCapability },
}), null)

let retainedScopeContext = authoritativeBase
const retainedScopeState = createAuthoritativeOperationContextState()
const retainedScopeRegistry = createOperationCapabilityRegistry({
  authoritativeState: retainedScopeState,
  createId: () => `retained-scope-${++nextCapabilityId}`,
})
const retainedRelationshipCapability = retainedScopeRegistry.issue({
  sender: mainSender,
  senderRole: 'main-panel',
  scope: 'relationship',
  currentContext: retainedScopeContext,
})
const attenuatedAccountCapability = retainedScopeRegistry.renew({
  sender: mainSender,
  senderRole: 'main-panel',
  requiredScope: 'account',
  currentContext: retainedScopeContext,
  capability: retainedRelationshipCapability,
  expectedSemantic: { userId: 17 },
})
assert.ok(attenuatedAccountCapability?.id)
assert.notEqual(attenuatedAccountCapability.id, retainedRelationshipCapability.id)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: attenuatedAccountCapability,
  requiredScope: 'account',
  currentContext: retainedScopeContext,
}).ok, true)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: retainedRelationshipCapability,
  requiredScope: 'relationship',
  currentContext: retainedScopeContext,
}).ok, true)
const secondAttenuatedAccountCapability = retainedScopeRegistry.renew({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: retainedRelationshipCapability,
  requiredScope: 'account',
  currentContext: retainedScopeContext,
  expectedSemantic: { userId: 17 },
})
assert.ok(secondAttenuatedAccountCapability?.id)
assert.notEqual(secondAttenuatedAccountCapability.id, retainedRelationshipCapability.id)
retainedScopeContext = { ...retainedScopeContext, relationshipId: 31 }
retainedScopeState.observe(retainedScopeContext)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: retainedRelationshipCapability,
  requiredScope: 'account',
  currentContext: retainedScopeContext,
}).ok, true)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: retainedRelationshipCapability,
  requiredScope: 'relationship',
  currentContext: retainedScopeContext,
}).ok, false)

const accountCapabilityAfterRelationshipChange = retainedScopeRegistry.renew({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: retainedRelationshipCapability,
  requiredScope: 'account',
  currentContext: retainedScopeContext,
  expectedSemantic: { userId: 17 },
})
assert.ok(accountCapabilityAfterRelationshipChange?.id)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: accountCapabilityAfterRelationshipChange,
  requiredScope: 'account',
  currentContext: retainedScopeContext,
}).ok, true)
const petCapabilityAfterRelationshipChange = retainedScopeRegistry.renew({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: retainedRelationshipCapability,
  requiredScope: 'pet',
  currentContext: retainedScopeContext,
  expectedSemantic: { userId: 17, petType: 'pig' },
})
assert.ok(petCapabilityAfterRelationshipChange?.id)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: petCapabilityAfterRelationshipChange,
  requiredScope: 'pet',
  currentContext: retainedScopeContext,
}).ok, true)
assert.equal(retainedScopeRegistry.authorize({
  sender: mainSender,
  senderRole: 'main-panel',
  capability: petCapabilityAfterRelationshipChange,
  requiredScope: 'relationship',
  currentContext: retainedScopeContext,
}).ok, false)

let lifecycleNow = 100
const lifecycleSender = { id: 'renderer-lifecycle' }
const lifecycleState = createAuthoritativeOperationContextState()
const lifecycleRegistry = createOperationCapabilityRegistry({
  authoritativeState: lifecycleState,
  now: () => lifecycleNow,
  ttlMs: 30,
  maxPerSender: 3,
  createId: () => `lifecycle-${++nextCapabilityId}`,
})
assert.equal(lifecycleRegistry.registerRendererInstance({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-1',
}), true)
const lifecycleActive = lifecycleRegistry.issue({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-1',
  scope: 'relationship',
  currentContext: authoritativeBase,
})
assert.ok(lifecycleActive?.id)
assert.equal(lifecycleRegistry.issue({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-1',
  scope: 'pet',
  currentContext: authoritativeBase,
}), null)
lifecycleNow = 131
assert.equal(lifecycleRegistry.authorize({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  capability: lifecycleActive,
  requiredScope: 'relationship',
  currentContext: authoritativeBase,
}).reason, 'capability-expired')
const lifecycleAttenuated = lifecycleRegistry.renew({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-1',
  capability: lifecycleActive,
  requiredScope: 'account',
  currentContext: authoritativeBase,
  expectedSemantic: { userId: 17 },
})
assert.ok(lifecycleAttenuated?.id)
assert.notEqual(lifecycleAttenuated.id, lifecycleActive.id)
assert.equal(lifecycleRegistry.authorize({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  capability: lifecycleActive,
  requiredScope: 'relationship',
  currentContext: authoritativeBase,
}).reason, 'capability-expired')
for (let index = 0; index < 8; index += 1) {
  lifecycleRegistry.issueTrusted({
    sender: lifecycleSender,
    senderRole: 'main-panel',
    rendererInstanceNonce: 'nonce-1',
    scope: 'pet',
    currentContext: authoritativeBase,
  })
}
assert.equal(lifecycleRegistry.authorize({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  capability: lifecycleAttenuated,
  requiredScope: 'account',
  currentContext: authoritativeBase,
}).ok, true)
assert.equal(lifecycleRegistry.registerRendererInstance({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-2',
}), true)
assert.equal(lifecycleRegistry.validate({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-1',
  capability: lifecycleAttenuated,
  currentContext: authoritativeBase,
}).ok, false)
const freshLifecycleCapability = lifecycleRegistry.issue({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-2',
  scope: 'pet',
  currentContext: authoritativeBase,
})
assert.ok(freshLifecycleCapability?.id)
assert.equal(lifecycleRegistry.registerRendererInstance({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-2',
}), true)
assert.equal(lifecycleRegistry.authorize({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  capability: freshLifecycleCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).ok, true)
assert.equal(lifecycleRegistry.expireAll(), 1)
assert.equal(lifecycleRegistry.authorize({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  capability: freshLifecycleCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).reason, 'capability-expired')
assert.deepEqual(lifecycleRegistry.renew({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-2',
  capability: freshLifecycleCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
  expectedSemantic: { userId: 17, petType: 'pig', relationshipId: 29 },
}), freshLifecycleCapability)
assert.equal(lifecycleRegistry.resetCapabilities(), 1)
assert.equal(lifecycleRegistry.authorize({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  capability: freshLifecycleCapability,
  requiredScope: 'pet',
  currentContext: authoritativeBase,
}).reason, 'capability-not-found')
assert.ok(lifecycleRegistry.issue({
  sender: lifecycleSender,
  senderRole: 'main-panel',
  rendererInstanceNonce: 'nonce-2',
  scope: 'pet',
  currentContext: authoritativeBase,
})?.id)

const pinnedTrustedRegistry = createOperationCapabilityRegistry({
  authoritativeState: createAuthoritativeOperationContextState(),
  maxPerSender: 1,
  createId: () => `trusted-pin-${++nextCapabilityId}`,
})
pinnedTrustedRegistry.registerRendererInstance({
  sender: lifecycleSender,
  senderRole: 'quick-chat',
  rendererInstanceNonce: 'trusted-nonce',
})
const trustedBroadcastCapability = pinnedTrustedRegistry.issueTrusted({
  sender: lifecycleSender,
  senderRole: 'quick-chat',
  rendererInstanceNonce: 'trusted-nonce',
  scope: 'relationship',
  currentContext: authoritativeBase,
})
assert.ok(trustedBroadcastCapability?.id)
assert.deepEqual(pinnedTrustedRegistry.renew({
  sender: lifecycleSender,
  senderRole: 'quick-chat',
  rendererInstanceNonce: 'trusted-nonce',
  capability: trustedBroadcastCapability,
  requiredScope: 'relationship',
  currentContext: authoritativeBase,
  expectedSemantic: { userId: 17, petType: 'pig', relationshipId: 29 },
}), trustedBroadcastCapability)
assert.equal(pinnedTrustedRegistry.issueTrusted({
  sender: lifecycleSender,
  senderRole: 'quick-chat',
  rendererInstanceNonce: 'trusted-nonce',
  scope: 'pet',
  currentContext: authoritativeBase,
}), null)

let broadcastRelationship = { id: 29, user_id: 17, pet_type: 'pig', level: 2 }
const broadcastPayloads = []
const broadcastRegistry = createOperationCapabilityRegistry({
  authoritativeState: createAuthoritativeOperationContextState(),
  createId: () => `broadcast-${++nextCapabilityId}`,
})
const relationshipBroadcast = accountBoundary.createRelationshipBroadcastOrchestrator({
  getCurrentRelationship: () => broadcastRelationship,
  getCurrentContext: () => ({
    ...authoritativeBase,
    relationshipId: broadcastRelationship.id,
  }),
  issueCapability: ({ target, currentContext }) => broadcastRegistry.issueTrusted({
    sender: target.sender,
    senderRole: target.role,
    scope: 'relationship',
    currentContext,
  }),
  send: (_target, payload) => broadcastPayloads.push(payload),
})
const quickBroadcastTarget = { sender: { id: 'quick-broadcast' }, role: 'quick-chat' }
const deferredRelationshipEmit = relationshipBroadcast.createDeferredEmit(quickBroadcastTarget)
broadcastRelationship = { id: 31, user_id: 17, pet_type: 'pig', level: 3 }
const currentBroadcastPayload = deferredRelationshipEmit()
assert.equal(currentBroadcastPayload.relationship.id, 31)
assert.deepEqual(currentBroadcastPayload.authoritative, { id: currentBroadcastPayload.authoritative.id })
assert.deepEqual(currentBroadcastPayload.semantic, {
  userId: 17,
  petType: 'pig',
  relationshipId: 31,
})
assert.equal(JSON.stringify(currentBroadcastPayload).includes('token-a'), false)
const adoptedQuickRelationship = await adoptRelationshipCapability({
  payload: currentBroadcastPayload,
  currentContext: { hasSession: true, userId: 17, petType: 'pig', relationshipId: 29 },
  validateCapability: (capability, requiredScope, semantic) => broadcastRegistry.authorize({
    sender: quickBroadcastTarget.sender,
    senderRole: quickBroadcastTarget.role,
    capability,
    requiredScope,
    currentContext: { ...authoritativeBase, relationshipId: 31 },
    expectedSemantic: semantic,
  }).ok,
})
assert.equal(adoptedQuickRelationship.relationship.id, 31)
assert.equal(adoptedQuickRelationship.local.scope, 'relationship')
assert.equal(await adoptRelationshipCapability({
  payload: {
    ...currentBroadcastPayload,
    relationship: { id: 29, user_id: 17, pet_type: 'pig' },
    semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
  },
  currentContext: { hasSession: true, userId: 17, petType: 'pig', relationshipId: null },
  validateCapability: (capability, requiredScope, semantic) => broadcastRegistry.authorize({
    sender: quickBroadcastTarget.sender,
    senderRole: quickBroadcastTarget.role,
    capability,
    requiredScope,
    currentContext: { ...authoritativeBase, relationshipId: 31 },
    expectedSemantic: semantic,
  }).ok,
}), null)
assert.deepEqual(await adoptPetStateCapability({
  payload: {
    hasSession: true,
    userId: 17,
    petType: 'dog',
    semantic: { userId: 17, petType: 'dog' },
    authoritative: { id: 'opaque-dog-cap' },
  },
  currentContext: { hasSession: true, userId: 17, petType: 'dog' },
  validateCapability: () => true,
}), {
  authoritative: { id: 'opaque-dog-cap' },
  userId: 17,
  petType: 'dog',
  local: {
    scope: 'pet',
    userId: 17,
    petType: 'dog',
    relationshipId: null,
    accountEpoch: undefined,
    petEpoch: undefined,
    relationshipEpoch: undefined,
  },
})
assert.equal(await adoptPetStateCapability({
  payload: {
    hasSession: true,
    userId: 17,
    petType: 'pig',
    semantic: { userId: 17, petType: 'pig' },
    authoritative: { id: 'opaque-new-pig-cap' },
  },
  currentContext: { hasSession: true, userId: 17, petType: 'dog' },
  validateCapability: () => true,
}), null)
const initialAuthoritative = authoritativeState.capture(authoritativeBase, 'relationship')
assert.deepEqual(
  {
    accountRevision: initialAuthoritative.accountRevision,
    petRevision: initialAuthoritative.petRevision,
    relationshipRevision: initialAuthoritative.relationshipRevision,
  },
  { accountRevision: 0, petRevision: 0, relationshipRevision: 0 },
)
assert.equal(authoritativeState.validate(initialAuthoritative, authoritativeBase), true)
authoritativeState.observe({ ...authoritativeBase, language: 'en', voiceMode: 'text_only' })
assert.equal(authoritativeState.capture(authoritativeBase, 'relationship').relationshipRevision, 0)
authoritativeState.observe({ ...authoritativeBase, petType: 'dog', relationshipId: 31 })
authoritativeState.observe(authoritativeBase)
const petAbaSnapshot = authoritativeState.capture(authoritativeBase, 'relationship')
assert.deepEqual(
  {
    accountRevision: petAbaSnapshot.accountRevision,
    petRevision: petAbaSnapshot.petRevision,
    relationshipRevision: petAbaSnapshot.relationshipRevision,
  },
  { accountRevision: 0, petRevision: 2, relationshipRevision: 2 },
)
assert.equal(authoritativeState.validate(initialAuthoritative, authoritativeBase), false)
const beforeSameRelationshipWrite = authoritativeState.capture(authoritativeBase, 'relationship')
authoritativeState.observe(authoritativeBase, { forceRelationshipRevision: true })
const afterSameRelationshipWrite = authoritativeState.capture(authoritativeBase, 'relationship')
assert.equal(
  afterSameRelationshipWrite.relationshipRevision,
  beforeSameRelationshipWrite.relationshipRevision + 1,
)
assert.equal(authoritativeState.validate(beforeSameRelationshipWrite, authoritativeBase), false)
authoritativeState.observe({ ...authoritativeBase, relationshipId: 31 })
authoritativeState.observe(authoritativeBase)
assert.equal(
  authoritativeState.capture(authoritativeBase, 'relationship').relationshipRevision,
  5,
)
const accountScopeSnapshot = authoritativeState.capture(authoritativeBase, 'account')
authoritativeState.observe({ ...authoritativeBase, petType: 'dog', relationshipId: 31 })
assert.equal(authoritativeState.validate(accountScopeSnapshot, authoritativeBase), true)
const accountScopeAfterPetSwitch = authoritativeState.capture(
  { ...authoritativeBase, petType: 'dog', relationshipId: 31 },
  'account',
)
assert.equal(isPetAccountOperationCurrent(
  {
    session: initialSessionSnapshot,
    authoritative: { id: 'opaque-account' },
    local: { scope: 'account', userId: 17, petType: 'pig' },
  },
  {
    session: initialSessionSnapshot,
    authoritative: { id: 'opaque-pet-after-switch' },
    local: { scope: 'pet', userId: 17, petType: 'dog' },
  },
), true)
assert.equal(isPetAccountOperationCurrent(
  {
    session: initialSessionSnapshot,
    authoritative: { id: 'opaque-relationship' },
    local: { scope: 'relationship', userId: 17, petType: 'pig', relationshipId: 29 },
  },
  {
    session: initialSessionSnapshot,
    authoritative: { id: 'opaque-next' },
    local: { scope: 'relationship', userId: 17, petType: 'pig', relationshipId: 31 },
  },
), false)
assert.equal(authoritativeState.captureForRole(null, authoritativeBase, 'pet'), null)
assert.equal(authoritativeState.captureForRole('unknown', authoritativeBase, 'pet'), null)
assert.equal(
  authoritativeState.captureForRole('pet', authoritativeBase, 'pet', {
    ...authoritativeBase,
    session: { token: 'token-b', generation: 2 },
  }),
  null,
)
assert.equal(
  authoritativeState.captureForRole('pet', authoritativeBase, 'pet', authoritativeBase)?.userId,
  17,
)
const currentDogContext = { ...authoritativeBase, petType: 'dog', relationshipId: 31 }
const currentDogSnapshot = authoritativeState.capture(currentDogContext, 'pet')
assert.equal(isPetAccountOperationCurrent(
  { ...authoritativeBase, authoritative: { id: 'opaque-pig' }, local: { scope: 'pet', userId: 17, petType: 'pig' } },
  { ...authoritativeBase, authoritative: { id: 'opaque-dog' }, local: { scope: 'pet', userId: 17, petType: 'dog' } },
), false)
assert.equal(authoritativeState.captureForRole('pet', currentDogContext, 'pet', {
  ...currentDogContext,
  authoritative: initialAuthoritative,
}), null)
assert.equal(authoritativeState.captureForRole('pet', currentDogContext, 'pet', {
  ...currentDogContext,
  authoritative: currentDogSnapshot,
})?.petType, 'dog')
const notificationSnapshot = authoritativeState.capture(authoritativeBase, 'pet')
assert.equal(authorizeNotification({
  senderRole: 'pet',
  expectedContext: notificationSnapshot,
  currentContext: authoritativeBase,
  validate: authoritativeState.validate,
}), true)
authoritativeState.observe({ ...authoritativeBase, petType: 'dog', relationshipId: 31 })
assert.equal(authorizeNotification({
  senderRole: 'pet',
  expectedContext: notificationSnapshot,
  currentContext: { ...authoritativeBase, petType: 'dog', relationshipId: 31 },
  validate: authoritativeState.validate,
}), false)
assert.equal(authorizeNotification({ senderRole: 'main-panel' }), true)
assert.equal(authorizeNotification({ senderRole: 'quick-chat' }), false)
assert.equal(canCommitRelationshipReward({
  cacheResult: { ok: true },
  expectedContext: authoritativeBase,
  currentContext: authoritativeBase,
}), true)
assert.equal(canCommitRelationshipReward({
  cacheResult: { ok: false },
  expectedContext: authoritativeBase,
  currentContext: authoritativeBase,
}), false)
assert.equal(canCommitRelationshipReward({
  cacheResult: { ok: true },
  expectedContext: authoritativeBase,
  currentContext: { ...authoritativeBase, petType: 'dog' },
}), false)

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

for (const changedSession of [
  { token: 'token-b', generation: 2 },
  { token: 'token-a', generation: 3 },
]) {
  const deferredBase = createDeferred()
  let currentSession = initialSessionSnapshot
  const fetchCalls = []
  const requestPromise = executeSessionBoundRequest({
    path: '/account-mutation',
    options: { method: 'POST', body: '{}' },
    getSessionSnapshot: async () => currentSession,
    requireApiBaseUrl: () => deferredBase.promise,
    fetchImpl: async (...args) => {
      fetchCalls.push(args)
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  await Promise.resolve()
  currentSession = changedSession
  deferredBase.resolve('https://api.example.test')
  await assert.rejects(requestPromise, (error) => error?.code === AUTH_CONTEXT_CHANGED_CODE)
  assert.deepEqual(fetchCalls, [])
}

const deferredPetScopedBase = createDeferred()
let authoritativePetContextCurrent = true
const petScopedFetchCalls = []
const petScopedRequest = executeSessionBoundRequest({
  path: '/pet-mutation',
  options: { method: 'POST', body: '{}' },
  operationContext: {
    session: initialSessionSnapshot,
    authoritative: { scope: 'pet', petRevision: 4, petType: 'pig' },
  },
  getSessionSnapshot: async () => initialSessionSnapshot,
  validateOperationContext: async () => authoritativePetContextCurrent,
  requireApiBaseUrl: () => deferredPetScopedBase.promise,
  fetchImpl: async (...args) => {
    petScopedFetchCalls.push(args)
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
await Promise.resolve()
authoritativePetContextCurrent = false
deferredPetScopedBase.resolve('https://api.example.test')
await assert.rejects(petScopedRequest, (error) => error?.code === AUTH_CONTEXT_CHANGED_CODE)
assert.deepEqual(petScopedFetchCalls, [])

let currentBoundSession = { token: 'token-exact', generation: 9 }
const clearedSnapshots = []
const exactRequest = executeSessionBoundRequest({
  path: '/account-mutation',
  options: { method: 'POST', body: '{}' },
  getSessionSnapshot: async () => currentBoundSession,
  requireApiBaseUrl: async () => 'https://api.example.test',
  fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('Authorization'), 'Bearer token-exact')
    return new Response(JSON.stringify({ detail: 'expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  },
  clearSessionSnapshot: async (snapshot) => clearedSnapshots.push(snapshot),
})
await assert.rejects(exactRequest, /登录已过期/)
assert.deepEqual(clearedSnapshots, [{ token: 'token-exact', generation: 9 }])

const deferredFetch = createDeferred()
let postFetchSession = { token: 'token-a', generation: 1 }
const postFetchRequest = executeSessionBoundRequest({
  path: '/account-read',
  getSessionSnapshot: async () => postFetchSession,
  requireApiBaseUrl: async () => 'https://api.example.test',
  fetchImpl: () => deferredFetch.promise,
})
await Promise.resolve()
await Promise.resolve()
postFetchSession = { token: 'token-b', generation: 2 }
deferredFetch.resolve(new Response('{}', {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}))
await assert.rejects(postFetchRequest, (error) => error?.code === AUTH_CONTEXT_CHANGED_CODE)

const lifecycleRequestEvents = []
let lifecycleRequestNow = 0
let lifecycleRequestSession = initialSessionSnapshot
let lifecycleRequestContextCurrent = true
const lifecycleRequest = executeSessionBoundRequest({
  path: '/long-running-authenticated-read',
  operationContext: {
    session: initialSessionSnapshot,
    authoritative: { id: 'long-running-capability' },
  },
  getSessionSnapshot: async () => {
    lifecycleRequestEvents.push('session-current')
    return lifecycleRequestSession
  },
  requireApiBaseUrl: async () => {
    lifecycleRequestEvents.push('resolve-base')
    lifecycleRequestNow = 31_000
    return 'https://api.example.test'
  },
  renewOperationContext: async () => {
    lifecycleRequestEvents.push(`renew:${lifecycleRequestNow}`)
    return true
  },
  validateOperationContext: async () => {
    lifecycleRequestEvents.push('validate')
    return lifecycleRequestContextCurrent
  },
  fetchImpl: async () => {
    lifecycleRequestEvents.push('fetch')
    lifecycleRequestNow = 62_000
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})
assert.deepEqual(await lifecycleRequest, { ok: true })
assert.deepEqual(lifecycleRequestEvents.slice(0, 8), [
  'session-current',
  'resolve-base',
  'session-current',
  'renew:31000',
  'validate',
  'fetch',
  'session-current',
  'renew:62000',
])
assert.ok(lifecycleRequestEvents.filter((event) => event === 'validate').length >= 2)

const staleAfterFetchEvents = []
await assert.rejects(executeSessionBoundRequest({
  path: '/stale-after-fetch',
  operationContext: {
    session: initialSessionSnapshot,
    authoritative: { id: 'stale-after-fetch-capability' },
  },
  getSessionSnapshot: async () => initialSessionSnapshot,
  requireApiBaseUrl: async () => 'https://api.example.test',
  renewOperationContext: async () => {
    staleAfterFetchEvents.push('renew')
    return true
  },
  validateOperationContext: async () => lifecycleRequestContextCurrent,
  fetchImpl: async () => {
    lifecycleRequestContextCurrent = false
    return new Response('{"mustNotCommit":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
}), (error) => error?.code === AUTH_CONTEXT_CHANGED_CODE)
assert.deepEqual(staleAfterFetchEvents, ['renew', 'renew'])
lifecycleRequestSession = initialSessionSnapshot
lifecycleRequestContextCurrent = true

for (const phase of ['success', 'catch', 'finally']) {
  const gate = createAccountOperationGate()
  const staleContext = gate.begin({
    hasSession: true,
    userId: 17,
    petType: 'pig',
    session: { token: 'token-a', generation: 1 },
  })
  gate.invalidate()
  const commits = []
  assert.equal(commitAccountOperation(
    gate,
    staleContext,
    {
      hasSession: true,
      userId: 18,
      petType: 'pig',
      session: { token: 'token-b', generation: 2 },
    },
    () => commits.push(phase),
  ), false)
  assert.deepEqual(commits, [])
}

const currentOperationGate = createAccountOperationGate()
const currentOperationContext = currentOperationGate.begin({
  hasSession: true,
  userId: 17,
  petType: 'pig',
  session: { token: 'token-a', generation: 1 },
})
const currentCommits = []
assert.equal(commitAccountOperation(
  currentOperationGate,
  currentOperationContext,
  {
    hasSession: true,
    userId: 17,
    petType: 'pig',
    session: { token: 'token-a', generation: 1 },
  },
  () => currentCommits.push('committed'),
), true)
assert.deepEqual(currentCommits, ['committed'])

for (const outcome of ['success', 'error']) {
  const gate = createAccountOperationGate()
  const live = {
    hasSession: true,
    userId: 17,
    petType: 'pig',
    session: initialSessionSnapshot,
  }
  const requestContext = gate.begin(live)
  const deferred = createDeferred()
  const effects = []
  const operation = runAccountOperation({
    gate,
    requestContext,
    getCurrentContext: () => live,
    operation: () => deferred.promise,
    onSuccess: () => effects.push('success'),
    onError: () => effects.push('error'),
    onFinally: () => effects.push('finally'),
  })
  gate.invalidate()
  if (outcome === 'success') deferred.resolve({ id: 1 })
  else deferred.reject(new Error('series failed'))
  assert.equal((await operation).stale, true)
  assert.deepEqual(effects, [])
}

function createIntentCoordinatorHarness() {
  let timeoutCallback = null
  const delivered = []
  let nextId = 0
  const coordinator = createMainPanelIntentCoordinator({
    timeoutMs: 5000,
    createId: () => `intent-${++nextId}`,
    scheduleTimeout: (callback) => {
      timeoutCallback = callback
      return 1
    },
    cancelTimeout: () => {
      timeoutCallback = null
    },
    deliver: (payload) => delivered.push(payload),
  })
  return {
    coordinator,
    delivered,
    fireTimeout: () => timeoutCallback?.(),
  }
}

const readyHarness = createIntentCoordinatorHarness()
const readyResult = readyHarness.coordinator.request('pet-onboarding-relationship')
let readySettlement = null
void readyResult.then((value) => {
  readySettlement = value
})
assert.equal(readyHarness.coordinator.hasPending(), true)
assert.deepEqual(readyHarness.delivered, [])
readyHarness.coordinator.markRendererReady()
await Promise.resolve()
assert.equal(readySettlement, null)
assert.deepEqual(readyHarness.delivered, [{ id: 'intent-1', intent: 'pet-onboarding-relationship' }])
readyHarness.coordinator.markRendererReady()
assert.deepEqual(readyHarness.delivered, [{ id: 'intent-1', intent: 'pet-onboarding-relationship' }])
assert.equal(readyHarness.coordinator.acknowledge('wrong-intent'), false)
assert.equal(readyHarness.coordinator.acknowledge('intent-1'), true)
assert.equal(await readyResult, true)
assert.equal(readyHarness.coordinator.acknowledge('intent-1'), false)

const removedListenerHarness = createIntentCoordinatorHarness()
removedListenerHarness.coordinator.markRendererReady()
removedListenerHarness.coordinator.markRendererNotReady()
const removedListenerResult = removedListenerHarness.coordinator.request('pet-onboarding-relationship')
assert.deepEqual(removedListenerHarness.delivered, [])
removedListenerHarness.coordinator.markRendererReady()
assert.deepEqual(removedListenerHarness.delivered, [
  { id: 'intent-1', intent: 'pet-onboarding-relationship' },
])
removedListenerHarness.coordinator.acknowledge('intent-1')
assert.equal(await removedListenerResult, true)

const replacementHarness = createIntentCoordinatorHarness()
replacementHarness.coordinator.markRendererReady()
const replacedResult = replacementHarness.coordinator.request('pet-onboarding-relationship')
const replacementResult = replacementHarness.coordinator.request('pet-onboarding-relationship')
assert.equal(await replacedResult, false)
assert.deepEqual(replacementHarness.delivered, [
  { id: 'intent-1', intent: 'pet-onboarding-relationship' },
  { id: 'intent-2', intent: 'pet-onboarding-relationship' },
])
assert.equal(replacementHarness.coordinator.acknowledge('intent-1'), false)
assert.equal(replacementHarness.coordinator.acknowledge('intent-2'), true)
assert.equal(await replacementResult, true)

let intentContextCurrent = true
const contextualDelivered = []
const contextualCoordinator = createMainPanelIntentCoordinator({
  createId: () => 'context-intent',
  scheduleTimeout: () => 1,
  cancelTimeout: () => undefined,
  validateContext: () => intentContextCurrent,
  deliver: (payload) => contextualDelivered.push(payload),
})
const stalePendingIntent = contextualCoordinator.request(
  'pet-onboarding-relationship',
  {
    context: { id: 'opaque-pending-intent-cap' },
    semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
  },
)
intentContextCurrent = false
contextualCoordinator.markRendererReady()
assert.equal(await stalePendingIntent, false)
assert.deepEqual(contextualDelivered, [])
intentContextCurrent = true
const staleDeliveredIntent = contextualCoordinator.request(
  'pet-onboarding-relationship',
  {
    context: { id: 'opaque-delivered-intent-cap' },
    semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
  },
)
assert.equal(contextualDelivered.length, 1)
assert.deepEqual(contextualDelivered[0], {
  id: 'context-intent',
  intent: 'pet-onboarding-relationship',
  authoritative: { id: 'opaque-delivered-intent-cap' },
  semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
})
assert.equal(JSON.stringify(contextualDelivered[0]).includes('token'), false)
intentContextCurrent = false
assert.equal(contextualCoordinator.acknowledge('context-intent'), false)
assert.equal(await staleDeliveredIntent, false)

let reboundContextId = 'reload-cap-1'
const reboundDelivered = []
const reboundCoordinator = createMainPanelIntentCoordinator({
  createId: () => 'reload-intent',
  scheduleTimeout: () => 1,
  cancelTimeout: () => undefined,
  validateContext: (context) => context?.id === reboundContextId,
  deliver: (payload) => reboundDelivered.push(payload),
})
reboundCoordinator.markRendererReady()
const reboundResult = reboundCoordinator.request('pet-onboarding-relationship', {
  context: { id: 'reload-cap-1' },
  semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
})
assert.deepEqual(reboundCoordinator.getPendingMetadata(), {
  intent: 'pet-onboarding-relationship',
  semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
})
reboundCoordinator.markRendererNotReady()
reboundContextId = 'reload-cap-2'
assert.equal(reboundCoordinator.rebindPendingContext({ id: 'reload-cap-2' }), true)
reboundCoordinator.markRendererReady()
assert.deepEqual(reboundDelivered, [
  {
    id: 'reload-intent',
    intent: 'pet-onboarding-relationship',
    authoritative: { id: 'reload-cap-1' },
    semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
  },
  {
    id: 'reload-intent',
    intent: 'pet-onboarding-relationship',
    authoritative: { id: 'reload-cap-2' },
    semantic: { userId: 17, petType: 'pig', relationshipId: 29 },
  },
])
assert.equal(reboundCoordinator.acknowledge('reload-intent'), true)
assert.equal(await reboundResult, true)
assert.equal(reboundCoordinator.rebindPendingContext({ id: 'reload-cap-3' }), false)

const listenerEvents = []
const listenerRegistry = createMainPanelIntentListenerRegistry({
  onReady: () => listenerEvents.push('ready'),
  onNotReady: () => listenerEvents.push('not-ready'),
  acknowledge: (id) => listenerEvents.push(`ack:${id}`),
})
const firstListenerPayloads = []
const secondListenerPayloads = []
const removeFirst = listenerRegistry.add(async (payload) => {
  firstListenerPayloads.push(payload)
})
const removeSecond = listenerRegistry.add(() => {
  secondListenerPayloads.push('called')
  throw new Error('consumer failed')
})
assert.deepEqual(listenerEvents, ['ready'])
await listenerRegistry.consume({ id: 'intent-1', intent: 'pet-onboarding-relationship' })
assert.deepEqual(firstListenerPayloads, [
  { id: 'intent-1', intent: 'pet-onboarding-relationship' },
])
assert.deepEqual(secondListenerPayloads, ['called'])
assert.deepEqual(listenerEvents, ['ready'])
removeSecond()
await listenerRegistry.consume({ id: 'intent-1', intent: 'pet-onboarding-relationship' })
assert.deepEqual(listenerEvents, ['ready'])
await listenerRegistry.consume({ id: 'intent-2', intent: 'pet-onboarding-relationship' })
assert.deepEqual(listenerEvents, ['ready', 'ack:intent-2'])
await listenerRegistry.consume({ id: 'intent-2', intent: 'pet-onboarding-relationship' })
assert.deepEqual(listenerEvents, ['ready', 'ack:intent-2'])
removeFirst()

const rejectedContextPayloads = []
const validatingRegistry = createMainPanelIntentListenerRegistry({
  validateContext: async () => false,
  acknowledge: () => true,
})
validatingRegistry.add((payload) => rejectedContextPayloads.push(payload))
assert.equal(await validatingRegistry.consume({
  id: 'stale-context-intent',
  intent: 'pet-onboarding-relationship',
  context: { relationshipRevision: 1 },
}), false)
assert.deepEqual(rejectedContextPayloads, [])
removeFirst()
assert.deepEqual(listenerEvents, ['ready', 'ack:intent-2', 'not-ready'])

let boundedSeenNow = 100
let boundedSeenCalls = 0
const boundedSeenRegistry = createMainPanelIntentListenerRegistry({
  now: () => boundedSeenNow,
  maxSeenIds: 2,
  seenTtlMs: 10,
})
boundedSeenRegistry.add(() => { boundedSeenCalls += 1 })
await boundedSeenRegistry.consume({ id: 'seen-1', intent: 'x' })
await boundedSeenRegistry.consume({ id: 'seen-2', intent: 'x' })
await boundedSeenRegistry.consume({ id: 'seen-3', intent: 'x' })
await boundedSeenRegistry.consume({ id: 'seen-1', intent: 'x' })
assert.equal(boundedSeenCalls, 4)
boundedSeenNow += 11
await boundedSeenRegistry.consume({ id: 'seen-3', intent: 'x' })
assert.equal(boundedSeenCalls, 5)

const unmountedEvents = []
const deferredConsumer = createDeferred()
const unmountedRegistry = createMainPanelIntentListenerRegistry({
  onReady: () => unmountedEvents.push('ready'),
  onNotReady: () => unmountedEvents.push('not-ready'),
  acknowledge: (id) => unmountedEvents.push(`ack:${id}`),
})
const removeDeferredConsumer = unmountedRegistry.add(() => deferredConsumer.promise)
const unmountedConsumption = unmountedRegistry.consume({
  id: 'intent-unmounted',
  intent: 'pet-onboarding-relationship',
})
removeDeferredConsumer()
deferredConsumer.resolve(true)
assert.equal(await unmountedConsumption, false)
assert.deepEqual(unmountedEvents, ['ready', 'not-ready'])

for (const failAction of ['main-frame-load-failed', 'window-destroyed', 'timeout']) {
  const harness = createIntentCoordinatorHarness()
  const result = harness.coordinator.request('pet-onboarding-relationship')
  if (failAction === 'timeout') {
    harness.fireTimeout()
  } else {
    harness.coordinator.failPending(failAction)
  }
  assert.equal(await result, false)
  assert.equal(harness.coordinator.hasPending(), false)
  harness.coordinator.markRendererReady()
  assert.deepEqual(harness.delivered, [])
}

const quickCapability = { id: 'quick-pet-capability' }
const quickContext = {
  hasSession: true,
  userId: 41,
  petType: 'pig',
  session: { token: 'quick-token', generation: 2 },
  authoritative: quickCapability,
}
assert.deepEqual(
  deriveQuickChatPetStateContext(quickContext, { language: 'en-US', source: 'voice-settings' }),
  { context: quickContext, identityChanged: false, needsRecapture: false },
)
const quickDogTransition = deriveQuickChatPetStateContext(quickContext, { petType: 'dog' })
assert.equal(quickDogTransition.identityChanged, true)
assert.equal(quickDogTransition.needsRecapture, true)
assert.equal(quickDogTransition.context.authoritative, null)
assert.equal(quickDogTransition.context.session, null)
assert.equal(quickDogTransition.context.petType, 'dog')
const quickPigAgain = deriveQuickChatPetStateContext(quickDogTransition.context, { petType: 'pig' })
assert.equal(quickPigAgain.context.authoritative, null)

const privateRuntimeState = {
  petState: { hasSession: true, userId: 52, petType: 'dog', preferences: { secret: true } },
  petRelationshipCache: {
    '51:pig': { id: 1, user_id: 51, claim_token: 'relationship-secret' },
    '52:dog': { id: 2, user_id: 52 },
  },
  petMilestonePlayback: {
    '51:pig': { revision: 7, claim_token: 'milestone-secret' },
  },
  companionState: { '51:pig': { shown_at: 'private' } },
  voiceSettings: { desktop_voice_enabled: true },
  companionSettings: { mode: 'balanced' },
  windows: { petVisible: true },
  rendererHeartbeats: { pet: { payload: { token: 'heartbeat-secret' } } },
}
const runtimeSummary = accountBoundary.createRuntimeStateForRole({
  role: 'main-panel',
  runtimeState: privateRuntimeState,
})
assert.deepEqual(runtimeSummary.petState, { hasSession: true, userId: 52, petType: 'dog' })
assert.equal('petRelationshipCache' in runtimeSummary, false)
assert.equal('petMilestonePlayback' in runtimeSummary, false)
assert.equal('companionState' in runtimeSummary, false)
assert.equal('rendererHeartbeats' in runtimeSummary, false)
assert.equal(JSON.stringify(runtimeSummary).includes('secret'), false)
assert.equal(accountBoundary.createRuntimeStateForRole({ role: 'unknown', runtimeState: privateRuntimeState }), null)

const transactionalEvents = []
const transactionalRegistry = createMainPanelIntentListenerRegistry({
  validateContext: async () => true,
  acknowledge: async () => false,
})
transactionalRegistry.add(() => ({
  commit: () => transactionalEvents.push('commit'),
  rollback: () => transactionalEvents.push('rollback'),
}))
assert.equal(await transactionalRegistry.consume({
  id: 'transactional-intent',
  intent: 'pet-onboarding-relationship',
  context: { id: 'consumer-capability' },
}), false)
assert.deepEqual(transactionalEvents, ['commit', 'rollback'])
let validationCount = 0
let staleIntentAckCount = 0
const staleAfterCommitEvents = []
const staleAfterCommitRegistry = createMainPanelIntentListenerRegistry({
  validateContext: async () => {
    validationCount += 1
    return validationCount < 3
  },
  acknowledge: async () => {
    staleIntentAckCount += 1
    return true
  },
})
staleAfterCommitRegistry.add(() => ({
  commit: () => staleAfterCommitEvents.push('commit'),
  rollback: () => staleAfterCommitEvents.push('rollback'),
}))
assert.equal(await staleAfterCommitRegistry.consume({
  id: 'stale-after-commit',
  intent: 'pet-onboarding-relationship',
  context: { id: 'context-a' },
}), false)
assert.deepEqual(staleAfterCommitEvents, ['commit', 'rollback'])
assert.equal(staleIntentAckCount, 0)

const intentSemantic = { userId: 17, petType: 'pig', relationshipId: 31 }
const intentPayload = {
  id: 'dom-intent',
  intent: PET_ONBOARDING_MAIN_PANEL_INTENT,
  semantic: intentSemantic,
  authoritative: { id: 'intent-consumer-cap' },
}
let intentConsumerState = {
  authenticated: false,
  ...intentSemantic,
  activeCapabilityId: 'different-active-cap',
  tab: 'knowledge',
}
const intentConsumerEvents = []
let intentTarget = { scrollIntoView: () => intentConsumerEvents.push('scroll') }
let intentAckResult = true
const intentConsumer = createMainPanelIntentConsumerController({
  getState: () => intentConsumerState,
  validateCapability: async () => true,
  showOverride: async (payload) => {
    intentConsumerEvents.push(`override:${payload.id}`)
    return intentTarget
  },
  clearOverride: (id) => intentConsumerEvents.push(`clear:${id}`),
  acknowledge: async (id) => {
    intentConsumerEvents.push(`ack:${id}`)
    return intentAckResult
  },
  commitTab: (tab) => {
    intentConsumerState = { ...intentConsumerState, tab }
    intentConsumerEvents.push(`commit:${tab}`)
  },
})
assert.equal(await intentConsumer.consume(intentPayload), false)
assert.deepEqual(intentConsumerEvents, [])
intentConsumerState = { ...intentConsumerState, authenticated: true, relationshipId: null }
assert.equal(await intentConsumer.consume(intentPayload), false)
intentConsumerState = { ...intentConsumerState, relationshipId: 31 }
intentTarget = null
assert.equal(await intentConsumer.consume(intentPayload), false)
assert.deepEqual(intentConsumerEvents, ['override:dom-intent', 'clear:dom-intent'])
intentConsumerEvents.length = 0
intentTarget = { scrollIntoView: () => intentConsumerEvents.push('scroll') }
intentAckResult = false
assert.equal(await intentConsumer.consume(intentPayload), false)
assert.deepEqual(intentConsumerEvents, [
  'override:dom-intent', 'scroll', 'ack:dom-intent', 'clear:dom-intent',
])
assert.equal(intentConsumerState.tab, 'knowledge')
intentConsumerEvents.length = 0
intentAckResult = true
assert.equal(await intentConsumer.consume(intentPayload), true)
assert.deepEqual(intentConsumerEvents, [
  'override:dom-intent', 'scroll', 'ack:dom-intent', 'commit:chat', 'clear:dom-intent',
])
assert.equal(intentConsumerState.tab, 'chat')

let validationRaceCount = 0
intentConsumerState = { ...intentConsumerState, tab: 'knowledge', userId: 17 }
const validationRaceEvents = []
const validationRaceConsumer = createMainPanelIntentConsumerController({
  getState: () => intentConsumerState,
  validateCapability: async () => {
    validationRaceCount += 1
    if (validationRaceCount === 2) intentConsumerState = { ...intentConsumerState, userId: 18 }
    return true
  },
  showOverride: async () => ({ scrollIntoView: () => validationRaceEvents.push('scroll') }),
  clearOverride: () => validationRaceEvents.push('clear'),
  acknowledge: async () => { validationRaceEvents.push('ack'); return true },
  commitTab: () => validationRaceEvents.push('commit'),
})
assert.equal(await validationRaceConsumer.consume(intentPayload), false)
assert.deepEqual(validationRaceEvents, ['clear'])

intentConsumerState = { ...intentConsumerState, authenticated: true, userId: 17, tab: 'knowledge' }
const userCancelDeferred = createDeferred()
const userCancelEvents = []
const userCancelConsumer = createMainPanelIntentConsumerController({
  getState: () => intentConsumerState,
  validateCapability: async () => true,
  showOverride: async () => {
    userCancelEvents.push('override')
    return userCancelDeferred.promise
  },
  clearOverride: () => userCancelEvents.push('clear'),
  acknowledge: async () => { userCancelEvents.push('ack'); return true },
  commitTab: () => userCancelEvents.push('commit'),
})
const userCancelledIntent = userCancelConsumer.consume(intentPayload)
await Promise.resolve()
userCancelConsumer.cancel()
userCancelDeferred.resolve({ scrollIntoView: () => userCancelEvents.push('scroll') })
assert.equal(await userCancelledIntent, false)
assert.deepEqual(userCancelEvents, ['override', 'clear'])

const oldIntentDeferred = createDeferred()
const takeoverEvents = []
const takeoverConsumer = createMainPanelIntentConsumerController({
  getState: () => intentConsumerState,
  validateCapability: async () => true,
  showOverride: async (payload) => {
    takeoverEvents.push(`override:${payload.id}`)
    if (payload.id === 'old-dom-intent') return oldIntentDeferred.promise
    return { scrollIntoView: () => takeoverEvents.push(`scroll:${payload.id}`) }
  },
  clearOverride: (id) => takeoverEvents.push(`clear:${id}`),
  acknowledge: async (id) => { takeoverEvents.push(`ack:${id}`); return true },
  commitTab: () => takeoverEvents.push('commit'),
})
const oldDomIntent = takeoverConsumer.consume({ ...intentPayload, id: 'old-dom-intent' })
await Promise.resolve()
const newDomIntent = takeoverConsumer.consume({ ...intentPayload, id: 'new-dom-intent' })
assert.equal(await newDomIntent, true)
oldIntentDeferred.resolve({ scrollIntoView: () => takeoverEvents.push('scroll:old') })
assert.equal(await oldDomIntent, false)
assert.deepEqual(takeoverEvents, [
  'override:old-dom-intent',
  'override:new-dom-intent',
  'scroll:new-dom-intent',
  'ack:new-dom-intent',
  'commit',
  'clear:new-dom-intent',
])

console.log('desktop tests passed')
