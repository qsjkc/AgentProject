import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server.js'

// Execute the actual inline guard with only the browser events/DOM operations
// it uses. This covers startup ordering without a browser or a DOM dependency.
function startupHarness(html) {
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/\bsrc=/.test(attributes))
  assert.equal(inlineScripts.length, 1, 'startup must not depend on another script download')
  assert.ok(inlineScripts[0].index < html.indexOf('<script type="module"'), 'install the guard before the entry module')
  assert.equal([...html.matchAll(/id="app-startup"/g)].length, 1, 'one startup panel is replaced by React')

  class EventHub {
    listeners = new Map()
    addEventListener(type, callback, options) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push({ callback, once: options?.once })
      this.listeners.set(type, listeners)
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.callback !== callback))
    }
    emit(type, target = this) {
      for (const { callback, once } of [...(this.listeners.get(type) ?? [])]) {
        callback({ type, target })
        if (once) this.removeEventListener(type, callback)
      }
    }
    get listenerCount() {
      return [...this.listeners.values()].reduce((total, listeners) => total + listeners.length, 0)
    }
  }

  const nodes = new Map()
  const window = new EventHub()
  const document = new EventHub()
  document.getElementById = (id) => nodes.get(id) ?? null
  // Loading recovery must never clear credentials or reload on its own.
  Object.defineProperty(window, 'localStorage', { get() { assert.fail('startup accessed login storage') } })
  let reloads = 0
  window.location = {
    href: 'https://detachym.test/account?from=desktop#preferences',
    reload() { reloads += 1 },
    assign() { assert.fail('automatic redirect') },
  }
  const observers = new Set()
  class MutationObserver {
    constructor(callback) { this.callback = callback }
    observe(root) { this.root = root; observers.add(this) }
    disconnect() { observers.delete(this) }
  }
  runInNewContext(inlineScripts[0][2], { window, document, MutationObserver })

  return {
    nodes, window, document, observers,
    get reloads() { return reloads },
    parseBody() {
      for (const id of ['app-startup', 'startup-title', 'startup-description', 'startup-actions', 'startup-reload']) {
        const element = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0]
        assert.ok(element, `missing ${id}`)
        nodes.set(id, Object.assign(new EventHub(), { hidden: /\bhidden(?:[\s=>])/.test(element), textContent: '' }))
      }
      nodes.get('startup-title').textContent = html.match(/id="startup-title"[^>]*>([^<]+)/)?.[1]
      nodes.set('root', { contains: (node) => node === nodes.get('app-startup') })
    },
    mountReact() {
      for (const id of [...nodes.keys()]) if (id !== 'root') nodes.delete(id)
      for (const observer of [...observers]) observer.callback()
    },
    assertFailure() {
      assert.equal(nodes.get('startup-title').textContent, '页面暂时没有打开')
      assert.equal(nodes.get('startup-description').hidden, false)
      assert.equal(nodes.get('startup-actions').hidden, false)
    },
    assertPending() {
      assert.equal(nodes.get('startup-title').textContent, '正在加载页面...')
      assert.equal(nodes.get('startup-description').hidden, true)
      assert.equal(nodes.get('startup-actions').hidden, true)
    },
  }
}

