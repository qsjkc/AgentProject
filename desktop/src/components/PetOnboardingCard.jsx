import { getRelationshipStageLabel } from '../shared/pet-relationship'
import { PET_ONBOARDING_SCENES } from '../shared/pet-onboarding-main'

function getSceneCopy(language, scene, relationship) {
  const isChinese = language === 'zh-CN'
  if (scene === PET_ONBOARDING_SCENES.RELATIONSHIP) {
    const level = relationship?.level ?? 1
    const stage = getRelationshipStageLabel(language, relationship?.relationship_stage)
    const progress = relationship?.progress || { current: 0, required: 0 }
    const progressText = progress.required > 0
      ? `${progress.current} / ${progress.required}`
      : isChinese ? '已满级' : 'Max level'
    return {
      title: isChinese ? '亲密度在这里' : 'Your bond lives here',
      body: isChinese
        ? `现在是 Lv.${level} · ${stage} · ${progressText}。就算忙几天，它也不会倒退。`
        : `You are at Lv.${level} · ${stage} · ${progressText}. A few busy days will never set it back.`,
    }
  }

  if (scene === PET_ONBOARDING_SCENES.REMINDER_OFFER) {
    return {
      title: isChinese ? '想让我帮一次忙吗？' : 'Want me to help with one small thing?',
      body: isChinese
        ? '这是可选的。试一个一分钟后的喝水提醒，看看我会怎么把事情交还给你。'
        : 'This is optional. Try a drink-water reminder one minute from now and see how I hand it back to you.',
      primary: isChinese ? '试一个 1 分钟后的喝水提醒' : 'Try a 1-minute water reminder',
      secondary: isChinese ? '以后再说' : 'Maybe later',
      tertiary: isChinese ? '不再提示' : 'Do not show again',
    }
  }

  if (scene === PET_ONBOARDING_SCENES.REMINDER_WAITING) {
    return {
      title: isChinese ? '我记住了' : 'I remembered',
      body: isChinese
        ? '一分钟后我会来提醒。到时喝完水点一下完成，我就知道这件事收尾了。'
        : 'I will remind you in one minute. When you are done, mark it complete so I know it is wrapped up.',
    }
  }

  return null
}

export function PetOnboardingCard({
  language,
  scene,
  relationship,
  sectionRef,
  busy = false,
  error = '',
  onCreateSampleReminder,
  onSnooze,
  onDismiss,
}) {
  const copy = getSceneCopy(language, scene, relationship)
  if (!copy) {
    return null
  }

  const titleId = `pet-onboarding-${scene}-title`
  return (
    <section
      className={`pet-onboarding-card is-${scene}`}
      ref={sectionRef}
      role="region"
      aria-labelledby={titleId}
      aria-busy={busy}
      aria-live="polite"
    >
      <div className="pet-onboarding-eyebrow">
        {language === 'zh-CN' ? '和小猪相处' : 'Living with Pig'}
      </div>
      <h2 className="pet-onboarding-title" id={titleId}>{copy.title}</h2>
      <p className="pet-onboarding-body">{copy.body}</p>

      {scene === PET_ONBOARDING_SCENES.REMINDER_OFFER && (
        <div className="pet-onboarding-actions">
          <button
            type="button"
            className="pet-onboarding-primary"
            data-e2e="p1k-create-reminder"
            disabled={busy}
            onClick={onCreateSampleReminder}
          >
            {copy.primary}
          </button>
          <button
            type="button"
            className="pet-onboarding-secondary"
            disabled={busy}
            onClick={onSnooze}
          >
            {copy.secondary}
          </button>
          <button
            type="button"
            className="pet-onboarding-tertiary"
            disabled={busy}
            onClick={onDismiss}
          >
            {copy.tertiary}
          </button>
        </div>
      )}

      {error && <div className="pet-onboarding-error" role="status">{error}</div>}
    </section>
  )
}
