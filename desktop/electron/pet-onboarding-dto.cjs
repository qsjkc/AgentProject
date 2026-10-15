const PET_ONBOARDING_DTO_ROLES = Object.freeze({
  PET: 'pet',
  MAIN: 'main-panel',
})

const PET_ONBOARDING_PET_DTO_FIELDS = Object.freeze([
  'version',
  'user_id',
  'relationship_id',
  'pet_type',
  'status',
  'engaged_elapsed_ms',
  'shown_step_ids',
  'observed_capability_ids',
  'presentation',
  'snoozed_until',
  'revision',
])

const PET_ONBOARDING_MAIN_DTO_FIELDS = Object.freeze([
  'version',
  'user_id',
  'relationship_id',
  'pet_type',
  'status',
  'observed_capability_ids',
  'reminder_id',
  'snoozed_until',
  'revision',
])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneArray(value) {
  return Array.isArray(value) ? [...value] : []
}

function clonePresentation(value) {
  if (value === null || value === undefined) {
    return value
  }
  if (!isObject(value)) {
    return null
  }
  return {
    step_id: value.step_id,
    token: value.token,
    lease_expires_at: value.lease_expires_at,
  }
}

function projectPetOnboardingStateForPet(state) {
  if (!isObject(state)) {
    return null
  }
  return {
    version: state.version,
    user_id: state.user_id,
    relationship_id: state.relationship_id,
    pet_type: state.pet_type,
    status: state.status,
    engaged_elapsed_ms: state.engaged_elapsed_ms,
    shown_step_ids: cloneArray(state.shown_step_ids),
    observed_capability_ids: cloneArray(state.observed_capability_ids),
    presentation: clonePresentation(state.presentation),
    snoozed_until: state.snoozed_until,
    revision: state.revision,
  }
}

function projectPetOnboardingStateForMain(state) {
  if (!isObject(state)) {
    return null
  }
  return {
    version: state.version,
    user_id: state.user_id,
    relationship_id: state.relationship_id,
    pet_type: state.pet_type,
    status: state.status,
    observed_capability_ids: cloneArray(state.observed_capability_ids),
    reminder_id: state.reminder_id,
    snoozed_until: state.snoozed_until,
    revision: state.revision,
  }
}

function projectPetOnboardingStateForRole(state, role) {
  if (role === PET_ONBOARDING_DTO_ROLES.PET) {
    return projectPetOnboardingStateForPet(state)
  }
  if (role === PET_ONBOARDING_DTO_ROLES.MAIN) {
    return projectPetOnboardingStateForMain(state)
  }
  return null
}

module.exports = {
  PET_ONBOARDING_DTO_ROLES,
  PET_ONBOARDING_MAIN_DTO_FIELDS,
  PET_ONBOARDING_PET_DTO_FIELDS,
  projectPetOnboardingStateForMain,
  projectPetOnboardingStateForPet,
  projectPetOnboardingStateForRole,
}
