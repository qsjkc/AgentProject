import { assertEqual, waitFor } from './assertions.mjs'
import { callE2e } from './p1k-scenarios.mjs'

export async function petDragScenario(context) {
  const { pet } = context.pages
  await callE2e(pet, 'showWindow', 'pet')
  await pet.waitForSelector('[data-e2e="pet-surface"]')
  const dragSequence = (pointerId, pointerType, events) => pet.evaluate(`(() => {
    const surface = document.querySelector('[data-e2e="pet-surface"]');
    const bounds = surface.getBoundingClientRect();
    for (const [type, screenX, screenY, buttons] of ${JSON.stringify(events)}) {
      surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true, pointerType: ${JSON.stringify(pointerType)}, pointerId: ${pointerId},
        button: 0, buttons, screenX, screenY,
        clientX: Math.round(bounds.left + bounds.width / 2), clientY: Math.round(bounds.top + bounds.height / 2),
      }));
    }
  })()`)
  const drag = (type, pointerId, x, y, pointerType = 'pen') => dragSequence(pointerId, pointerType, [
    [type, x, y, type === 'pointerup' || type === 'pointercancel' ? 0 : 1],
  ])
  const bounds = () => pet.evaluate('window.desktopBridge.getPetBounds()')
  const grab = async (pointerId, pointerType = 'pen') => {
    const start = await pet.evaluate(`(async () => {
      const rect = document.querySelector('[data-e2e="pet-surface"]').getBoundingClientRect();
      const bounds = await window.desktopBridge.getPetBounds();
      return { x: bounds.x, y: bounds.y, grabX: bounds.x + Math.round(rect.left + rect.width / 2),
        grabY: bounds.y + Math.round(rect.top + rect.height / 2) };
    })()`)
    await drag('pointerdown', pointerId, start.grabX, start.grabY, pointerType)
    return start
  }
  const expectPosition = (x, y, description) => waitFor(async () => {
    const position = await bounds()
    return Math.abs(position.x - x) <= 2 && Math.abs(position.y - y) <= 2
  }, { description })

  await pet.evaluate('window.desktopBridge.resetPetPosition()')
  const start = await grab(71)
  await drag('pointermove', 71, start.grabX + 64, start.grabY + 58)
  await expectPosition(start.x + 64, start.y + 58, 'moving the pet using the original grab point')
  await drag('pointercancel', 71, 0, 0)
  await drag('pointermove', 71, start.grabX + 133, start.grabY + 129)
  const cancelled = await bounds()
  await expectPosition(start.x + 64, start.y + 58, 'ignoring cancelled coordinates and late movement')

  const fresh = await grab(72)
  await drag('pointermove', 72, fresh.grabX + 37, fresh.grabY + 18)
  await drag('pointerup', 72, fresh.grabX + 49, fresh.grabY + 26)
  await expectPosition(fresh.x + 49, fresh.y + 26, 'applying the release sample for a fresh drag')
  assertEqual(fresh.x, cancelled.x, 'New drag must start from the actual position after cancellation')
  assertEqual(fresh.y, cancelled.y, 'New drag must start from the actual position after cancellation')

  const mouse = await grab(73, 'mouse')
  await dragSequence(73, 'mouse', [
    ['pointermove', mouse.grabX + 24, mouse.grabY + 13, 1],
    ['pointermove', mouse.grabX + 130, mouse.grabY + 109, 0],
    ['pointermove', mouse.grabX + 145, mouse.grabY + 118, 1],
  ])
  await drag('pointerup', 74, mouse.grabX + 170, mouse.grabY + 150, 'mouse')
  await pet.evaluate('new Promise(resolve => setTimeout(resolve, 35))')
  const beforeRelease = await bounds()
  assertEqual(beforeRelease.x, mouse.x, 'A mouse move before the matching release changed the window')
  assertEqual(beforeRelease.y, mouse.y, 'A mouse move before the matching release changed the window')
  await drag('pointerup', 73, mouse.grabX + 56, mouse.grabY + 33, 'mouse')
  await expectPosition(mouse.x + 56, mouse.y + 33, 'applying the matching release after a mouse move without its left button')

  const abandoned = await grab(75, 'mouse')
  await dragSequence(75, 'mouse', [
    ['pointermove', abandoned.grabX + 21, abandoned.grabY + 13, 1],
    ['pointermove', abandoned.grabX + 130, abandoned.grabY + 100, 0],
  ])
  await pet.evaluate('new Promise(resolve => setTimeout(resolve, 500))')
  await drag('pointerup', 75, abandoned.grabX + 60, abandoned.grabY + 37, 'mouse')
  const afterTimeout = await bounds()
  assertEqual(afterTimeout.x, abandoned.x, 'The expired mouse drag applied a stale release position')
  assertEqual(afterTimeout.y, abandoned.y, 'The expired mouse drag applied a stale release position')
  return {
    fixedGrabPoint: true,
    cancelledEventIgnored: true,
    newDragCompleted: true,
    delayedMouseReleaseApplied: true,
    missingMouseReleaseExpired: true,
  }
}
