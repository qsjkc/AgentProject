interface MetricCardProps {
  label: string
  value: number | string
  tone?: 'slate' | 'blue' | 'amber' | 'emerald'
}

const toneClasses: Record<NonNullable<MetricCardProps['tone']>, string> = {
  slate: 'from-slate-900 to-slate-700 text-white',
  blue: 'from-sky-500 to-cyan-400 text-white',
  amber: 'from-amber-400 to-orange-300 text-slate-950',
  emerald: 'from-emerald-500 to-lime-400 text-slate-950',
}

export default function MetricCard({ label, value, tone = 'slate' }: MetricCardProps) {
  return (
    <article className={`rounded-3xl bg-gradient-to-br p-6 shadow-lg ${toneClasses[tone]}`}>
      <div className="text-sm uppercase tracking-[0.2em] opacity-80">{label}</div>
      <div className="mt-4 text-4xl font-semibold">{value}</div>
    </article>
  )
}
