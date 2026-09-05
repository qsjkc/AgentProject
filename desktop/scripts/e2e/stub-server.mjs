import { createServer } from 'node:http'

import {
  USERS,
  createDailySummary,
  createReminderRecord,
  createStubFixture,
  createUserResponse,
  createWeeklySummary,
  decodeJwtSubject,
} from './fixtures.mjs'

function json(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function noContent(response) {
  response.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  })
  response.end()
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('Stub request body exceeds 2 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(body) {
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

function parseLoginBody(body, contentType = '') {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body))
  }
  const result = {}
  for (const key of ['username', 'password']) {
    const match = body.match(new RegExp(
      `name="${key}"[^\\r\\n]*\\r?\\n(?:[^\\r\\n]+\\r?\\n)*\\r?\\n([^\\r\\n]*)`,
      'i',
    ))
    if (match) result[key] = match[1]
  }
  return result
}

function sanitizeBody(body) {
  if (!body) return ''
  return body
    .replace(/(name="password"\r?\n(?:[^\r\n]*\r?\n)*\r?\n)[^\r\n]*/gi, '$1[redacted]')
    .replace(/("password"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .slice(0, 4_096)
}

function routeKey(method, pathname) {
  return `${String(method).toUpperCase()} ${pathname}`
}

function createDeferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export class StubServer {
  constructor({ fixture = createStubFixture(), host = '127.0.0.1' } = {}) {
    this.fixture = fixture
    this.host = host
    this.server = null
    this.origin = null
    this.apiBaseUrl = null
    this.requests = []
    this.controls = new Map()
  }

  async start() {
    if (this.server) return this
    this.server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent) {
          json(response, 500, { detail: error.message || 'stub failure' })
        } else {
          response.destroy(error)
        }
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, this.host, resolve)
    })
    const address = this.server.address()
    this.origin = `http://${this.host}:${address.port}`
    this.apiBaseUrl = `${this.origin}/api/v1`
    return this
  }

  async close() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections?.()
    })
  }

  holdNext(method, pathname) {
    const arrived = createDeferred()
    const released = createDeferred()
    const control = {
      type: 'hold',
      arrived: arrived.promise,
      release: () => released.resolve(),
      _arrive: arrived.resolve,
      _released: released.promise,
    }
    this.#enqueueControl(method, pathname, control)
    return control
  }

  delayNext(method, pathname, delayMs) {
    const arrived = createDeferred()
    const control = {
      type: 'delay',
      delayMs,
      arrived: arrived.promise,
      _arrive: arrived.resolve,
    }
    this.#enqueueControl(method, pathname, control)
    return control
  }

  #enqueueControl(method, pathname, control) {
    const key = routeKey(method, pathname)
    const queue = this.controls.get(key) || []
    queue.push(control)
    this.controls.set(key, queue)
  }

  async #applyControl(method, pathname, requestRecord) {
    const key = routeKey(method, pathname)
    const queue = this.controls.get(key)
    const control = queue?.shift()
    if (!control) return
    if (queue.length === 0) this.controls.delete(key)
    control._arrive(requestRecord)
    if (control.type === 'hold') {
      await control._released
    } else if (control.type === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, control.delayMs))
    }
  }

  #accountForRequest(request) {
    const authorization = String(request.headers.authorization || '')
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    const subject = decodeJwtSubject(token)
    return subject === null ? null : this.fixture.accounts.get(subject) || null
  }

  #relationship(account, petType) {
    return account.relationshipByPet.get(petType) || account.relationshipByPet.get('pig')
  }

  async #handle(request, response) {
    const requestUrl = new URL(request.url, this.origin || `http://${this.host}`)
    const method = String(request.method || 'GET').toUpperCase()
    const body = await readBody(request)
    const record = {
      sequence: this.requests.length + 1,
      at: new Date().toISOString(),
      method,
      pathname: requestUrl.pathname,
      search: requestUrl.search,
      authorization: request.headers.authorization ? 'Bearer [redacted]' : null,
      body: sanitizeBody(body),
    }
    this.requests.push(record)
    await this.#applyControl(method, requestUrl.pathname, record)

    if (method === 'OPTIONS') {
      noContent(response)
      return
    }
    if (!requestUrl.pathname.startsWith('/api/v1')) {
      json(response, 404, { detail: 'Unknown stub path' })
      return
    }
    const path = requestUrl.pathname.slice('/api/v1'.length) || '/'

    if (method === 'GET' && path === '/public/version/win-x64') {
      json(response, 200, {
        version: '1.0.0-e2e',
        platform: 'win-x64',
        download_url: `${this.origin}/downloads/detachym-e2e.exe`,
      })
      return
    }

    if (method === 'POST' && path === '/auth/login') {
      const credentials = parseLoginBody(body, String(request.headers['content-type'] || ''))
      const account = [...this.fixture.accounts.values()].find(({ user }) => (
        (user.username === credentials.username || user.email === credentials.username)
        && user.password === credentials.password
      ))
      if (!account) {
        json(response, 401, { detail: 'Incorrect username or password' })
        return
      }
      json(response, 200, { access_token: account.token, token_type: 'bearer' })
      return
    }

    const account = this.#accountForRequest(request)
    if (!account) {
      json(response, 401, { detail: 'Could not validate credentials' })
      return
    }

    if (method === 'GET' && path === '/auth/me') {
      json(response, 200, createUserResponse(account.user, account.preferences, this.fixture.now))
      return
    }
    if (path === '/users/me/preferences' && method === 'GET') {
      json(response, 200, account.preferences)
      return
    }
    if (path === '/users/me/preferences' && method === 'PUT') {
      const patch = parseJson(body)
      account.preferences = {
        ...account.preferences,
        ...patch,
        id: account.preferences.id,
        user_id: account.user.id,
        updated_at: new Date().toISOString(),
      }
      json(response, 200, account.preferences)
      return
    }

    if (method === 'GET' && path === '/chat/sessions') {
      json(response, 200, account.sessions)
      return
    }
    const sessionMatch = path.match(/^\/chat\/sessions\/(\d+)$/)
    if (method === 'GET' && sessionMatch) {
      const session = account.sessions.find(({ id }) => id === Number(sessionMatch[1]))
      json(response, session ? 200 : 404, session || { detail: 'Session not found' })
      return
    }
    if (method === 'POST' && path === '/chat/message') {
      const payload = parseJson(body)
      let session = account.sessions.find(({ id }) => id === Number(payload.session_id))
      const now = new Date().toISOString()
      if (!session) {
        session = {
          id: this.fixture.nextSessionId++,
          user_id: account.user.id,
          title: 'E2E chat',
          created_at: now,
          updated_at: now,
          messages: [],
        }
        account.sessions.unshift(session)
      }
      session.messages.push({
        id: session.messages.length + 1,
        session_id: session.id,
        role: 'user',
        content: String(payload.message || ''),
        created_at: now,
      })
      const content = `E2E 小猪收到：${String(payload.message || '')}`
      session.messages.push({
        id: session.messages.length + 1,
        session_id: session.id,
        role: 'assistant',
        content,
        created_at: now,
      })
      session.updated_at = now
      json(response, 200, {
        content,
        session_id: session.id,
        role: 'assistant',
        done: true,
        knowledge_used: false,
        sources: [],
      })
      return
    }

    if (method === 'GET' && path === '/rag/documents') {
      json(response, 200, [])
      return
    }

    const relationshipMatch = path.match(/^\/pets\/(cat|dog|pig)\/relationship$/)
    if (method === 'GET' && relationshipMatch) {
      json(response, 200, this.#relationship(account, relationshipMatch[1]))
      return
    }
    const rewardMatch = path.match(/^\/pets\/(cat|dog|pig)\/relationship\/rewards$/)
    if (method === 'POST' && rewardMatch) {
      const relationship = this.#relationship(account, rewardMatch[1])
      relationship.intimacy_xp += 2
      relationship.progress = { current: relationship.intimacy_xp, required: 100, percent: relationship.intimacy_xp }
      relationship.updated_at = new Date().toISOString()
      json(response, 200, {
        action: parseJson(body).action || 'poke',
        requested_xp: 2,
        awarded_xp: 2,
        reason: 'awarded',
        cooldown_remaining_seconds: 0,
        action_daily_awarded_xp: 2,
        daily_awarded_xp: 2,
        level_up: false,
        relationship,
      })
      return
    }
    const outfitMatch = path.match(/^\/pets\/(cat|dog|pig)\/relationship\/outfit$/)
    if (method === 'PUT' && outfitMatch) {
      const relationship = this.#relationship(account, outfitMatch[1])
      const payload = parseJson(body)
      if (payload.item_id) relationship.outfit.equipped_outfits[payload.slot] = payload.item_id
      else delete relationship.outfit.equipped_outfits[payload.slot]
      relationship.updated_at = new Date().toISOString()
      json(response, 200, relationship)
      return
    }
    if (method === 'POST' && /^\/pets\/(cat|dog|pig)\/relationship\/milestones\/claim$/.test(path)) {
      noContent(response)
      return
    }
    if (method === 'POST' && /^\/pets\/(cat|dog|pig)\/relationship\/milestones\/\d+\/ack$/.test(path)) {
      json(response, 404, { detail: 'No E2E milestone is claimable' })
      return
    }

    const dailyMatch = path.match(/^\/pets\/(cat|dog|pig)\/daily-summary$/)
    if (method === 'GET' && dailyMatch) {
      json(response, 200, createDailySummary(dailyMatch[1], this.fixture.now))
      return
    }
    const weeklyMatch = path.match(/^\/pets\/(cat|dog|pig)\/weekly-summary(?:\/(shown|seen))?$/)
    if (weeklyMatch && (method === 'GET' || method === 'POST')) {
      const summary = createWeeklySummary(weeklyMatch[1])
      if (weeklyMatch[2]) summary.reviewed_at = new Date().toISOString()
      json(response, 200, summary)
      return
    }

    if (path === '/reminders' && method === 'POST') {
      const payload = parseJson(body)
      const reminder = createReminderRecord({
        id: this.fixture.nextReminderId++,
        user: account.user,
        petType: payload.pet_type || 'pig',
        title: payload.title,
        sourceText: payload.source_text,
        remindAt: payload.remind_at ? new Date(payload.remind_at) : undefined,
      })
      reminder.email_enabled = Boolean(payload.email_enabled)
      reminder.email_status = reminder.email_enabled ? 'pending' : 'disabled'
      reminder.recurrence_type = payload.recurrence_type || 'once'
      account.reminders.push(reminder)
      json(response, 200, reminder)
      return
    }
    if (path === '/reminders' && method === 'GET') {
      let reminders = [...account.reminders]
      const petType = requestUrl.searchParams.get('pet_type')
      const status = requestUrl.searchParams.get('status')
      const dueBefore = Date.parse(requestUrl.searchParams.get('due_before') || '')
      const triggered = requestUrl.searchParams.get('triggered')
      if (petType) reminders = reminders.filter((item) => item.pet_type === petType)
      if (status) reminders = reminders.filter((item) => item.status === status)
      if (Number.isFinite(dueBefore)) reminders = reminders.filter((item) => Date.parse(item.remind_at) <= dueBefore)
      if (triggered === 'true') reminders = reminders.filter((item) => item.triggered_at)
      if (triggered === 'false') reminders = reminders.filter((item) => !item.triggered_at)
      json(response, 200, reminders)
      return
    }
    if (path === '/reminders/pending-summary' && method === 'GET') {
      const petType = requestUrl.searchParams.get('pet_type') || 'pig'
      json(response, 200, {
        pet_type: petType,
        pending_count: account.reminders.filter((item) => item.pet_type === petType && item.status === 'pending').length,
      })
      return
    }
    const reminderActionMatch = path.match(/^\/reminders\/(\d+)\/(trigger|complete)$/)
    if (method === 'POST' && reminderActionMatch) {
      const reminder = account.reminders.find(({ id }) => id === Number(reminderActionMatch[1]))
      if (!reminder) {
        json(response, 404, { detail: 'Reminder not found' })
        return
      }
      const now = new Date().toISOString()
      reminder.triggered_at ||= now
      if (reminderActionMatch[2] === 'complete') {
        reminder.status = 'completed'
        reminder.completed_at = now
      }
      reminder.updated_at = now
      json(response, 200, reminder)
      return
    }
    const reminderPatchMatch = path.match(/^\/reminders\/(\d+)$/)
    if (method === 'PATCH' && reminderPatchMatch) {
      const reminder = account.reminders.find(({ id }) => id === Number(reminderPatchMatch[1]))
      if (!reminder) {
        json(response, 404, { detail: 'Reminder not found' })
        return
      }
      Object.assign(reminder, parseJson(body), { updated_at: new Date().toISOString() })
      json(response, 200, reminder)
      return
    }
    if (path === '/reminder-series' && method === 'GET') {
      json(response, 200, [])
      return
    }

    json(response, 404, {
      detail: `Unhandled E2E stub route: ${method} ${path}`,
      availableUsers: [USERS.A.username, USERS.B.username],
    })
  }
}

export async function startStubServer(options = {}) {
  return new StubServer(options).start()
}
