"""Validated schedule settings and calculations (independent of any light)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

UTC = timezone.utc


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    entity_id: str = Field(default="light.e80s_id", pattern=r"^light\.[a-z0-9_]+$")
    # Vancouver city-centre *example*, not an inferred home address.
    latitude: float = Field(default=49.2827, ge=-89.9, le=89.9)
    longitude: float = Field(default=-123.1207, ge=-180, le=180)
    timezone: str = "America/Vancouver"
    wake_time: str = "07:00"
    weekdays: list[int] = Field(default_factory=lambda: list(range(7)))  # Monday=0
    ramp_minutes: int = Field(default=30, ge=1, le=180)
    sunrise_offset_minutes: int = Field(default=20, ge=-60, le=180)
    fade_minutes: int = Field(default=15, ge=0, le=120)
    maximum_hold_minutes: int = Field(default=180, ge=1, le=720)
    gamma: float = Field(default=2.0, ge=0.5, le=5.0)
    minimum_brightness_pct: int = Field(default=1, ge=1, le=30)
    update_seconds: int = Field(default=5, ge=2, le=60)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Enter an IANA timezone, such as America/Vancouver") from exc
        return value

    @field_validator("wake_time")
    @classmethod
    def valid_time(cls, value: str) -> str:
        try:
            parsed = time.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("Use HH:MM (24-hour time)") from exc
        if parsed.second or parsed.microsecond:
            raise ValueError("Wake time must be HH:MM")
        return parsed.strftime("%H:%M")

    @field_validator("weekdays")
    @classmethod
    def valid_weekdays(cls, value: list[int]) -> list[int]:
        if not value or any(type(day) is not int or day not in range(7) for day in value):
            raise ValueError("Select at least one valid weekday")
        if len(set(value)) != len(value):
            raise ValueError("Duplicate weekdays are not allowed")
        return sorted(value)


class DaySchedule(BaseModel):
    day: date
    ramp_start: datetime
    wake: datetime
    sunrise: datetime | None
    fade_start: datetime
    fade_end: datetime
    sunrise_status: Literal["calculated", "unavailable"]


def local_sunrise(settings: Settings, day: date) -> datetime | None:
    # Import within the function so schedule tests can inject a deterministic sunrise.
    from astral import Observer
    from astral.sun import sunrise

    tz = ZoneInfo(settings.timezone)
    try:
        return sunrise(
            Observer(latitude=settings.latitude, longitude=settings.longitude),
            date=day,
            tzinfo=tz,
        )
    except ValueError:
        # Polar day/night: fall back to the maximum-hold limit.
        return None


def day_schedule(settings: Settings, day: date, sunrise_override: datetime | None = None,
                 *, use_override: bool = False) -> DaySchedule:
    tz = ZoneInfo(settings.timezone)
    wake = datetime.combine(day, time.fromisoformat(settings.wake_time), tzinfo=tz)
    sunrise_time = sunrise_override if use_override else local_sunrise(settings, day)
    ramp_start = wake - timedelta(minutes=settings.ramp_minutes)
    hold_cap = wake + timedelta(minutes=settings.maximum_hold_minutes)
    target = (sunrise_time + timedelta(minutes=settings.sunrise_offset_minutes)
              if sunrise_time is not None else hold_cap)
    fade_start = min(max(wake, target), hold_cap)
    return DaySchedule(
        day=day,
        ramp_start=ramp_start,
        wake=wake,
        sunrise=sunrise_time,
        fade_start=fade_start,
        fade_end=fade_start + timedelta(minutes=settings.fade_minutes),
        sunrise_status="calculated" if sunrise_time is not None else "unavailable",
    )


def in_utc(dt: datetime) -> datetime:
    return dt.astimezone(UTC)


def phase_and_brightness(settings: Settings, sched: DaySchedule,
                         now: datetime) -> tuple[str, int | None]:
    """Never send a light command outside the active window."""
    now_u = in_utc(now)
    start, wake, fade, end = [in_utc(x) for x in
                               (sched.ramp_start, sched.wake, sched.fade_start, sched.fade_end)]
    if now_u < start:
        return "upcoming", None
    if now_u < wake:
        fraction = min(1.0, max(0.0, (now_u - start).total_seconds() /
                                max(1.0, (wake - start).total_seconds())))
        pct = round(settings.minimum_brightness_pct +
                    (100 - settings.minimum_brightness_pct) * fraction ** settings.gamma)
        return "ramping", max(settings.minimum_brightness_pct, min(100, pct))
    if now_u < fade:
        return "holding", 100
    if now_u < end:
        fraction = min(1.0, max(0.0, (now_u - fade).total_seconds() /
                                max(1.0, (end - fade).total_seconds())))
        pct = round(100 * (1.0 - fraction) ** settings.gamma)
        return "fading", max(settings.minimum_brightness_pct, min(100, pct))
    return "finished", None


def schedule_to_dict(schedule: DaySchedule) -> dict:
    return {
        "day": schedule.day.isoformat(),
        "ramp_start": schedule.ramp_start.isoformat(),
        "wake": schedule.wake.isoformat(),
        "sunrise": schedule.sunrise.isoformat() if schedule.sunrise else None,
        "fade_start": schedule.fade_start.isoformat(),
        "fade_end": schedule.fade_end.isoformat(),
        "sunrise_status": schedule.sunrise_status,
    }
