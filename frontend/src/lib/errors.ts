export function getErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object' &&
    (error as { response?: { data?: { detail?: string } } }).response?.data?.detail
  ) {
    return (error as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? fallback
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}
