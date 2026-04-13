import type { UserStatus } from '../types'

interface StatusBadgeProps {
  status: UserStatus
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const isActive = status === 'active'

  return (
    <span
      className={[
        'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium',
        isActive
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-rose-200 bg-rose-50 text-rose-700',
      ].join(' ')}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      {isActive ? '启用' : '禁用'}
    </span>
  )
}
