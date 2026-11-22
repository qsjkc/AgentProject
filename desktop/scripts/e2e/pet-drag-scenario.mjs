import { assertEqual, waitFor } from './assertions.mjs'
import { callE2e } from './p1k-scenarios.mjs'

export async function petDragScenario(context) {
  const { pet } = context.pages
  await callE2e(pet, 'showWindow', 'pet')
  await pet.waitForSelector('[data-e2e="pet-surface"]')
  const drag = (type, pointerId, x, y) => pet.evaluate(`(() => {
    const surface = document.querySelector('[data-e2e="pet-surface"]');
    const bounds = surface.getBoundingClientRect();
    surface.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true, isPrimary: true, pointerType: 'pen', pointerId: ${pointerId},
      button: 0, buttons: ${type === 'pointerup' || type === 'pointercancel' ? 0 : 1},
      clientX: Math.round(bounds.left + bounds.width / 2), clientY: Math.round(bounds.top + bounds.height / 2),
      screenX: ${x}, screenY: ${y},
    }));
  })()`)
  const bounds = () => pet.evaluate('window.desktopBridge.getPetBounds()')
  const grab = async (pointerId) => {
    const start = await pet.evaluate(`(async () => {
      const rect = document.querySelector('[data-e2e="pet-surface"]').getBoundingClientRect();
      const bounds = await window.desktopBridge.getPetBounds();
      return { x: bounds.x, y: bounds.y, grabX: bounds.x + Math.round(rect.left + rect.width / 2),
        grabY: bounds.y + Math.round(rect.top + rect.height / 2) };
    })()`)
    await drag('pointerdown', pointerId, start.grabX, start.grabY)
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
  return { fixedGrabPoint: true, cancelledEventIgnored: true, newDragCompleted: true }
}
