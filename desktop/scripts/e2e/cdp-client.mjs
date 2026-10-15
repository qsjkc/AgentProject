import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { waitFor } from './assertions.mjs'

async function messageText(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (data && typeof data.text === 'function') return data.text()
  return String(data)
}

function cdpError(message, details = undefined) {
  const error = new Error(message)
  error.name = 'CdpError'
  error.details = details
  return error
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => (
    /^(authorization|cookie|set-cookie)$/i.test(key) ? [key, '[redacted]'] : [key, value]
  )))
}

function redactNetworkParams(params) {
  const result = { ...params }
  if (params.request) {
    result.request = {
      ...params.request,
      headers: redactHeaders(params.request.headers),
      postData: params.request.postData
        ?.replace(/("password"\s*:\s*")[^"]*/gi, '$1[redacted]')
        .replace(/(name="password"\r?\n(?:[^\r\n]*\r?\n)*\r?\n)[^\r\n]*/gi, '$1[redacted]'),
    }
  }
  if (params.response) {
    result.response = { ...params.response, headers: redactHeaders(params.response.headers) }
  }
  return result
}

export class CdpClient {
  constructor(socket, { defaultTimeoutMs = 10_000 } = {}) {
    this.socket = socket
    this.defaultTimeoutMs = defaultTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.diagnostics = {
      console: [],
      exceptions: [],
      log: [],
      network: [],
    }
    socket.addEventListener('message', (event) => {
      void this.#onMessage(event.data)
    })
    socket.addEventListener('close', () => this.#rejectPending(cdpError('CDP socket closed')))
    socket.addEventListener('error', () => this.#rejectPending(cdpError('CDP socket error')))
  }

  static async connect(url, { timeoutMs = 10_000, webSocketFactory = (value) => new WebSocket(value) } = {}) {
    const socket = webSocketFactory(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(cdpError('Timed out opening CDP socket', { url, timeoutMs })), timeoutMs)
      const cleanup = () => clearTimeout(timer)
      socket.addEventListener('open', () => {
        cleanup()
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        cleanup()
        reject(cdpError('Failed to open CDP socket', { url }))
      }, { once: true })
    })
    return new CdpClient(socket, { defaultTimeoutMs: timeoutMs })
  }

