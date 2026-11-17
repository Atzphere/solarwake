"""Read-only graph data derived from the same schedule model as the real alarm.

A chart has no effect on the scheduler or the light. Use UTC instants for
sampling so schedules remain well-defined across local clock transitions.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
import math
from zoneinfo import ZoneInfo

from .model import Settings, day_schedule, in_utc, phase_and_brightness, schedule_to_dict


def chart_for_day(settings: Settings, day: date, *, sunrise_override=None,
                  use_override: bool = False) -> dict:
    schedule = day_schedule(settings, day, sunrise_override, use_override=use_override)
    phase_times = [schedule.ramp_start, schedule.wake, schedule.fade_start, schedule.fade_end]
    if schedule.sunrise is not None:
        phase_times.append(schedule.sunrise)

    # The real sunrise can precede the ramp (summer), or follow the hold cap
    # (winter at extreme latitudes). Keep it visible without assuming that it
    # coincides with the lighting schedule.
    earliest, latest = min(map(in_utc, phase_times)), max(map(in_utc, phase_times))
    start = earliest - timedelta(minutes=15)
    end = latest + timedelta(minutes=15)
    duration = (end - start).total_seconds()

    # Bound payload size. Include all phase boundaries exactly even if they
    # don't fall on the sampling grid; this preserves instantaneous off edges.
    intervals = min(400, max(90, math.ceil(duration / 60)))
    instants = {start, end}
    for i in range(intervals + 1):
        instants.add(start + timedelta(seconds=duration * i / intervals))
    for when in (schedule.ramp_start, schedule.wake, schedule.fade_start, schedule.fade_end):
        instant = in_utc(when)
        instants.add(instant)
        # For the hard cutoffs, include just-before points so the graph
        # doesn't imply a slow fade where the real code abruptly changes.
        if instant > start:
            instants.add(instant - timedelta(milliseconds=1))

    tz = ZoneInfo(settings.timezone)
    points = []
    for instant in sorted(instants):
        phase, pct = phase_and_brightness(settings, schedule, instant)
        points.append({"at": instant.astimezone(tz).isoformat(),
                       "brightness_pct": pct if pct is not None else 0,
                       "phase": phase})

    return {
        "day": day.isoformat(),
        "scheduled_weekday": day.weekday() in settings.weekdays,
        "alarm_enabled": settings.enabled,
        "timezone": settings.timezone,
        "schedule": schedule_to_dict(schedule),
        "start": start.astimezone(tz).isoformat(),
        "end": end.astimezone(tz).isoformat(),
        "now": datetime.now(tz).isoformat(),
        "points": points,
    }
