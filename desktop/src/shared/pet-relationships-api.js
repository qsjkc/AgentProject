import { desktopApiRequest } from './api'
import { normalizePetRelationship } from './pet-relationship'


export async function getPetRelationship(petType) {
  const relationship = await desktopApiRequest(`/pets/${petType}/relationship`)
  return normalizePetRelationship(relationship, petType)
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
