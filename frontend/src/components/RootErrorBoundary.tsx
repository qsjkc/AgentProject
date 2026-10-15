import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface RootErrorBoundaryProps {
  children: ReactNode
  resetKey: string
}

interface RootErrorBoundaryState {
  hasError: boolean
}

export default class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    hasError: false,
  }

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('RootErrorBoundary', error, errorInfo)
  }

  componentDidUpdate(previousProps: RootErrorBoundaryProps, previousState: RootErrorBoundaryState) {
    // React caches a rejected lazy import. Retry that page only after an explicit
    // reload, but let a different navigation (including Back) render normally.
    if (previousState.hasError && this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <main className="min-h-screen bg-[#fcfaf6] px-6 py-16 text-[#263c32]" aria-labelledby="recovery-title">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-3xl border border-[#e4e8dd] bg-[#fffdfa] p-8 md:p-10">
            <div className="home-eyebrow">Detachym</div>
            <h1 id="recovery-title" className="mt-4 text-2xl font-semibold">页面暂时没有打开</h1>
            <p role="alert" className="mt-4 max-w-2xl text-sm leading-7 text-[#71786d]">
              页面加载或显示遇到了问题。请检查网络连接后刷新页面，也可以返回首页继续浏览。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="companion-button companion-button-primary"
              >
                刷新页面
              </button>
              <Link to="/" className="companion-button border border-[#dfe5d7]">
                返回首页
              </Link>
            </div>
          </div>
        </div>
      </main>
    )
  }
}
