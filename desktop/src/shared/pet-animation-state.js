export const ANIMATION_ACTIONS = {
  IDLE: 'idle',
  WALK: 'walk',
  JUMP: 'jump',
  HAPPY: 'happy',
  CONFUSED: 'confused',
  REMINDING: 'reminding',
  SLEEPING: 'sleeping',
}

const LOCKED_ACTIONS = new Set([ANIMATION_ACTIONS.REMINDING])

export function createInitialPetAnimationState() {
  return {
    action: ANIMATION_ACTIONS.IDLE,
    locked: false,
    message: '',
    lastInteractionAt: Date.now(),
  }
}

function transition(action, patch = {}) {
  return {
    action,
    locked: LOCKED_ACTIONS.has(action),
    message: patch.message || '',
    lastInteractionAt: patch.lastInteractionAt || Date.now(),
  }
}

export function petAnimationReducer(state, event) {
  if (state.locked && event.type !== 'ANIMATION_DONE' && event.type !== 'WAKE') {
    return state
  }

  switch (event.type) {
    case 'REMINDER_DUE':
      return transition(ANIMATION_ACTIONS.REMINDING, { message: event.message })
    case 'REMINDER_CREATED':
    case 'CHAT_SUCCESS':
      return transition(ANIMATION_ACTIONS.HAPPY, { message: event.message })
    case 'REMINDER_PARSE_FAILED':
    case 'CHAT_ERROR':
      return transition(ANIMATION_ACTIONS.CONFUSED, { message: event.message })
    case 'PET_CLICK':
      return transition(ANIMATION_ACTIONS.JUMP)
    case 'IDLE_TICK':
      return transition(Math.random() > 0.55 ? ANIMATION_ACTIONS.WALK : ANIMATION_ACTIONS.JUMP)
    case 'SLEEP':
      return transition(ANIMATION_ACTIONS.SLEEPING)
    case 'WAKE':
    case 'ANIMATION_DONE':
      return transition(ANIMATION_ACTIONS.IDLE)
    default:
      return state
  }
}
