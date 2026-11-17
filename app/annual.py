"""Read-only annual projections and explicit seasonal editing-basis conversion."""
from __future__ import annotations

from datetime import date, datetime, timedelta, time

from .model import Settings, local_sunrise, target_time, SeasonalPoint
from zoneinfo import ZoneInfo


def annual_profile(settings: Settings, year: int) -> dict:
    if not 2000 <= year <= 2100:
        raise ValueError("Choose a year between 2000 and 2100")
    day = date(year, 1, 1)
    points = []
    while day.year == year:
        solar = local_sunrise(settings, day)
        target, status, advance = target_time(settings, day, solar)
        points.append({
            "day": day.isoformat(),
            "sunrise": solar.isoformat() if solar else None,
            "target": target.isoformat(),
            "advance_minutes": advance,
            "target_status": status,
        })
        day += timedelta(days=1)
    return {"year": year, "timezone": settings.timezone, "schedule_mode": settings.schedule_mode,
            "seasonal_basis": settings.seasonal_basis, "points": points}


def converted_points(settings: Settings, basis: str, year: int) -> list[SeasonalPoint]:
    """Convert anchor values on a reference year; intermediate days may shift.

    Conversion is explicit (not performed implicitly by a visualization toggle)
    because time- and advancement-priority interpolations aren't identical.
    """
    if basis not in ("advance", "time"):
        raise ValueError("Unsupported seasonal editing basis")
    if not 2000 <= year <= 2100:
        raise ValueError("Choose a year between 2000 and 2100")
    if basis == settings.seasonal_basis:
        return settings.seasonal_points
    result = []
    tz = ZoneInfo(settings.timezone)
    for point in settings.seasonal_points:
        month, day_no = map(int, point.month_day.split("-"))
        day = date(year, month, day_no)
        rise = local_sunrise(settings, day)
        if rise is None:
            raise ValueError(f"No astronomical sunrise on {point.month_day} at this location; cannot convert its anchor")
        if basis == "time":
            at = (rise - timedelta(minutes=point.value)).astimezone(tz)
            if at.date() != day:
                raise ValueError(f"{point.month_day} would cross midnight; cannot convert it to a same-day clock time")
            value = at.hour * 60 + at.minute
        else:
            at = datetime.combine(day, time(point.value // 60, point.value % 60), tzinfo=tz)
            value = round((rise - at).total_seconds() / 60)
            if not -720 <= value <= 720:
                raise ValueError(f"{point.month_day} would exceed the ±720-minute advancement limit")
        result.append(SeasonalPoint(month_day=point.month_day, value=value))
    return result
