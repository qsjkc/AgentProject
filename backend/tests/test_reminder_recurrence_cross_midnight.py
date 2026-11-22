from datetime import datetime

from app.models.database import ReminderSeries
from app.services.reminder_recurrence import calculate_next_occurrence, skip_paused_occurrences


ZONE = "America/Nuuk"
DAILY = list(range(7))
# The requested Saturday 23:30 is shifted to Sunday 00:30 by the spring gap.
SHIFTED_SATURDAY = datetime(2026, 3, 29, 1, 30)


def test_recurrence_keeps_sundays_clock_after_saturdays_gap_crosses_midnight():
    rule = dict(local_hour=23, local_minute=30, timezone_name=ZONE, weekdays=DAILY)
    friday = datetime(2026, 3, 28, 1, 30)
    assert calculate_next_occurrence(friday, **rule) == SHIFTED_SATURDAY
    assert calculate_next_occurrence(SHIFTED_SATURDAY, **rule) == datetime(2026, 3, 30, 0, 30)


def test_resume_counts_both_weekend_slots_when_the_saved_cursor_crossed_midnight():
    series = ReminderSeries(
        status="paused", recurrence_type="daily", timezone=ZONE,
        local_hour=23, local_minute=30, weekdays=DAILY,
        next_occurrence_at=SHIFTED_SATURDAY, next_sequence=2, skipped_occurrence_count=0,
    )
    skip_paused_occurrences(series, now=datetime(2026, 4, 6, 12))

    assert series.next_occurrence_at == datetime(2026, 4, 7, 0, 30)
    # The paused dates run from the shifted March 28 slot through April 5.
    assert series.skipped_occurrence_count == 9
    assert series.next_sequence == 11
