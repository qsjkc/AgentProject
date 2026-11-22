import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  createMainPanelIntentCoordinator,
  createReminderNotificationNavigation,
  isSameTodayNavigationContext,
  showWindowsReminderNotification,
} from '../electron/main-panel-intent.cjs'

const context = {
  server: 'https://example.test',
  userId: 41,
  petType: 'pig',
  generation: 5,
}

test('clicking a reminder after the banner times out queues Today once for its original context', async () => {
  const deliveries = []
  const coordinator = createMainPanelIntentCoordinator({
    createId: () => 'reminder-today',
    validateContext: (expected) => isSameTodayNavigationContext(context, expected),
    deliver: (payload) => deliveries.push(payload),
  })
  let opened = 0
  let navigation
  const bind = createReminderNotificationNavigation({
    readContext: () => ({ ...context }),
    openToday: (captured) => {
      opened += 1
      navigation = coordinator.request('today', { context: captured })
    },
  })
  const notification = new EventEmitter()
  bind(notification)
  notification.emit('close')
  assert.equal(opened, 0)
  notification.emit('click')
  notification.emit('click')
  assert.equal(opened, 1)
  assert.deepEqual(deliveries, [])
  coordinator.markRendererReady()
  assert.deepEqual(deliveries, [{ id: 'reminder-today', intent: 'today', authoritative: context }])
  assert.equal(coordinator.acknowledge('reminder-today'), true)
  assert.equal(await navigation, true)
  assert.equal(notification.listenerCount('failed'), 0)
})

test('a reminder click cannot open the window after its account, server, pet or session changes', () => {
  let current = context
  const bind = createReminderNotificationNavigation({
    readContext: () => current,
    openToday: () => assert.fail('a stale reminder opened Today'),
  })
  for (const change of [
    { server: 'https://other.example.test' },
    { userId: 42 },
    { petType: 'cat' },
    { generation: 6 },
    null,
  ]) {
    current = context
    const notification = new EventEmitter()
    bind(notification)
    current = change && { ...context, ...change }
    notification.emit('click')
    current = context
    assert.equal(notification.emit('click'), false)
  }
})

test('failed and evicted reminders release their handlers without opening Today', () => {
  let opened = 0
  const bind = createReminderNotificationNavigation({
    readContext: () => context,
    openToday: () => { opened += 1 },
  })
  const failed = new EventEmitter()
  bind(failed)
  failed.emit('failed')
  assert.equal(failed.emit('click'), false)
  const notifications = Array.from({ length: 33 }, () => {
    const notification = new EventEmitter()
    bind(notification)
    return notification
  })
  assert.equal(notifications[0].emit('click'), false)
  assert.equal(notifications[0].listenerCount('failed'), 0)
  assert.equal(opened, 0)
  assert.equal(notifications[1].emit('click'), true)
  assert.equal(opened, 1)
})

test('Windows reminder acceptance retains navigation after a synchronous show', () => {
  let opened = 0
  const bind = createReminderNotificationNavigation({
    readContext: () => context,
    openToday: () => { opened += 1 },
  })
  const notification = new EventEmitter()
  notification.show = () => notification.emit('show')

  assert.equal(showWindowsReminderNotification(notification, bind), true)
  assert.equal(notification.listenerCount('show'), 0)
  assert.equal(notification.listenerCount('failed'), 1)
  notification.emit('close')
  notification.emit('click')
  assert.equal(opened, 1)
})

test('Windows reminder rejection, missing receipt and throw each skip navigation retention', () => {
  const bind = () => assert.fail('an unaccepted reminder retained navigation')
  for (const outcome of [
    () => {},
    (notification) => notification.emit('failed'),
    (notification) => {
      notification.emit('show')
      notification.emit('failed')
    },
    (notification) => {
      notification.emit('show')
      throw new Error('WinRT threw')
    },
  ]) {
    const notification = new EventEmitter()
    notification.show = () => outcome(notification)

    assert.equal(showWindowsReminderNotification(notification, bind), false)
    assert.equal(notification.listenerCount('show'), 0)
    assert.equal(notification.listenerCount('failed'), 0)
    assert.equal(notification.emit('show'), false)
    assert.equal(notification.emit('click'), false)
  }
})

test('a failure after Windows accepted the reminder releases navigation without resubmitting', () => {
  const bind = createReminderNotificationNavigation({
    readContext: () => context,
    openToday: () => assert.fail('a later failed reminder opened Today'),
  })
  const notification = new EventEmitter()
  let submissions = 0
  notification.show = () => {
    submissions += 1
    notification.emit('show')
  }

  assert.equal(showWindowsReminderNotification(notification, bind), true)
  assert.equal(notification.emit('failed'), true)
  assert.equal(notification.listenerCount('failed'), 0)
  assert.equal(notification.emit('click'), false)
  assert.equal(submissions, 1)
})
