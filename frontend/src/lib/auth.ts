export const AUTH_EXPIRED_EVENT = 'detachym:auth-expired'

export function shouldExpireSession(
  status: unknown,
  requestUrl: string | undefined,
  authorization: unknown,
  currentToken: string | null,
): boolean {
  if (status !== 401 || !currentToken || authorization !== `Bearer ${currentToken}`) return false
  // Credential failures belong to the submitting form, not the current session.
  return !/^\/auth\/(login|register|send-verification-code|forgot-password|reset-password)(?:[/?]|$)/.test(requestUrl ?? '')
}

export function getLoginDestination(from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) {
    return '/account'
  }
  if (/^\/(login|register)(?:[/?#]|$)/.test(from)) return '/account'
  return from
}
