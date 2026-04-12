import type { UserStatus } from '../types'

interface StatusBadgeProps {
  status: UserStatus
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const tone =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-rose-100 text-rose-700'

  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${tone}`}>
      {status === 'active' ? '启用' : '禁用'}
    </span>
  )
}
