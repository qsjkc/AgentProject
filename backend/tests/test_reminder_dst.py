from datetime import date, datetime

import pytest

from app.schemas.reminder import ReminderCreate
from app.services.reminder_recurrence import (
    as_local,
    as_utc_naive,
    build_local_occurrence,
    calculate_next_occurrence,
    normalize_first_occurrence,
)


FOLDS = [
    ("America/New_York", "2026-11-01T01:30:00-05:00", "2026-11-01T01:45:00-04:00", "2026-11-01T06:30:00", "2026-11-02T06:30:00", "2026-11-08T06:30:00"),
    ("Europe/Berlin", "2026-10-25T02:30:00+01:00", "2026-10-25T02:45:00+02:00", "2026-10-25T01:30:00", "2026-10-26T01:30:00", "2026-11-01T01:30:00"),
    ("Australia/Lord_Howe", "2026-04-05T01:45:00+10:30", "2026-04-05T01:50:00+11:00", "2026-04-04T15:15:00", "2026-04-05T15:15:00", "2026-04-11T15:15:00"),
]


@pytest.mark.parametrize("zone,requested,now,expected,next_daily,next_weekly", FOLDS)
@pytest.mark.parametrize("recurrence", ["daily", "weekly"])
@pytest.mark.parametrize("through_schema", [False, True])
def test_explicit_future_second_fold_is_first_and_never_repeated_same_day(
    zone, requested, now, expected, next_daily, next_weekly, recurrence, through_schema,
):
    remind_at = datetime.fromisoformat(requested)
    if through_schema:
        # FastAPI validation stores UTC without tzinfo; its absolute instant
        # must retain enough information to recover the explicitly chosen fold.
        remind_at = ReminderCreate(
            pet_type="pig", title="clock fold", remind_at=remind_at,
            recurrence_type=recurrence, recurrence_timezone=zone,
        ).remind_at
    first, hour, minute, weekdays = normalize_first_occurrence(
        remind_at, recurrence_type=recurrence, timezone_name=zone, now=datetime.fromisoformat(now),
    )
    assert first == datetime.fromisoformat(expected)
    assert as_local(first, zone).fold == 1
    following = calculate_next_occurrence(
        first, local_hour=hour, local_minute=minute, timezone_name=zone, weekdays=weekdays,
    )
    assert following == datetime.fromisoformat(next_daily if recurrence == "daily" else next_weekly)
    assert as_local(following, zone).date() > as_local(first, zone).date()


@pytest.mark.parametrize("recurrence,expected_next", [
    ("daily", "2026-11-02T06:30:00"), ("weekly", "2026-11-08T06:30:00"),
])
def test_first_fold_selection_does_not_create_second_occurrence_that_day(recurrence, expected_next):
    first, hour, minute, weekdays = normalize_first_occurrence(
        datetime.fromisoformat("2026-11-01T01:30:00-04:00"),
        recurrence_type=recurrence, timezone_name="America/New_York",
        now=datetime.fromisoformat("2026-11-01T00:30:00-04:00"),
    )
    assert first == datetime(2026, 11, 1, 5, 30)
    assert as_local(first, "America/New_York").fold == 0
    following = calculate_next_occurrence(
        first, local_hour=hour, local_minute=minute, timezone_name="America/New_York", weekdays=weekdays,
    )
    assert following == datetime.fromisoformat(expected_next)


@pytest.mark.parametrize("recurrence,expected", [
    ("daily", "2026-11-02T06:30:00"), ("weekly", "2026-11-08T06:30:00"),
])
def test_elapsed_second_fold_still_advances_to_the_next_scheduled_day(recurrence, expected):
    first, _, _, _ = normalize_first_occurrence(
        datetime.fromisoformat("2026-11-01T01:30:00-05:00"),
        recurrence_type=recurrence, timezone_name="America/New_York",
        now=datetime.fromisoformat("2026-11-01T01:45:00-05:00"),
    )
    assert first == datetime.fromisoformat(expected)


def test_weekday_rule_does_not_accept_a_future_sunday_fold():
    first, hour, minute, weekdays = normalize_first_occurrence(
        datetime.fromisoformat("2026-11-01T01:30:00-05:00"),
        recurrence_type="weekdays", timezone_name="America/New_York",
        now=datetime.fromisoformat("2026-11-01T01:45:00-04:00"),
    )
    assert first == datetime(2026, 11, 2, 6, 30)
    assert (hour, minute, weekdays) == (1, 30, [0, 1, 2, 3, 4])


@pytest.mark.parametrize("zone,day,hour,minute,expected,next_expected", [
    ("America/New_York", date(2026, 3, 8), 2, 30, "2026-03-08T07:30:00", "2026-03-09T06:30:00"),
    ("Europe/Berlin", date(2026, 3, 29), 2, 30, "2026-03-29T01:30:00", "2026-03-30T00:30:00"),
    ("Australia/Lord_Howe", date(2026, 10, 4), 2, 15, "2026-10-03T15:45:00", "2026-10-04T15:15:00"),
])
def test_missing_local_time_keeps_forward_shift_for_only_that_occurrence(zone, day, hour, minute, expected, next_expected):
    first = as_utc_naive(build_local_occurrence(day, local_hour=hour, local_minute=minute, timezone_name=zone))
    assert first == datetime.fromisoformat(expected)
    following = calculate_next_occurrence(
        first, local_hour=hour, local_minute=minute, timezone_name=zone, weekdays=list(range(7)),
    )
    assert following == datetime.fromisoformat(next_expected)


@pytest.mark.parametrize("recurrence,expected", [
    ("daily", "2026-03-08T01:15:00"),
    ("weekly", "2026-03-08T01:15:00"),
    ("weekdays", "2026-03-09T01:15:00"),
])
def test_non_dst_zone_keeps_local_schedule_and_weekday_filter(recurrence, expected):
    first, hour, minute, _ = normalize_first_occurrence(
        datetime.fromisoformat("2026-03-08T09:15:00+08:00"),
        recurrence_type=recurrence, timezone_name="Asia/Shanghai",
        now=datetime.fromisoformat("2026-03-08T08:00:00+08:00"),
    )
    assert first == datetime.fromisoformat(expected)
    assert (hour, minute) == (9, 15)
