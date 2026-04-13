import catIdle from '../assets/pets/cat/idle.png'
import dogIdle from '../assets/pets/dog/idle.png'
import pigIdle from '../assets/pets/pig/idle.png'

const pets = [
  {
    type: 'cat',
    title: '灵巧猫咪',
    summary: '轻盈、敏捷、安静',
    description: '适合长期停驻在桌面一角，反馈细腻，动作节奏克制。',
    image: catIdle,
    background: 'from-stone-100 via-amber-50 to-white',
  },
  {
    type: 'dog',
    title: '陪伴小狗',
    summary: '热情、直接、靠近对话',
    description: '更强调陪伴感与快捷聊天入口，适合作为主互动角色。',
    image: dogIdle,
    background: 'from-amber-50 via-orange-50 to-white',
  },
  {
    type: 'pig',
    title: '治愈小猪',
    summary: '松弛、柔和、偏情绪表达',
    description: '更适合搭配气泡反馈和状态切换，氛围感最强。',
    image: pigIdle,
    background: 'from-stone-100 via-rose-50 to-white',
  },
] as const

export default function PetGallery() {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {pets.map((pet, index) => (
        <article
          key={pet.type}
          className="surface-panel reveal-rise rounded-[2rem] p-5"
          style={{ animationDelay: `${index * 120}ms` }}
        >
          <div className={`flex h-48 items-center justify-center rounded-[1.6rem] bg-gradient-to-br ${pet.background}`}>
            <img
              src={pet.image}
              alt={pet.title}
              className="h-32 w-32 object-contain transition duration-500 hover:scale-110 hover:-rotate-3"
            />
          </div>
          <div className="mt-5 text-[0.72rem] uppercase tracking-[0.32em] text-stone-500">{pet.summary}</div>
          <div className="mt-3 text-2xl font-semibold text-stone-950">{pet.title}</div>
          <div className="mt-3 text-sm leading-7 text-stone-600">{pet.description}</div>
        </article>
      ))}
    </div>
  )
}
