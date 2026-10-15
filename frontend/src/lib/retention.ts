const reviewKeyPattern = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/

export function formatReviewPeriod(reviewKey: string) {
  const match = reviewKey.match(reviewKeyPattern)
  if (!match) {
    return reviewKey
  }
  return `${match[1]} 至 ${match[2]}`
}

export function formatRetentionRate(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return '—'
  }
  const percentage = Math.round(value * 1000) / 10
  return `${Number.isInteger(percentage) ? percentage.toFixed(0) : percentage.toFixed(1)}%`
}
