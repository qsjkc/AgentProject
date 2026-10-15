import assert from 'node:assert/strict'

export async function testApiTime(importModule) {
  const { parseApiDateTime, formatApiDateTime, formatApiDate } = await importModule('src/lib/apiTime.js')
  const originalTimezone = process.env.TZ
  const expectedInstant = new Date('2026-09-26T23:30:00.123Z')
  const equivalentValues = [
    '2026-09-26T23:30:00.123456',
    '2026-09-26 23:30:00.123456',
    '2026-09-26T23:30:00.123Z',
    '2026-09-26T23:30:00.123z',
    '2026-09-27T07:30:00.123456+08:00',
    '2026-09-27T07:30:00.123456+0800',
    '2026-09-26T19:30:00.123456-04:00',
  ]

  try {
    for (const timezone of ['Asia/Shanghai', 'America/New_York', 'UTC']) {
      process.env.TZ = timezone
      for (const value of equivalentValues) {
        const parsed = parseApiDateTime(value)
        assert.equal(parsed?.getTime(), expectedInstant.getTime(), `${timezone}: ${value}`)
        assert.equal(formatApiDateTime(value), expectedInstant.toLocaleString())
        assert.equal(formatApiDate(value), expectedInstant.toLocaleDateString())
      }
      assert.equal(parseApiDateTime(equivalentValues[0]).getDate(), timezone === 'Asia/Shanghai' ? 27 : 26, 'creation dates follow the local calendar day of the UTC instant')
      assert.equal(parseApiDateTime(' 2024-02-29T12:34:56.1Z ').toISOString(), '2024-02-29T12:34:56.100Z')
      assert.equal(parseApiDateTime('2026-09-26T23:30:00').toISOString(), '2026-09-26T23:30:00.000Z')

      for (const invalid of [
        undefined, null, '', '   ', 'not a date', 'Invalid Date',
        '2026-09-26', '2026-09-26_2026-09-27',
        '2026-02-29T12:00:00', '2026-02-30T12:00:00Z',
        '2026-04-31T12:00:00+08:00', '2026-13-01T12:00:00',
        '2026-09-26T24:00:00', '2026-09-26T23:60:00',
        '2026-09-26T23:30:60', '2026-09-26T23:30:00+24:00',
        '2026-09-26T23:30:00+08:60', '0000-01-01T00:00:00',
      ]) {
        assert.equal(parseApiDateTime(invalid), null, `${timezone}: reject ${invalid}`)
        assert.equal(formatApiDateTime(invalid), '-')
        assert.equal(formatApiDate(invalid), '-')
        assert.equal(formatApiDateTime(invalid, 'unavailable'), 'unavailable')
      }
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }

  console.log('frontend API datetime tests passed (Shanghai, New York, UTC, explicit offsets, invalid input)')
}
