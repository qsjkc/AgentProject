import { assertApiOperationContextCurrent, desktopApiRequest } from './api'
import { normalizePetDailySummary } from './pet-daily-summary'
import { normalizePetRelationshipMilestone } from './pet-milestone-state'
import { normalizePetRelationship } from './pet-relationship'
import { normalizePetWeeklySummary } from './pet-weekly-summary'


export async function getPetRelationship(petType, operationContext) {
  const relationship = await desktopApiRequest(`/pets/${petType}/relationship`, {}, operationContext)
  return normalizePetRelationship(relationship, petType)
}


export async function getPetDailySummary(petType, operationContext) {
  const summary = await desktopApiRequest(`/pets/${petType}/daily-summary`, {}, operationContext)
  return normalizePetDailySummary(summary, petType)
}


export async function getPetWeeklySummary(petType, operationContext) {
  const summary = await desktopApiRequest(`/pets/${petType}/weekly-summary`, {}, operationContext)
  return normalizePetWeeklySummary(summary, petType)
}


export async function markPetWeeklySummarySeen(petType, reviewKey, operationContext) {
  const summary = await desktopApiRequest(`/pets/${petType}/weekly-summary/seen`, {
    method: 'POST',
    body: JSON.stringify({ review_key: reviewKey }),
  }, operationContext)
  return normalizePetWeeklySummary(summary, petType)
}


export async function markPetWeeklySummaryShown(petType, reviewKey, operationContext) {
  const summary = await desktopApiRequest(`/pets/${petType}/weekly-summary/shown`, {
    method: 'POST',
    body: JSON.stringify({ review_key: reviewKey }),
  }, operationContext)
  return normalizePetWeeklySummary(summary, petType)
}


export async function refreshPetRelationship(petType, operationContext) {
  const relationship = await getPetRelationship(petType, operationContext)
  await assertApiOperationContextCurrent(operationContext)
  const cacheResult = await window.desktopBridge?.cachePetRelationship?.(relationship, operationContext)
  if (!cacheResult?.ok) {
    throw new Error(cacheResult?.reason || 'relationship_cache_rejected')
  }
  const transitionedContext = {
    ...operationContext,
    authoritative: cacheResult.authoritative,
  }
  await assertApiOperationContextCurrent(transitionedContext)
  return { ...relationship, __operation_authoritative: cacheResult.authoritative }
}


export async function rewardPetRelationship(petType, action, idempotencyKey, operationContext) {
  const result = await desktopApiRequest(`/pets/${petType}/relationship/rewards`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      idempotency_key: idempotencyKey,
    }),
  }, operationContext)
  return {
    ...result,
    relationship: normalizePetRelationship(result.relationship, petType),
  }
}

export async function updatePetOutfit(petType, slot, itemId, operationContext) {
  const relationship = normalizePetRelationship(
    await desktopApiRequest(`/pets/${petType}/relationship/outfit`, {
      method: 'PUT',
      body: JSON.stringify({
        slot,
        item_id: itemId || null,
      }),
    }, operationContext),
    petType,
  )
  await assertApiOperationContextCurrent(operationContext)
  const cacheResult = await window.desktopBridge?.cachePetRelationship?.(relationship, operationContext)
  if (!cacheResult?.ok) {
    throw new Error(cacheResult?.reason || 'relationship_cache_rejected')
  }
  const transitionedContext = {
    ...operationContext,
    authoritative: cacheResult.authoritative,
  }
  await assertApiOperationContextCurrent(transitionedContext)
  return { ...relationship, __operation_authoritative: cacheResult.authoritative }
}


export async function claimPetRelationshipMilestone(petType, claimToken, operationContext) {
  const milestone = await desktopApiRequest(
    `/pets/${petType}/relationship/milestones/claim`,
    {
      method: 'POST',
      body: JSON.stringify({ claim_token: claimToken }),
    },
    operationContext,
  )
  return normalizePetRelationshipMilestone(milestone, petType)
}


export async function acknowledgePetRelationshipMilestone(
  petType,
  milestoneId,
  claimToken,
  operationContext,
) {
  const milestone = await desktopApiRequest(
    `/pets/${petType}/relationship/milestones/${milestoneId}/ack`,
    {
      method: 'POST',
      body: JSON.stringify({ claim_token: claimToken }),
    },
    operationContext,
  )
  return normalizePetRelationshipMilestone(milestone, petType)
}
