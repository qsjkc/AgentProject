function sameSession(left, right) {
  return Boolean(left && right
    && (left.token === null || typeof left.token === 'string')
    && left.token === right.token
    && Number.isInteger(left.generation) && left.generation >= 0
    && left.generation === right.generation)
}

function createLoginAttemptController({ readContext, readRendererNonce, createId }) {
  let current = null
  const owns = ({ sender, senderRole, rendererInstanceNonce, attempt }) => Boolean(
    current && senderRole === 'main-panel' && sender === current.sender
    && rendererInstanceNonce === current.nonce && rendererInstanceNonce === readRendererNonce(sender)
    && attempt?.id === current.id,
  )
  const matches = (request) => {
    const context = readContext()
    return owns(request) && context.server === current.server && sameSession(current.session, context.session)
  }
  return {
    begin({ sender, senderRole, rendererInstanceNonce, server }) {
      if (senderRole !== 'main-panel' || !rendererInstanceNonce
        || readRendererNonce(sender) !== rendererInstanceNonce || typeof server !== 'string' || !server) return null
      const context = readContext()
      if (!sameSession(context.session, context.session)) return null
      current = {
        id: createId(), sender, nonce: rendererInstanceNonce, server: context.server,
        targetServer: server, session: { ...context.session }, verified: false,
      }
      return { id: current.id, server, session: { ...current.session } }
    },
    saveServer(request, value, apply) {
      if (!matches(request) || value !== current.targetServer) return false
      // Validation and the store mutation must remain in the same main-process turn.
      apply(value)
      current.server = value
      current.verified = true
      return value
    },
    commitSession(request, apply) {
      if (!matches(request) || !current.verified) return false
      current = null
      return apply()
    },
    cancel(request) {
      if (!owns(request)) return false
      current = null
      return true
    },
    cancelOwner(sender) {
      if (current?.sender === sender) current = null
    },
    invalidate() { current = null },
  }
}

module.exports = { createLoginAttemptController }
