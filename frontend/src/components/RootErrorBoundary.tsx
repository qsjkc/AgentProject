import { Component, type ErrorInfo, type ReactNode } from 'react'

interface RootErrorBoundaryProps {
  children: ReactNode
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

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div className="app-backdrop min-h-screen px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="surface-panel reveal-rise rounded-[2.4rem] p-8 md:p-10">
            <div className="eyebrow">Detachym Recovery</div>
            <h1 className="section-title mt-4">页面渲染出现异常</h1>
            <p className="body-copy mt-4 max-w-2xl text-sm">
              当前页面在渲染过程中发生错误。系统已经阻止继续显示空白界面，你可以返回登录页重新进入，或直接刷新页面再试一次。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => window.location.assign('/login')}
                className="primary-button text-sm font-medium"
              >
                返回登录页
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="secondary-button text-sm"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
