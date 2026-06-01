export const VOICE_PHASES = {
  IDLE: 'idle',
  VOICE_ARMED: 'voice_armed',
  CONNECTING: 'connecting',
  READY: 'ready',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  REPLYING: 'replying',
  ERROR: 'error',
}

export const VOICE_OUTPUT_MODES = {
  TEXT_ONLY: 'text_only',
  VOICE_AND_TEXT: 'voice_and_text',
}

export const DEFAULT_VOICE_SETTINGS = {
  desktop_voice_enabled: true,
  desktop_voice_trigger_key: 'KeyD',
  desktop_voice_idle_timeout_seconds: 8,
  desktop_voice_output_mode: VOICE_OUTPUT_MODES.TEXT_ONLY,
}

export function normalizeVoiceSettings(value = {}) {
  const triggerKey =
    typeof value.desktop_voice_trigger_key === 'string' && value.desktop_voice_trigger_key.trim()
      ? value.desktop_voice_trigger_key.trim()
      : DEFAULT_VOICE_SETTINGS.desktop_voice_trigger_key

  const outputMode = Object.values(VOICE_OUTPUT_MODES).includes(value.desktop_voice_output_mode)
    ? value.desktop_voice_output_mode
    : DEFAULT_VOICE_SETTINGS.desktop_voice_output_mode

  const idleTimeout = Number(value.desktop_voice_idle_timeout_seconds)

  return {
    desktop_voice_enabled:
      typeof value.desktop_voice_enabled === 'boolean'
        ? value.desktop_voice_enabled
        : DEFAULT_VOICE_SETTINGS.desktop_voice_enabled,
    desktop_voice_trigger_key: triggerKey,
    desktop_voice_idle_timeout_seconds:
      Number.isFinite(idleTimeout) && idleTimeout >= 3 && idleTimeout <= 60
        ? Math.round(idleTimeout)
        : DEFAULT_VOICE_SETTINGS.desktop_voice_idle_timeout_seconds,
    desktop_voice_output_mode: outputMode,
  }
}

export function createInitialVoiceUiState() {
  return {
    phase: VOICE_PHASES.IDLE,
    bubbleText: '',
    errorMessage: '',
    lastReplyText: '',
  }
}

export function isVoiceUiActive(phase) {
  return phase !== VOICE_PHASES.IDLE
}

export function voiceStateReducer(state, action) {
  switch (action.type) {
    case 'VOICE_IDLE':
      return {
        ...state,
        phase: VOICE_PHASES.IDLE,
        bubbleText: action.bubbleText ?? '',
        errorMessage: '',
      }
    case 'VOICE_ARMED':
      return {
        ...state,
        phase: VOICE_PHASES.VOICE_ARMED,
        bubbleText: action.bubbleText ?? state.bubbleText,
        errorMessage: '',
      }
    case 'VOICE_CONNECTING':
      return {
        ...state,
        phase: VOICE_PHASES.CONNECTING,
        bubbleText: action.bubbleText ?? state.bubbleText,
        errorMessage: '',
      }
    case 'VOICE_READY':
      return {
        ...state,
        phase: VOICE_PHASES.READY,
        bubbleText: action.bubbleText ?? state.bubbleText,
        errorMessage: '',
      }
    case 'VOICE_LISTENING':
      return {
        ...state,
        phase: VOICE_PHASES.LISTENING,
        bubbleText: action.bubbleText ?? state.bubbleText,
        errorMessage: '',
      }
    case 'VOICE_PROCESSING':
      return {
        ...state,
        phase: VOICE_PHASES.PROCESSING,
        bubbleText: action.bubbleText ?? state.bubbleText,
        errorMessage: '',
      }
    case 'VOICE_REPLYING':
      return {
        ...state,
        phase: VOICE_PHASES.REPLYING,
        bubbleText: action.bubbleText ?? state.bubbleText,
        lastReplyText: action.replyText ?? state.lastReplyText,
        errorMessage: '',
      }
    case 'VOICE_ERROR':
      return {
        ...state,
        phase: VOICE_PHASES.ERROR,
        bubbleText: action.bubbleText ?? action.errorMessage ?? state.bubbleText,
        errorMessage: action.errorMessage ?? 'voice_error',
      }
    case 'VOICE_BUBBLE':
      return {
        ...state,
        bubbleText: action.bubbleText ?? state.bubbleText,
      }
    default:
      return state
  }
}
