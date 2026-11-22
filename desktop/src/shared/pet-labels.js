const petLabelKeys = new Map([
  ['cat', 'petCat'],
  ['dog', 'petDog'],
  ['pig', 'petPig'],
])

export function getPetLabelKey(petType) {
  return petLabelKeys.get(petType) ?? petLabelKeys.get('cat')
}
