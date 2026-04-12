import catIdle from '../assets/pets/cat/idle.png'
import dogIdle from '../assets/pets/dog/idle.png'
import pigIdle from '../assets/pets/pig/idle.png'

const pets = [
  {
    type: 'cat',
    title: '灵巧猫咪',
    description: '轻量悬浮、快速唤起，适合长期驻留在办公桌面。',
    image: catIdle,
  },
  {
    type: 'dog',
    title: '陪伴小狗',
    description: '强调陪伴感和快捷聊天，适合作为主交互入口。',
    image: dogIdle,
  },
  {
    type: 'pig',
    title: '治愈小猪',
    description: '更偏休闲风格，适合活动气泡和情绪反馈展示。',
    image: pigIdle,
  },
] as const

export default function PetGallery() {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {pets.map((pet) => (
        <article
          key={pet.type}
          className="group rounded-[2rem] border border-slate-200 bg-white/85 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur"
        >
          <div className="flex h-44 items-center justify-center rounded-[1.5rem] bg-gradient-to-br from-slate-100 via-sky-50 to-emerald-50">
            <img
              src={pet.image}
              alt={pet.title}
              className="h-28 w-28 object-contain transition duration-300 group-hover:scale-110 group-hover:-rotate-6"
            />
          </div>
          <div className="mt-5 text-lg font-semibold text-slate-950">{pet.title}</div>
          <div className="mt-2 text-sm leading-6 text-slate-600">{pet.description}</div>
        </article>
      ))}
    </div>
  )
}
