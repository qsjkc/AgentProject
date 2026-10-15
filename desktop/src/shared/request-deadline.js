export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export async function runWithRequestDeadline(operation, {
  signal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) throw signal.reason
  const controller = new AbortController()
  let timer
  let onAbort
  const canceled = new Promise((_, reject) => {
    onAbort = () => {
      controller.abort(signal.reason)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const error = new Error('请求超时，请检查网络后重试。 / Request timed out. Please try again.')
      error.code = 'REQUEST_TIMEOUT'
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    // Cover response body consumption too: fetch can resolve its headers while
    // the body stalls indefinitely. The caller consumes the body in operation.
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      canceled,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
