const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const INLINE_CODE_RE = /`([^`]+)`/g
const MARKDOWN_DECORATION_RE = /[*_~#>`-]+/g
const RTS_SUBTITLE_MAGIC = 'subv'

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
        item.UserId ??
        item.user_id ??
        item.speakerId ??
        item.SpeakerId ??
        item.speaker_id ??
        item.sourceUserId ??
        item.SourceUserId ??
        item.source_user_id ??
        item.uid ??
        item.UID ??
        item.user?.userId ??
        item.user?.UserId ??
        item.user?.user_id ??
        item.speaker?.userId ??
        item.speaker?.UserId ??
        item.speaker?.user_id ??
        item.streamKey?.userId ??
        item.streamKey?.UserId ??
        item.streamKey?.uid ??
        item.streamKey?.user_id ??
        item.stream_key?.userId ??
        item.stream_key?.uid ??
        item.stream_key?.user_id ??
        null

      const text = normalizeDisplayText(
        item.text ??
          item.Text ??
          item.content ??
          item.Content ??
          item.message ??
          item.Message ??
          item.result?.text ??
          item.result?.Text ??
          item.subtitle?.text ??
          item.subtitle?.Text ??
          item.texts?.[0]?.text ??
          item.texts?.[0]?.Text ??
          '',
      )
      const isFinal = Boolean(
        item.isFinal ??
          item.IsFinal ??
          item.is_final ??
          item.final ??
          item.Final ??
          item.definite ??
          item.Definite ??
          item.result?.definite ??
          item.result?.Definite ??
          item.subtitle?.definite ??
          item.subtitle?.Definite,
      )
      const rawSequence =
        item.sequence ??
        item.Sequence ??
        item.seq ??
        item.Seq ??
        item.result?.sequence ??
        item.result?.Sequence ??
        item.subtitle?.sequence ??
        item.subtitle?.Sequence ??
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

function normalizeArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  }

  return null
}

export function decodeRtsSubtitlePayload(message) {
  const buffer = normalizeArrayBuffer(message)
  if (!buffer || buffer.byteLength < 8) {
    return null
  }

  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== RTS_SUBTITLE_MAGIC) {
    return null
  }

  const view = new DataView(buffer)
  const bigEndianLength = view.getUint32(4, false)
  const littleEndianLength = view.getUint32(4, true)
  const payloadStart = 8
  const declaredLength =
    bigEndianLength > 0 && payloadStart + bigEndianLength <= buffer.byteLength
      ? bigEndianLength
      : littleEndianLength
  const payloadEnd =
    declaredLength > 0 && payloadStart + declaredLength <= buffer.byteLength
      ? payloadStart + declaredLength
      : buffer.byteLength
  const jsonText = new TextDecoder('utf-8').decode(bytes.slice(payloadStart, payloadEnd)).trim()
  if (!jsonText) {
    return null
  }

  try {
    return JSON.parse(jsonText)
  } catch {
    return null
  }
}

export function normalizeRtsSubtitleItems(message) {
  const decoded = decodeRtsSubtitlePayload(message)
  if (!decoded) {
    return []
  }
  if (decoded.type === 'subtitle' && decoded.data) {
    return normalizeSubtitleItems(decoded.data)
  }
  return normalizeSubtitleItems(decoded)
}
