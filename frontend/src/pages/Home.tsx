import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import PetGallery from '../components/PetGallery'
import { publicApi } from '../services'
import type { DesktopRelease } from '../types'

const featureNarratives = [
  {
    title: '桌宠客户端',
    summary: '透明宠物、快捷聊天、托盘菜单与状态切换',
    description:
      '桌面端承担真实的陪伴交互：透明背景、拖拽驻留、气泡反馈、情绪状态切换，以及与云端账号的偏好同步。',
  },
  {
    title: '账户中心',
    summary: '注册、下载、偏好与安全设置',
    description:
      '网页端负责把用户最核心的操作压缩到一个统一入口，注册后即可进入账户中心完成配置、下载和安全管理。',
  },
  {
    title: '云端后台',
    summary: '用户状态、权限与发布运营',
    description:
      '管理员可以直接查看用户总览、启用或禁用账户、创建内部账号，并维护整个产品分发链路的节奏。',
  },
] as const

export default function Home() {
  const [release, setRelease] = useState<DesktopRelease | null>(null)

  useEffect(() => {
    publicApi.getWindowsRelease().then(setRelease).catch(() => setRelease(null))
  }, [])

  const heroStats = useMemo(
    () => [
      {
        label: '默认语言',
        value: '简体中文',
        description: '同时支持 English 切换，安装器与客户端文案同步。',
      },
      {
        label: '交互方式',
        value: '拖拽 + 气泡 + 状态切换',
        description: '桌宠不是静态挂件，而是可被点击、拖动和唤起的桌面入口。',
      },
      {
        label: '发布形态',
        value: release?.available ? release.version : '待发布',
        description: release?.filename ?? 'Windows 安装包会在这里统一展示与下载。',
      },
    ],
    [release],
  )

  const publishedAt = release?.published_at
    ? new Date(release.published_at).toLocaleString('zh-CN')
    : '当前未记录发布时间'

  return (
    <div className="space-y-10 lg:space-y-14">
      <section className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="surface-panel reveal-rise rounded-[2.75rem] p-8 md:p-10 xl:p-12">
          <div className="eyebrow">Detachym / 中文优先的桌宠云平台</div>
          <h1 className="display-title mt-6 max-w-5xl text-stone-950">
            把 AI 助手做成
            <br />
            真正可登录、可下载、可分发的桌面宠物系统。
          </h1>
          <p className="body-copy mt-6 max-w-3xl text-base md:text-lg">
            Detachym 将桌宠客户端、注册登录、下载分发、账户偏好和后台运营收束为同一条产品体验链。网页负责注册、下载和管理；桌面负责陪伴、交互和快捷入口，视觉上强调克制、留白与高级感。
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/download" className="primary-button text-sm font-medium">
              {release?.available ? '下载 Windows 客户端' : '查看发布状态'}
            </Link>
            <Link to="/register" className="secondary-button text-sm font-medium">
              创建账户
            </Link>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {heroStats.map((item, index) => (
              <article
                key={item.label}
                className="subtle-panel reveal-rise rounded-[1.75rem] p-5"
                style={{ animationDelay: `${120 + index * 100}ms` }}
              >
                <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-500">{item.label}</div>
                <div className="mt-3 text-2xl font-semibold leading-tight text-stone-950">{item.value}</div>
                <div className="mt-3 text-sm leading-7 text-stone-600">{item.description}</div>
              </article>
            ))}
          </div>
        </article>

        <div className="grid gap-6">
          <article className="ink-panel reveal-rise rounded-[2.5rem] p-8" style={{ animationDelay: '160ms' }}>
            <div className="eyebrow eyebrow-light">Release Channel</div>
            <h2 className="section-title mt-4">当前桌面版发布状态</h2>
            <p className="body-copy-light mt-4 text-sm">
              当前官网会读取 Windows 版本信息并直接提供下载入口，下载页与账户中心会共用这一份发布数据。
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                <div className="text-[0.72rem] uppercase tracking-[0.3em] text-stone-300">Version</div>
                <div className="mt-3 font-display text-5xl leading-none">
                  {release?.available ? release.version : '待发布'}
                </div>
              </div>
              <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                <div className="text-[0.72rem] uppercase tracking-[0.3em] text-stone-300">Published</div>
                <div className="mt-3 text-sm leading-7 text-stone-200">{publishedAt}</div>
              </div>
            </div>

            <div className="mt-6 rounded-[1.6rem] border border-white/10 bg-white/5 p-5 text-sm leading-7 text-stone-200">
              <div className="text-[0.72rem] uppercase tracking-[0.3em] text-stone-300">Package</div>
              <div className="mt-3">{release?.filename ?? '安装包尚未发布到公开下载目录。'}</div>
            </div>

            <div className="mt-6">
              <Link to="/download" className="ghost-button text-sm font-medium">
                进入下载页
              </Link>
            </div>
          </article>

          <article className="surface-panel reveal-rise rounded-[2.5rem] p-8" style={{ animationDelay: '260ms' }}>
            <div className="eyebrow">Design Direction</div>
            <h2 className="section-title mt-4 text-stone-950">中文优先，像一件产品，而不是一张控制面板。</h2>
            <p className="body-copy mt-4 text-sm">
              这次前端会用编辑感排版、暖金属调和克制发光来建立品牌气质，减少传统后台式的硬直界面，让注册、下载、管理都更像统一的品牌站。
            </p>
          </article>
        </div>
      </section>

      <section className="space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="eyebrow">Character Lineup</div>
            <h2 className="section-title mt-3 text-stone-950">三种角色，对应三种陪伴气质。</h2>
          </div>
          <p className="body-copy max-w-xl text-sm">
            宠物不再放在廉价的色块容器里，而是放在更干净的陈列方式中，让图像本身承担情绪和识别度。
          </p>
        </div>
        <PetGallery />
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        {featureNarratives.map((item, index) => (
          <article
            key={item.title}
            className="surface-panel reveal-rise rounded-[2.15rem] p-7"
            style={{ animationDelay: `${280 + index * 80}ms` }}
          >
            <div className="text-[0.72rem] uppercase tracking-[0.3em] text-stone-500">{item.summary}</div>
            <h3 className="mt-4 text-3xl font-semibold text-stone-950">{item.title}</h3>
            <p className="mt-4 text-sm leading-8 text-stone-600">{item.description}</p>
          </article>
        ))}
      </section>
    </div>
  )
}