export function testStartupRecoveryHtml(html) {
  // A failed entry can be reported before the parser reaches #root.
  const early = startupHarness(html)
  early.window.emit('error', { tagName: 'SCRIPT' })
  early.parseBody()
  early.document.emit('DOMContentLoaded')
  early.assertFailure()
  assert.equal(early.reloads, 0)
  const originalUrl = early.window.location.href
  early.nodes.get('startup-reload').emit('click')
  assert.equal(early.reloads, 1)
  assert.equal(early.window.location.href, originalUrl, 'manual reload preserves a deep link, query and hash')

  for (const failure of ['module-download', 'module-evaluation', 'promise-rejection']) {
    const page = startupHarness(html)
    page.parseBody()
    page.document.emit('DOMContentLoaded')
    page.assertPending()
    if (failure === 'module-download') page.window.emit('error', { tagName: 'SCRIPT' })
    if (failure === 'module-evaluation') page.window.emit('error')
    if (failure === 'promise-rejection') page.window.emit('unhandledrejection')
    page.assertFailure()
    assert.equal(page.reloads, 0)
    const reloadButton = page.nodes.get('startup-reload')
    // A delayed successful mount removes the same panel and all guard listeners.
    page.mountReact()
    assert.equal(page.window.listenerCount, 0)
    assert.equal(page.observers.size, 0)
    assert.equal(reloadButton.listenerCount, 0)
    page.window.emit('error')
    assert.equal(page.nodes.size, 1)
  }

  for (const mountsBeforeDomReady of [false, true]) {
    const healthy = startupHarness(html)
    healthy.parseBody()
    healthy.window.emit('error', { tagName: 'IMG' })
    healthy.assertPending()
    if (mountsBeforeDomReady) healthy.mountReact()
    healthy.document.emit('DOMContentLoaded')
    if (!mountsBeforeDomReady) healthy.mountReact()
    assert.equal(healthy.window.listenerCount, 0)
    assert.equal(healthy.document.listenerCount, 0)
    assert.equal(healthy.observers.size, 0)
  }

  // The escape hatch is a native link even if the entry module never loads.
  const actions = html.match(/<div id="startup-actions"[^>]*>([\s\S]*?)<\/div>/)?.[1]
  assert.ok(actions)
  const links = [...actions.matchAll(/<a href="([^"]*)">([^<]+)/g)]
  const deepLink = 'https://detachym.test/account?from=desktop#preferences'
  assert.equal(new URL(links.find(([, , label]) => label === '返回首页')[1], deepLink).pathname, '/')
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]
  for (const child of children) {
    const result = findElement(child, predicate)
    if (result) return result
  }
  return null
}

export async function testWebRecovery(importCompiledModule) {
  testStartupRecoveryHtml(readFileSync(new URL('../index.html', import.meta.url), 'utf8'))
  const { default: RootErrorBoundary } = await importCompiledModule('src/components/RootErrorBoundary.js')
  const content = createElement('h1', null, '正常页面')
  // A synchronous React updater lets this unit test exercise the real component
  // lifecycle. DOM routing/paint still requires a separate browser acceptance.
  const updater = {
    enqueueSetState(instance, update) { instance.state = { ...instance.state, ...update } },
  }
  const boundary = new RootErrorBoundary({ resetKey: 'account-visit', children: content }, undefined, updater)
  const markup = () => renderToStaticMarkup(createElement(StaticRouter, { location: '/account' }, boundary.render()))
  const fail = () => { boundary.state = { ...boundary.state, ...RootErrorBoundary.getDerivedStateFromError(new Error('chunk missing')) } }
  const navigate = (key) => {
    const previous = boundary.props
    const previousState = boundary.state
    boundary.props = { ...previous, resetKey: key }
    boundary.componentDidUpdate(previous, previousState)
  }
  assert.match(markup(), /正常页面/)
  const healthyProps = boundary.props
  const healthyState = boundary.state
  boundary.props = { ...healthyProps, resetKey: 'first-failed-visit' }
  fail()
  boundary.componentDidUpdate(healthyProps, healthyState)
  assert.match(markup(), /页面暂时没有打开/, 'a new route failing for the first time must not automatically retry')
  navigate('account-visit')
  assert.match(markup(), /正常页面/)
  fail()
  assert.match(markup(), /页面暂时没有打开/)
  assert.match(markup(), /href="\/"[^>]*>返回首页/)
  navigate('account-visit')
  assert.match(markup(), /页面暂时没有打开/, 'store updates cannot loop by retrying a rejected chunk')
  navigate('home-visit')
  assert.match(markup(), /正常页面/, 'a different navigation can leave the failed page')
  fail()
  navigate('account-visit')
  assert.match(markup(), /正常页面/, 'Back to an earlier history entry also resets the boundary')
  fail()
  navigate('account-visit')
  assert.match(markup(), /页面暂时没有打开/)

  const previousWindow = globalThis.window
  let reloads = 0
  try {
    globalThis.window = {
      location: { reload() { reloads += 1 } },
      get localStorage() { assert.fail('recovery accessed login storage') },
    }
    assert.equal(reloads, 0)
    findElement(boundary.render(), (element) => element.type === 'button').props.onClick()
    assert.equal(reloads, 1, 'only an explicit refresh click reloads the document')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  console.log('web recovery: startup failure ordering, healthy mount cleanup, navigation reset, manual reload passed')
}
