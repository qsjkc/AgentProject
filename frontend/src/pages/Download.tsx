import { useEffect, useState } from 'react'

import { publicApi, resolveDownloadUrl } from '../services'
import type { DesktopRelease } from '../types'

const installSteps = [
  {
    title: '获取安装包',
    description: '当前对外分发的是 Windows x64 的 NSIS 安装包，下载入口由后端版本接口统一返回。',
  },
  {
    title: '登录云端账户',
    description: '首次启动客户端后登录同一套 Detachym 账户，桌宠类型与偏好会从服务器同步。',
  },
  {
    title: '开始桌面交互',
    description: '安装完成后可拖动桌宠、打开快捷聊天、查看气泡反馈，并通过主面板管理更多设置。',
  },
] as const

const productNotes = [
  '默认语言为简体中文，同时支持 English 切换。',
  '安装包会保留透明桌宠、快捷聊天与主面板交互能力。',
  '桌宠位置、静音和开机启动等本机设置保存在客户端本地。',
]

export default function Download() {
  const [release, setRelease] = useState<DesktopRelease | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    publicApi
      .getWindowsRelease()
      .then(setRelease)
      .finally(() => setLoading(false))
  }, [])

  const publishedAt = release?.published_at
    ? new Date(release.published_at).toLocaleString('zh-CN')
    : '尚未记录发布时间'

  return (
    <div className="space-y-10 lg:space-y-14">
      <section className="grid gap-8 xl:grid-cols-[1.05fr_0.95fr]">
        <article className="ink-panel reveal-rise rounded-[2.75rem] p-8 md:p-10 xl:p-12">
          <div className="eyebrow eyebrow-light">Windows Release</div>
          <h1 className="display-title mt-6">下载 Detachym 桌宠客户端</h1>
          <p className="body-copy-light mt-5 max-w-2xl text-base">
            页面只负责更高级、更清晰地呈现发布信息；真正的版本号、文件名和下载链接仍然来自现有接口，不改动后端能力。
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            <div className="rounded-[1.7rem] border border-white/10 bg-white/5 p-5">
              <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Version</div>
              <div className="mt-3 font-display text-5xl leading-none">
                {loading ? '...' : release?.version ?? '待发布'}
              </div>
            </div>
            <div className="rounded-[1.7rem] border border-white/10 bg-white/5 p-5">
              <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Published</div>
              <div className="mt-3 text-sm leading-7 text-stone-200">{loading ? '正在检查发布状态' : publishedAt}</div>
            </div>
            <div className="rounded-[1.7rem] border border-white/10 bg-white/5 p-5">
              <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Language</div>
              <div className="mt-3 text-sm leading-7 text-stone-200">默认简体中文，支持中英双语切换</div>
            </div>
          </div>

          <div className="mt-6 rounded-[1.8rem] border border-white/10 bg-white/5 p-6">
            {loading ? (
              <div className="text-sm text-stone-300">正在读取发布信息...</div>
            ) : release ? (
              <div className="space-y-4">
                <div>
                  <div className="text-[0.72rem] uppercase tracking-[0.32em] text-stone-300">Filename</div>
                  <div className="mt-3 text-sm leading-7 text-stone-100">{release.filename}</div>
                </div>
                <a
                  href={release.available ? resolveDownloadUrl(release) : '#'}
                  className={release.available ? 'ghost-button text-sm font-medium' : 'ghost-button text-sm font-medium'}
                >
                  {release.available ? '下载 Windows 安装包' : '安装包暂未发布'}
                </a>
              </div>
            ) : (
              <div className="text-sm text-stone-300">当前无法读取版本信息，请稍后重试。</div>
            )}
          </div>
        </article>

        <article className="surface-panel reveal-rise rounded-[2.75rem] p-8 md:p-10" style={{ animationDelay: '160ms' }}>
          <div className="eyebrow">Install Notes</div>
          <h2 className="section-title mt-4 text-stone-950">安装路径很短，体验路径要完整。</h2>
          <p className="body-copy mt-4 text-sm">
            下载只是入口。真正重要的是安装后能够顺畅登录、同步偏好，并立即看到桌宠和网页账户的一致性。
          </p>

          <div className="mt-8 space-y-4">
            {installSteps.map((step, index) => (
              <article key={step.title} className="subtle-panel rounded-[1.6rem] p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-300/50 bg-amber-100/60 text-sm font-semibold text-amber-900">
                    {index + 1}
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-stone-950">{step.title}</h3>
                    <p className="mt-2 text-sm leading-7 text-stone-600">{step.description}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </article>
      </section>

      <section className="grid gap-5 md:grid-cols-3">
        {productNotes.map((note, index) => (
          <article
            key={note}
            className="surface-panel reveal-rise rounded-[2rem] p-6"
            style={{ animationDelay: `${240 + index * 90}ms` }}
          >
            <div className="text-[0.72rem] uppercase tracking-[0.3em] text-stone-500">Product Note {index + 1}</div>
            <p className="mt-4 text-sm leading-8 text-stone-700">{note}</p>
          </article>
        ))}
      </section>
    </div>
  )
}
