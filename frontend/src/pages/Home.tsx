import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import PetGallery from '../components/PetGallery'
import { publicApi } from '../services'
import type { DesktopRelease } from '../types'

export default function Home() {
  const [release, setRelease] = useState<DesktopRelease | null>(null)

  useEffect(() => {
    publicApi.getWindowsRelease().then(setRelease).catch(() => setRelease(null))
  }, [])

  return (
    <div className="space-y-12">
      <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div>
          <span className="inline-flex rounded-full border border-slate-300 bg-white/80 px-4 py-2 text-xs uppercase tracking-[0.3em] text-slate-600">
            Detachym Desktop Pet + Cloud Portal
          </span>
          <h1 className="mt-6 max-w-3xl font-serif text-5xl leading-tight text-slate-950 sm:text-6xl">
            把你的 AI Agent 落成真正可交付的桌宠桌面应用。
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
            Detachym 把 Web 门户、账号系统、安装包分发、桌宠客户端和后台管理整合成一套可上线产品。
            门户负责预览、注册、下载和账户管理，桌面端负责透明桌宠、快捷聊天与主面板交互。
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              to="/download"
              className="rounded-full bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              {release?.available ? '下载 Windows 客户端' : '查看发布状态'}
            </Link>
            <Link
              to="/register"
              className="rounded-full border border-slate-300 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            >
              创建账号
            </Link>
          </div>
        </div>

        <div className="rounded-[2rem] border border-slate-200 bg-white/90 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <PetGallery />
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        <article className="rounded-[2rem] border border-slate-200 bg-white/85 p-6">
          <div className="text-sm uppercase tracking-[0.25em] text-slate-500">桌面端</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">透明桌宠与快捷聊天</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            支持置顶悬浮、托盘管理、主面板唤起和本地窗口状态保存，核心对话能力统一走云端 API。
          </p>
        </article>
        <article className="rounded-[2rem] border border-slate-200 bg-white/85 p-6">
          <div className="text-sm uppercase tracking-[0.25em] text-slate-500">用户门户</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">注册、偏好与下载</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            用户中心负责桌宠偏好、密码修改、版本查看和安装包下载，不再承担完整桌宠交互本体。
          </p>
        </article>
        <article className="rounded-[2rem] border border-slate-200 bg-white/85 p-6">
          <div className="text-sm uppercase tracking-[0.25em] text-slate-500">管理后台</div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">用户状态与运营管理</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            管理员可以查看总览、创建用户、启用或禁用账号、重置资料并管理知识库规模，适合首版单机云服务场景。
          </p>
        </article>
      </section>
    </div>
  )
}
