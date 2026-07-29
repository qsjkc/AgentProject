import { useEffect, useMemo, useState } from 'react'
import { Check, Lock, RotateCcw } from 'lucide-react'

import {
  getPetOutfitCatalog,
  getPetOutfitSlotLabel,
} from '../shared/pet-outfits'
import { OutfitSprite } from './PetOutfitRenderer'

const SELECTABLE_SLOTS = ['neck', 'head', 'side']

function getCopy(language) {
  if (language === 'zh-CN') {
    return {
      title: '小猪装扮',
      clear: '清空当前槽位',
      equipped: '已装备',
      available: '可使用',
      unlockLevel: (level) => `Lv.${level} 解锁`,
    }
  }

  return {
    title: 'Pig outfits',
    clear: 'Clear current slot',
    equipped: 'Equipped',
    available: 'Available',
    unlockLevel: (level) => `Unlocks at Lv.${level}`,
  }
}

export function PetOutfitPanel({
  language,
  petType,
  relationship,
  saving,
  onChange,
}) {
  const [activeSlot, setActiveSlot] = useState('neck')
  const copy = getCopy(language)
  const catalog = useMemo(
    () => getPetOutfitCatalog(petType, language),
    [language, petType],
  )
  const outfit = relationship?.outfit
  const unlocked = new Set(outfit?.unlocked_outfit_ids || [])
  const equipped = outfit?.equipped_outfits || {}

  useEffect(() => {
    setActiveSlot('neck')
  }, [petType])

  if (petType !== 'pig') {
    return null
  }

  const items = catalog.filter((item) => item.slot === activeSlot)
  const equippedItemId = equipped[activeSlot] || ''

  return (
    <section className="outfit-panel" aria-label={copy.title}>
      <div className="outfit-panel-header">
        <div className="sidebar-title">{copy.title}</div>
        <button
          type="button"
          className="outfit-clear-button"
          title={copy.clear}
          aria-label={copy.clear}
          disabled={saving || !equippedItemId}
          onClick={() => onChange(activeSlot, null)}
        >
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="outfit-slot-tabs" role="tablist" aria-label={copy.title}>
        {SELECTABLE_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            className={`outfit-slot-tab ${activeSlot === slot ? 'active' : ''}`}
            data-slot={slot}
            role="tab"
            aria-selected={activeSlot === slot}
            onClick={() => setActiveSlot(slot)}
          >
            {getPetOutfitSlotLabel(slot, language)}
          </button>
        ))}
      </div>

      <div className="outfit-options">
        {items.map((item) => {
          const isUnlocked = unlocked.has(item.id)
          const isEquipped = equippedItemId === item.id
          const status = isEquipped
            ? copy.equipped
            : isUnlocked
              ? copy.available
              : copy.unlockLevel(item.unlockLevel)

          return (
            <button
              key={item.id}
              type="button"
              className={`outfit-option ${isEquipped ? 'active' : ''}`}
              data-item-id={item.id}
              aria-pressed={isEquipped}
              disabled={saving || !isUnlocked || isEquipped}
              onClick={() => onChange(item.slot, item.id)}
            >
              <OutfitSprite
                petType={petType}
                itemId={item.id}
                className="outfit-option-preview"
              />
              <span className="outfit-option-copy">
                <span className="outfit-option-name">{item.label}</span>
                <span className="outfit-option-status">{status}</span>
              </span>
              <span className="outfit-option-state" aria-hidden="true">
                {isEquipped ? <Check size={16} /> : !isUnlocked ? <Lock size={15} /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
