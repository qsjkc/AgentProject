export function shouldSubmitChatInput(event) {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.repeat
    && !event.isComposing
    && !event.nativeEvent?.isComposing
    && event.keyCode !== 229
    && event.nativeEvent?.keyCode !== 229
}

export function restoreFailedChatDraft(currentDraft, failedMessage) {
  // A user may already be writing their next message while a request is pending.
  return currentDraft || failedMessage
}

export function isChatScrollNearBottom({ scrollHeight, scrollTop, clientHeight }, threshold = 72) {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

export function shouldFollowChatUpdate({ following, previousConversation, conversation }) {
  return following || previousConversation !== conversation
}
