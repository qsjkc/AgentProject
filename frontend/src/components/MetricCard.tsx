interface MetricCardProps {
  label: string
  value: number | string
  tone?: 'slate' | 'blue' | 'amber' | 'emerald'
}

const toneClasses: Record<NonNullable<MetricCardProps['tone']>, string> = {
  slate: 'from-stone-950 via-stone-900 to-stone-800 text-stone-50',
  blue: 'from-[#132c39] via-[#1d4758] to-[#6c97a8] text-stone-50',
  amber: 'from-[#2f2014] via-[#72411d] to-[#c08948] text-amber-50',
  emerald: 'from-[#143429] via-[#1d5a44] to-[#85bc98] text-emerald-50',
}

export default function MetricCard({ label, value, tone = 'slate' }: MetricCardProps) {
  return (
    <article
      className={`relative overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br p-6 shadow-[0_20px_50px_rgba(24,19,15,0.18)] ${toneClasses[tone]}`}
    >
      <div className="absolute right-0 top-0 h-24 w-24 rounded-full bg-white/10 blur-3xl" />
      <div className="relative">
        <div className="text-[0.72rem] uppercase tracking-[0.3em] opacity-75">{label}</div>
        <div className="mt-5 font-display text-5xl leading-none">{value}</div>
      </div>
    </article>
  )
}
