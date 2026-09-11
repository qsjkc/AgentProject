export const ANIMATION_ACTIONS = {
  IDLE: 'idle',
  WALK: 'walk',
  JUMP: 'jump',
  HAPPY: 'happy',
  CONFUSED: 'confused',
  REMINDING: 'reminding',
  SLEEPING: 'sleeping',
  WAKE: 'wake',
  POKE: 'poke',
  DRAG: 'drag',
  PAT: 'pat',
  EAT: 'eat',
  CLEAN: 'clean',
  DRESS_UP: 'dress_up',
  LEVEL_UP: 'level_up',
}

const LOCKED_ACTIONS = new Set([
  ANIMATION_ACTIONS.REMINDING,
  ANIMATION_ACTIONS.LEVEL_UP,
])
const LOOPING_ACTIONS = new Set([
  ANIMATION_ACTIONS.IDLE,
  ANIMATION_ACTIONS.SLEEPING,
])

export function isLoopingPetAnimation(action) {
  return LOOPING_ACTIONS.has(action)
}

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
    case 'LEVEL_UP':
      return transition(ANIMATION_ACTIONS.LEVEL_UP, { message: event.message })
    case 'REMINDER_PARSE_FAILED':
    case 'CHAT_ERROR':
      return transition(ANIMATION_ACTIONS.CONFUSED, { message: event.message })
    case 'PET_CLICK':
      return transition(ANIMATION_ACTIONS.POKE)
    case 'PET_DRAG_START':
      return transition(ANIMATION_ACTIONS.DRAG)
    case 'PET_DRAG_RELEASE':
      return transition(ANIMATION_ACTIONS.HAPPY)
    case 'PET_PAT':
      return transition(ANIMATION_ACTIONS.PAT)
    case 'PET_FEED':
      return transition(ANIMATION_ACTIONS.EAT)
    case 'PET_CLEAN':
      return transition(ANIMATION_ACTIONS.CLEAN)
    case 'PET_DRESS_UP':
      return transition(ANIMATION_ACTIONS.DRESS_UP, { message: event.message })
    case 'IDLE_TICK':
      return transition(Math.random() > 0.55 ? ANIMATION_ACTIONS.WALK : ANIMATION_ACTIONS.JUMP)
    case 'SLEEP':
      return transition(ANIMATION_ACTIONS.SLEEPING)
    case 'WAKE':
      return state.action === ANIMATION_ACTIONS.SLEEPING
        ? transition(ANIMATION_ACTIONS.WAKE, { message: event.message })
        : state
    case 'ANIMATION_DONE':
      return transition(ANIMATION_ACTIONS.IDLE)
    default:
      return state
  }
}
