import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const storeUrl = new URL('../electron/pet-onboarding-store.cjs', import.meta.url).href

for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
  test(`onboarding API timestamps preserve UTC eligibility in ${timezone}`, () => {
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import onboarding from ${JSON.stringify(storeUrl)}
      const context = (createdAt) => ({
        has_session: true, user_id: 17, pet_type: 'pig',
        relationship: { id: 29, user_id: 17, pet_type: 'pig', level: 1, created_at: createdAt },
      })
      const normalize = (value) => onboarding.normalizePetOnboardingContext(context(value)).relationship_created_at
      for (const [value, expected] of [
        ['2026-09-27T12:00:00', '2026-09-27T12:00:00.000Z'],
        ['2026-09-27T12:00:00.123456', '2026-09-27T12:00:00.123Z'],
        ['2026-09-27T12:00:00.123Z', '2026-09-27T12:00:00.123Z'],
        ['2026-09-27T20:00:00+08:00', '2026-09-27T12:00:00.000Z'],
        ['2026-09-27T08:00:00-04:00', '2026-09-27T12:00:00.000Z'],
        ['2026-09-27T17:45:00+05:45', '2026-09-27T12:00:00.000Z'],
        ['2026-03-08T02:30:00', '2026-03-08T02:30:00.000Z'],
        ['2024-02-29T12:00:00', '2024-02-29T12:00:00.000Z'],
      ]) {
        assert.equal(normalize(value), expected, value)
      }

      const now = new Date('2026-09-27T12:00:00.000Z')
      for (const [ageMs, eligible] of [
        [-1, false], [0, true], [1, true], [18 * 3600000, true],
        [24 * 3600000, true], [24 * 3600000 + 1, false],
      ]) {
        const naiveUtc = new Date(now.getTime() - ageMs).toISOString().replace(/Z$/, '')
        assert.equal(onboarding.isPetOnboardingContextEligible(context(naiveUtc), now), eligible, 'age=' + ageMs)
        const read = onboarding.readPetOnboardingEntry({ states: {}, context: context(naiveUtc), now })
        assert.equal(read.reason, eligible ? 'created' : 'not-eligible', 'onboarding creation at age=' + ageMs)
      }
      for (const value of [
        '', 'not a date', '2026-09-27', '2026-02-29T12:00:00',
        '2026-02-30T12:00:00Z', '2026-02-30T12:00:00+08:00',
        '2026-13-01T12:00:00', '2026-09-27T24:00:00',
        '2026-09-27T12:60:00', '2026-09-27T12:00:60',
        '2026-09-27T12:00:00+25:00', null, undefined, true, {}, NaN,
      ]) {
        assert.equal(normalize(value), null, String(value))
        assert.equal(onboarding.isPetOnboardingContextEligible(context(value), now), false, String(value))
      }

      // Existing internal Date/epoch callers still denote absolute instants.
      assert.equal(normalize(now), now.toISOString())
      assert.equal(normalize(now.getTime()), now.toISOString())
      assert.equal(normalize(new Date(NaN)), null)

      // Only the API field gets the UTC default. Local clock inputs used by
      // the store keep their established parsing behavior.
      const localNow = '2026-09-27T12:00:00'
      const state = onboarding.createPetOnboardingState(context(now.toISOString()), localNow)
      assert.equal(state.created_at, new Date(localNow).toISOString())
    `], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  })
}
