function normalizeId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function asRows(value) {
  return Array.isArray(value) ? value : []
}

export function getTodayReminderAgenda({ delivered, scheduled, series, accountContext, now = Date.now() } = {}) {
  const userId = normalizeId(accountContext?.userId)
  const petType = accountContext?.petType
  const currentDay = new Date(now)
  const items = []
  let earlierUnfinished = 0
  if (
    accountContext?.hasSession === false || userId === null || !['cat', 'dog', 'pig'].includes(petType)
    || !Number.isFinite(now) || !Number.isFinite(currentDay.getTime())
  ) return { items, earlierUnfinished, earlierGroups: [] }

  const start = currentDay.setHours(0, 0, 0, 0)
  const end = currentDay.setHours(24, 0, 0, 0)
  const isOwned = (row) => normalizeId(row?.user_id) === userId && row.pet_type === petType
  const seriesById = new Map()
  for (const row of asRows(series)) {
    if (!isOwned(row)) continue
    const id = normalizeId(row.id)
    if (id !== null) seriesById.set(id, row)
  }

  const actual = new Map()

  for (const row of [...asRows(delivered), ...asRows(scheduled)]) {
    if (!isOwned(row) || row.status !== 'pending') continue
    const id = normalizeId(row.id)
    const remindAt = Date.parse(row.remind_at)
    if (id === null || !Number.isFinite(remindAt) || typeof row.title !== 'string') continue
    const triggeredAt = Date.parse(row.triggered_at)
    const received = Number.isFinite(triggeredAt)
    const previous = actual.get(id)
    if (previous && (previous.status === 'delivered' || !received)) continue
    const seriesId = normalizeId(row.series_id)
    const seriesStatus = seriesById.get(seriesId)?.status
    if (!received && (seriesStatus === 'paused' || seriesStatus === 'canceled')) continue
    // A receipt can bring an older reminder into today without changing its scheduled occurrence.
    const deliveredToday = remindAt < start && triggeredAt >= start && triggeredAt <= now
    actual.set(id, {
      key: `reminder:${id}`,
      title: row.title,
      remindAt,
      status: received ? 'delivered' : remindAt <= now ? 'due' : 'scheduled',
      destination: received ? 'delivered' : seriesId !== null ? 'recurring' : 'upcoming',
      targetId: !received && seriesId !== null ? seriesId : id,
      seriesId,
      ...(deliveredToday ? { lateDeliveryAt: triggeredAt } : {}),
    })
  }

  const occurrences = new Set()
  const earlierByDestination = new Map()
  for (const { seriesId, ...item } of actual.values()) {
    if (item.remindAt < start && item.lateDeliveryAt === undefined) {
      earlierUnfinished += 1
      const group = earlierByDestination.get(item.destination)
      if (group) {
        group.count += 1
        group.oldestAt = Math.min(group.oldestAt, item.remindAt)
      } else {
        earlierByDestination.set(item.destination, { destination: item.destination, count: 1, oldestAt: item.remindAt })
      }
    } else if (item.remindAt < end) {
      items.push(item)
      if (seriesId !== null) occurrences.add(`${seriesId}:${item.remindAt}`)
    }
  }

  for (const [id, row] of seriesById) {
    if (row.status !== 'active' || typeof row.title !== 'string') continue
    const remindAt = Date.parse(row.next_occurrence_at)
    // The series preview disappears when the corresponding occurrence arrives.
    if (!(remindAt > now && remindAt < end)) continue
    const occurrence = `${id}:${remindAt}`
    if (occurrences.has(occurrence)) continue
    occurrences.add(occurrence)
    items.push({ key: `series:${occurrence}`, title: row.title, remindAt, status: 'projected', destination: 'recurring', targetId: id })
  }

  items.sort((left, right) => (left.lateDeliveryAt ?? left.remindAt) - (right.lateDeliveryAt ?? right.remindAt)
    || left.key.localeCompare(right.key))
  const earlierGroups = [...earlierByDestination.values()]
    .sort((left, right) => left.oldestAt - right.oldestAt || left.destination.localeCompare(right.destination))
    .map(({ destination, count }) => ({ destination, count }))
  return { items, earlierUnfinished, earlierGroups }
}
