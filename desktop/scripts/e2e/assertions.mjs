export class E2EAssertionError extends Error {
  constructor(message, details = undefined) {
    super(message)
    this.name = 'E2EAssertionError'
    this.details = details
  }
}

export function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new E2EAssertionError(message, details)
  }
}

export function assertEqual(actual, expected, message = 'Values are not equal') {
  if (!Object.is(actual, expected)) {
    throw new E2EAssertionError(message, { actual, expected })
  }
}

export function assertIncludes(values, expected, message = 'Expected value is missing') {
  if (!values.includes(expected)) {
    throw new E2EAssertionError(message, { values, expected })
  }
}

export async function waitFor(predicate, {
  timeoutMs = 10_000,
  intervalMs = 50,
  description = 'condition',
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new E2EAssertionError(`Timed out waiting for ${description}`, {
    timeoutMs,
    lastError: lastError?.message,
  })
}

export function serializeError(error) {
  if (!error) return null
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || null,
    details: error.details,
  }
}
