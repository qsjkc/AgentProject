import { useEffect, useState } from 'react'

import { publicApi, resolveDownloadUrl } from '../services'
import type { DesktopRelease } from '../types'

export default function Download() {
  const [release, setRelease] = useState<DesktopRelease | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    publicApi
      .getWindowsRelease()
      .then(setRelease)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_0.85fr]">
      <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Release Channel</div>
        <h1 className="mt-4 text-4xl font-semibold text-slate-950">Detachym Windows 桌宠客户端下载</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600">
          第一版安装包名称固定为 <code>DetachymAgentPet1.0</code>，面向 Windows x64，包含透明桌宠、
          快捷聊天、主面板、托盘菜单和云端账号接入。
        </p>

        <div className="mt-8 rounded-[1.75rem] bg-slate-950 p-6 text-white">
          {loading ? (
            <div className="text-sm text-slate-300">正在检查发布状态...</div>
          ) : release ? (
            <div className="space-y-4">
              <div className="text-sm text-slate-300">当前版本</div>
              <div className="text-3xl font-semibold">{release.version}</div>
              <div className="text-sm text-slate-400">{release.filename}</div>
              <div className="text-sm text-slate-400">
                {release.published_at
                  ? `发布时间：${new Date(release.published_at).toLocaleString()}`
                  : '尚未检测到发布时间'}
              </div>
              <a
                href={release.available ? resolveDownloadUrl(release) : '#'}
                className={`inline-flex rounded-full px-6 py-3 text-sm font-medium transition ${
                  release.available
                    ? 'bg-white text-slate-950 hover:bg-slate-200'
                    : 'cursor-not-allowed bg-slate-700 text-slate-300'
                }`}
              >
                {release.available ? '下载 Windows 安装包' : '安装包暂未发布'}
              </a>
            </div>
          ) : (
            <div className="text-sm text-slate-300">无法获取版本信息，请稍后重试。</div>
          )}
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-8">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Install Notes</div>
        <ul className="mt-6 space-y-4 text-sm leading-7 text-slate-600">
          <li>安装包格式为 NSIS，适用于 Windows x64。</li>
          <li>首次启动需要登录 Detachym 云端账户，桌宠偏好会从服务器同步。</li>
          <li>桌宠位置、静音、开机启动等本机设置保存在客户端本地。</li>
          <li>版本更新策略为“检查更新并提示下载”，首版不做静默自动更新。</li>
        </ul>
      </section>
    </div>
  )
}
