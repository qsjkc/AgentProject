import catIdle from '../assets/pets/cat/idle.png'
import dogIdle from '../assets/pets/dog/idle.png'
import pigIdle from '../assets/pets/pig/idle.png'

const pets = [
  {
    type: 'cat',
    title: '灵巧猫咪',
    description: '轻量、敏捷、停驻干净，适合长时间常驻桌面并作为高频入口。',
    image: catIdle,
  },
  {
    type: 'dog',
    title: '陪伴小狗',
    description: '互动感更强，适合作为快捷聊天和主面板唤起的默认桌宠。',
    image: dogIdle,
  },
  {
    type: 'pig',
    title: '治愈小猪',
    description: '更偏轻松和陪伴氛围，适合做气泡提示和情绪化反馈。',
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
