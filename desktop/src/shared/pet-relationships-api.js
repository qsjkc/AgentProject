import { desktopApiRequest } from './api'
import { normalizePetDailySummary } from './pet-daily-summary'
import { normalizePetRelationship } from './pet-relationship'
import { normalizePetWeeklySummary } from './pet-weekly-summary'


export async function getPetRelationship(petType) {
  const relationship = await desktopApiRequest(`/pets/${petType}/relationship`)
  return normalizePetRelationship(relationship, petType)
}


export async function getPetDailySummary(petType) {
  const summary = await desktopApiRequest(`/pets/${petType}/daily-summary`)
  return normalizePetDailySummary(summary, petType)
}


export async function getPetWeeklySummary(petType) {
  const summary = await desktopApiRequest(`/pets/${petType}/weekly-summary`)
  return normalizePetWeeklySummary(summary, petType)
}


export async function markPetWeeklySummarySeen(petType, reviewKey) {
  const summary = await desktopApiRequest(`/pets/${petType}/weekly-summary/seen`, {
    method: 'POST',
    body: JSON.stringify({ review_key: reviewKey }),
  })
  return normalizePetWeeklySummary(summary, petType)
}


export async function refreshPetRelationship(petType) {
  const relationship = await getPetRelationship(petType)
  await window.desktopBridge?.cachePetRelationship?.(relationship)
  return relationship
}


export async function rewardPetRelationship(petType, action, idempotencyKey) {
  const result = await desktopApiRequest(`/pets/${petType}/relationship/rewards`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      idempotency_key: idempotencyKey,
    }),
  })
  return {
    ...result,
    relationship: normalizePetRelationship(result.relationship, petType),
  }
}

export async function updatePetOutfit(petType, slot, itemId) {
  const relationship = normalizePetRelationship(
    await desktopApiRequest(`/pets/${petType}/relationship/outfit`, {
      method: 'PUT',
      body: JSON.stringify({
        slot,
        item_id: itemId || null,
      }),
    }),
    petType,
  )
  await window.desktopBridge?.cachePetRelationship?.(relationship)
  return relationship
}
