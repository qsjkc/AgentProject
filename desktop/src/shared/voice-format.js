const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const INLINE_CODE_RE = /`([^`]+)`/g
const MARKDOWN_DECORATION_RE = /[*_~#>`-]+/g

export function stripMarkdown(value) {
  return String(value || '')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(INLINE_CODE_RE, '$1')
    .replace(MARKDOWN_DECORATION_RE, '')
}

export function normalizeDisplayText(value) {
  return stripMarkdown(value)
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncateForPetBubble(value, language = 'zh-CN', maxLength = 88) {
  const normalized = normalizeDisplayText(value)
  if (!normalized) {
    return ''
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  const suffix = language === 'en' ? ' Open the main panel for more.' : ' 打开主面板查看完整回复。'
  return `${normalized.slice(0, Math.max(0, maxLength - suffix.length)).trim()}...${suffix}`
}

export function formatVoiceError(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return normalizeDisplayText(error.message)
  }
  if (typeof error === 'string' && error.trim()) {
    return normalizeDisplayText(error)
  }
  return fallbackMessage
}

export function normalizeSubtitleItems(payload) {
  const items = Array.isArray(payload) ? payload : [payload]
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const speakerId =
        item.userId ??
        item.speakerId ??
        item.sourceUserId ??
        item.uid ??
        item.user?.userId ??
        item.speaker?.userId ??
        item.streamKey?.userId ??
        item.streamKey?.uid ??
        item.streamKey?.user_id ??
        item.stream_key?.userId ??
        item.stream_key?.uid ??
        item.stream_key?.user_id ??
        null

      const text = normalizeDisplayText(
        item.text ??
          item.content ??
          item.message ??
          item.result?.text ??
          item.subtitle?.text ??
          item.texts?.[0]?.text ??
          '',
      )
      const isFinal = Boolean(
        item.isFinal ??
          item.final ??
          item.definite ??
          item.result?.definite ??
          item.subtitle?.definite,
      )
      const rawSequence =
        item.sequence ??
        item.seq ??
        item.result?.sequence ??
        item.subtitle?.sequence ??
        null
      const sequence = Number.isFinite(Number(rawSequence)) ? Number(rawSequence) : null

      if (!text) {
        return null
      }

      return {
        raw: item,
        speakerId: speakerId ? String(speakerId) : null,
        text,
        isFinal,
        sequence,
      }
    })
    .filter(Boolean)
}