  async #onMessage(data) {
    let message
    try {
      message = JSON.parse(await messageText(data))
    } catch {
      return
    }
    if (Number.isInteger(message.id)) {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) {
        request.reject(cdpError(`CDP ${request.method} failed: ${message.error.message}`, message.error))
      } else {
        request.resolve(message.result || {})
      }
      return
    }
    if (!message.method) return
    this.#recordDiagnostic(message.method, message.params || {})
    for (const listener of this.listeners.get(message.method) || []) {
      try {
        listener(message.params || {})
      } catch {
        // A diagnostic listener must not break protocol dispatch.
      }
    }
  }

  #recordDiagnostic(method, params) {
    const at = new Date().toISOString()
    if (method === 'Runtime.consoleAPICalled') this.diagnostics.console.push({ at, ...params })
    else if (method === 'Runtime.exceptionThrown') this.diagnostics.exceptions.push({ at, ...params })
    else if (method === 'Log.entryAdded') this.diagnostics.log.push({ at, ...params })
    else if (
      method === 'Network.requestWillBeSent'
      || method === 'Network.responseReceived'
      || method === 'Network.loadingFailed'
    ) this.diagnostics.network.push({ at, method, ...redactNetworkParams(params) })
  }

  #rejectPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set()
    listeners.add(listener)
    this.listeners.set(method, listeners)
    return () => listeners.delete(listener)
  }

  send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(cdpError(`Timed out waiting for CDP ${method}`, { id, method, timeoutMs }))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async enable() {
    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Page.enable'),
      this.send('DOM.enable'),
      this.send('Input.setIgnoreInputEvents', { ignore: false }),
      this.send('Network.enable'),
      this.send('Log.enable'),
    ])
    return this
  }

  async evaluate(expression, {
    awaitPromise = true,
    returnByValue = true,
    userGesture = true,
    timeoutMs = this.defaultTimeoutMs,
  } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture,
    }, { timeoutMs })
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Runtime evaluation failed'
      throw cdpError(description, result.exceptionDetails)
    }
    return returnByValue ? result.result?.value : result.result
  }

  async waitForReady({ timeoutMs = 15_000 } = {}) {
    return waitFor(
      async () => {
        const state = await this.evaluate('document.readyState')
        return state === 'interactive' || state === 'complete'
      },
      { timeoutMs, description: 'document readiness' },
    )
  }

  async waitForSelector(selector, {
    timeoutMs = 10_000,
    visible = true,
  } = {}) {
    const encoded = JSON.stringify(selector)
    await waitFor(
      () => this.evaluate(`(() => {
        const node = document.querySelector(${encoded});
        if (!node) return false;
        if (!${Boolean(visible)}) return true;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })()`),
      { timeoutMs, description: `selector ${selector}` },
    )
    return selector
  }

  async #nodeId(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw cdpError(`Selector did not resolve to a DOM node: ${selector}`)
    return nodeId
  }

  async click(selector) {
    await this.waitForSelector(selector)
    const encoded = JSON.stringify(selector)
    await this.evaluate(`document.querySelector(${encoded})?.scrollIntoView({block:'center', inline:'center'})`)
    const nodeId = await this.#nodeId(selector)
    const { model } = await this.send('DOM.getBoxModel', { nodeId })
    const quad = model.border || model.content
    if (!Array.isArray(quad) || quad.length !== 8) {
      throw cdpError(`Could not determine clickable box for ${selector}`)
    }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', buttons: 0,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    })
    return { x, y }
  }

  async input(selector, text, { clear = true } = {}) {
    await this.click(selector)
    if (clear) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
      })
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
      })
      await this.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      })
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      })
    }
    await this.send('Input.insertText', { text: String(text) })
  }

  async screenshot(filePath, { format = 'png', timeoutMs = 5_000 } = {}) {
    await mkdir(dirname(filePath), { recursive: true })
    const { data } = await this.send('Page.captureScreenshot', {
      format,
      fromSurface: true,
      captureBeyondViewport: false,
    }, { timeoutMs })
    await writeFile(filePath, Buffer.from(data, 'base64'))
    return filePath
  }

  async reload({ ignoreCache = true, timeoutMs = 15_000 } = {}) {
    await this.send('Page.reload', { ignoreCache })
    await this.waitForReady({ timeoutMs })
  }

  async bringToFront() {
    await this.send('Page.bringToFront')
  }

  close() {
    this.socket.close()
  }
}

export async function readDevToolsActivePort(userDataPath) {
  const filePath = join(userDataPath, 'DevToolsActivePort')
  const content = await readFile(filePath, 'utf8')
  const [portLine, browserPath] = content.trim().split(/\r?\n/)
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0 || !browserPath?.startsWith('/devtools/browser/')) {
    throw cdpError('Invalid DevToolsActivePort contents', { filePath, content })
  }
  return { port, browserPath, filePath }
}

export async function waitForDevToolsActivePort(userDataPath, { timeoutMs = 20_000 } = {}) {
  return waitFor(
    () => readDevToolsActivePort(userDataPath).catch(() => null),
    { timeoutMs, intervalMs: 100, description: 'DevToolsActivePort' },
  )
}

export async function fetchPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    cache: 'no-store', signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw cdpError(`DevTools /json/list returned HTTP ${response.status}`)
  const targets = await response.json()
  return targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
}

export function rendererEntryName(targetUrl) {
  try {
    const pathname = decodeURIComponent(new URL(targetUrl).pathname)
    return basename(pathname.replace(/\\/g, '/'))
  } catch {
    return basename(String(targetUrl).split(/[?#]/)[0].replace(/\\/g, '/'))
  }
}

export function mapRendererTargets(targets) {
  const expected = new Set(['pet.html', 'quick-chat.html', 'main-panel.html'])
  const result = new Map()
  for (const target of targets) {
    const entry = rendererEntryName(target.url)
    if (expected.has(entry)) result.set(entry, target)
  }
  return result
}
