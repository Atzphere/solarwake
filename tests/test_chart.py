"""A schedule graph must not drift from actual alarm calculations."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.chart import chart_for_day
from app.model import Settings, day_schedule, phase_and_brightness

TZ = ZoneInfo("America/Vancouver")
DAY = date(2027, 1, 15)


def sample(sunrise, **kwargs):
    settings = Settings(wake_time="07:00", ramp_minutes=30, fade_minutes=15,
                        sunrise_offset_minutes=20, maximum_hold_minutes=180, **kwargs)
    chart = chart_for_day(settings, DAY, sunrise_override=sunrise, use_override=True)
    return settings, chart


def test_graph_exactly_matches_model():
    sunrise = datetime(2027, 1, 15, 8, 30, tzinfo=TZ)
    settings, chart = sample(sunrise)
    sched = day_schedule(settings, DAY, sunrise_override=sunrise, use_override=True)
    assert chart["schedule"]["sunrise"] == sunrise.isoformat()
    assert len(chart["points"]) <= 420
    for p in chart["points"]:
        assert (p["phase"], p["brightness_pct"] if p["phase"] in ("ramping", "holding", "fading") else None) == phase_and_brightness(
            settings, sched, datetime.fromisoformat(p["at"]))
    assert any(p["phase"] == "holding" and p["brightness_pct"] == 100 for p in chart["points"])
    assert chart["points"][0]["brightness_pct"] == 0
    assert chart["points"][-1]["brightness_pct"] == 0


def test_summer_early_sunrise_is_visible():
    sunrise = datetime(2027, 1, 15, 5, 15, tzinfo=TZ)
    settings, chart = sample(sunrise)
    assert datetime.fromisoformat(chart["start"]) < sunrise
    assert chart["schedule"]["fade_start"] == chart["schedule"]["wake"]
    assert chart["points"][-1]["brightness_pct"] == 0


def test_polar_no_sunrise_cap_and_zero_fade():
    settings = Settings(wake_time="07:00", maximum_hold_minutes=60, fade_minutes=0)
    chart = chart_for_day(settings, DAY, sunrise_override=None, use_override=True)
    assert chart["schedule"]["sunrise"] is None
    assert chart["schedule"]["sunrise_status"] == "unavailable"
    assert chart["schedule"]["fade_end"] == chart["schedule"]["fade_start"]
    at_end = [p for p in chart["points"] if p["at"] == chart["schedule"]["fade_end"]]
    assert at_end and at_end[0]["brightness_pct"] == 0


def test_disabled_and_unselected_day_still_plottable():
    settings = Settings(enabled=False, weekdays=[0])
    chart = chart_for_day(settings, DAY, sunrise_override=None, use_override=True)
    assert not chart["scheduled_weekday"]
    assert not chart["alarm_enabled"]
    assert chart["points"]


def test_different_clock_offsets_do_not_scramble_order():
    # Forced date spanning a time-zone clock change; the plotting axis is UTC.
    day = date(2027, 11, 7)
    settings = Settings(wake_time="07:00", ramp_minutes=180)
    sunrise = datetime(2027, 11, 7, 7, 40, tzinfo=TZ)
    chart = chart_for_day(settings, day, sunrise_override=sunrise, use_override=True)
    times = [datetime.fromisoformat(p["at"]).timestamp() for p in chart["points"]]
    assert times == sorted(times)
