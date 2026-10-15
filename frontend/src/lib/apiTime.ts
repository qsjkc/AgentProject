// Backend datetime fields use naive UTC; calendar dates and local input values
// are different contracts and should not be passed to this parser.
const apiTimestamp = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/i

export function parseApiDateTime(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null
  const parts = apiTimestamp.exec(value.trim())
  if (!parts || parts[1].startsWith('0000-')) return null
  const wallTime = `${parts[1]}T${parts[2]}`
  // Python may emit microseconds; JavaScript dates have millisecond precision.
  const fraction = parts[3] ? `.${parts[3].slice(0, 3).padEnd(3, '0')}` : ''
  const wallDate = new Date(`${wallTime}${fraction}Z`)
  if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString().slice(0, 19) !== wallTime) return null

  let zone = parts[4]?.toUpperCase() ?? 'Z'
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`
  const date = new Date(`${wallTime}${fraction}${zone}`)
  return Number.isFinite(date.getTime()) ? date : null
}

export function formatApiDateTime(value: string | null | undefined, fallback = '-'): string {
  return parseApiDateTime(value)?.toLocaleString() ?? fallback
}

export function formatApiDate(value: string | null | undefined, fallback = '-'): string {
  return parseApiDateTime(value)?.toLocaleDateString() ?? fallback
}
