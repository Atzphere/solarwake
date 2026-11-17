"""Light scheduling modes, periodic control points, and legacy migration.

All solar instants are deterministic: no external weather, cloud, or HA calls.
"""
from datetime import date, datetime, timedelta
import json
from zoneinfo import ZoneInfo

import pytest

from app.model import Settings, SeasonalPoint, day_schedule, target_time, phase_and_brightness
from app.seasonal import interpolate, day_number
from app.storage import Store
import app.annual as annual

TZ = ZoneInfo('America/Vancouver')


def sunrise(day, hh=8, mm=30):
    return datetime(day.year, day.month, day.day, hh, mm, tzinfo=TZ)


def test_natural_shift_and_independent_handoff():
    day = date(2027, 1, 15)
    s = Settings(schedule_mode='natural', natural_advance_minutes=60,
                 ramp_minutes=30, sunrise_offset_minutes=20, fade_minutes=15)
    out = day_schedule(s, day, sunrise(day), use_override=True)
    assert out.wake.hour == 7 and out.wake.minute == 30
    assert out.ramp_start.hour == 7 and out.ramp_start.minute == 0
    assert out.fade_start.hour == 8 and out.fade_start.minute == 50
    assert out.fade_end.hour == 9 and out.fade_end.minute == 5
    assert out.advance_minutes == 60
    assert phase_and_brightness(s, out, datetime(2027,1,15,8,0,tzinfo=TZ)) == ('holding',100)


def test_natural_delay_is_valid_but_no_artificial_hold_if_sunrise_has_passed():
    day = date(2027, 1, 15)
    s = Settings(schedule_mode='natural', natural_advance_minutes=-45,
                 sunrise_offset_minutes=0)
    out = day_schedule(s, day, sunrise(day), use_override=True)
    assert out.wake.hour == 9 and out.wake.minute == 15
    assert out.fade_start == out.wake
    assert out.advance_minutes == -45


def test_polar_fallback_uses_fixed_target_and_hold_cap():
    day = date(2027, 1, 15)
    s = Settings(schedule_mode='natural', wake_time='06:45', maximum_hold_minutes=90)
    out = day_schedule(s, day, None, use_override=True)
    assert out.target_status == 'fallback'
    assert out.wake.strftime('%H:%M') == '06:45'
    assert out.fade_start.strftime('%H:%M') == '08:15'


def test_fixed_mode_ignores_solar_time_for_full_brightness():
    day = date(2027, 1, 15)
    s = Settings(schedule_mode='fixed', wake_time='06:45')
    for h in (5,8,10):
        assert day_schedule(s, day, sunrise(day,h),use_override=True).wake.strftime('%H:%M') == '06:45'


def test_periodic_control_points_are_cyclic_and_non_overshooting():
    pts = [(day_number(date(2001,1,15)),90),
           (day_number(date(2001,6,15)),0),
           (day_number(date(2001,11,15)),90)]
    assert interpolate(pts, date(2027,1,15)) == 90
    assert interpolate(pts, date(2027,6,15)) == 0
    for month in range(1,13):
        for day in (1,15,28):
            assert 0 <= interpolate(pts,date(2027,month,day)) <= 90
    # Values remain continuous over the year boundary.
    assert abs(interpolate(pts,date(2027,12,31))-interpolate(pts,date(2028,1,1))) < 2


def test_seasonal_time_and_advance_basis_produce_distinct_targets():
    d = date(2027,1,15)
    points = [SeasonalPoint(month_day='01-15', value=60),SeasonalPoint(month_day='07-15',value=0)]
    s=Settings(schedule_mode='seasonal', seasonal_basis='advance',seasonal_points=points)
    target, status, advance = target_time(s,d,sunrise(d))
    assert target.strftime('%H:%M') == '07:30'
    assert (status,advance) == ('calculated',60)
    s=Settings(schedule_mode='seasonal', seasonal_basis='time',seasonal_points=[
      SeasonalPoint(month_day='01-15', value=7*60),SeasonalPoint(month_day='07-15',value=6*60)])
    target,status,advance = target_time(s,d,sunrise(d))
    assert target.strftime('%H:%M') == '07:00'
    assert advance == 90


def test_control_point_dates_validation():
    with pytest.raises(ValueError):
        SeasonalPoint(month_day='02-29',value=30)
    with pytest.raises(ValueError):
        Settings(schedule_mode='seasonal',seasonal_points=[
            SeasonalPoint(month_day='03-01',value=10),SeasonalPoint(month_day='03-01',value=20)])
    with pytest.raises(ValueError):
        Settings(schedule_mode='seasonal',seasonal_basis='time',seasonal_points=[
            SeasonalPoint(month_day='01-01',value=1440),SeasonalPoint(month_day='06-01',value=350)])


def test_converting_basis_uses_reference_year(monkeypatch):
    monkeypatch.setattr(annual,'local_sunrise', lambda settings, day: sunrise(day))
    settings=Settings(schedule_mode='seasonal',seasonal_basis='advance',seasonal_points=[
        SeasonalPoint(month_day='01-15',value=90),SeasonalPoint(month_day='06-15',value=30)])
    converted=annual.converted_points(settings,'time',2027)
    assert [p.value for p in converted]==[7*60,8*60]
    clock=settings.model_copy(update={'seasonal_basis':'time','seasonal_points':converted})
    reversed_points=annual.converted_points(clock,'advance',2027)
    assert [p.value for p in reversed_points]==[90,30]


def test_annual_preview_is_read_only(monkeypatch):
    monkeypatch.setattr(annual,'local_sunrise', lambda settings, day: sunrise(day))
    settings=Settings(schedule_mode='natural',natural_advance_minutes=60)
    original=settings.model_dump()
    data=annual.annual_profile(settings,2027)
    assert len(data['points']) == 365
    assert data['points'][0]['target'][11:19] == '07:30:00'  # Host tzdata may lag B.C.'s 2026 change
    assert all(p['advance_minutes']==60 for p in data['points'])
    assert settings.model_dump()==original


def test_new_install_defaults_to_natural_existing_settings_migrate_to_fixed(tmp_path):
    fresh=Store(str(tmp_path/'fresh'))
    assert fresh.settings.schedule_mode=='natural'
    legacy_dir=tmp_path/'legacy';legacy_dir.mkdir()
    # Old settings only contained fixed-time wake scheduling.
    legacy=Settings(wake_time='06:40',enabled=True).model_dump()
    legacy.pop('schedule_mode');legacy.pop('seasonal_points');legacy.pop('natural_advance_minutes');legacy.pop('seasonal_basis')
    (legacy_dir/'settings.json').write_text(json.dumps(legacy))
    upgraded=Store(str(legacy_dir))
    assert upgraded.settings.schedule_mode=='fixed'
    assert upgraded.settings.wake_time=='06:40'
    assert upgraded.settings.enabled
