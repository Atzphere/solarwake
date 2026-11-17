"""Read-only effective-sunrise data and card/preview UI regression checks."""
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import app.annual as annual
from app.model import Settings

TZ = ZoneInfo("America/Vancouver")
HTML = Path(__file__).resolve().parents[1] / "app" / "static" / "index.html"


def test_effective_is_earlier_when_artificial_sunrise_precedes_real(monkeypatch):
    monkeypatch.setattr(annual, "local_sunrise", lambda settings, day: datetime(day.year, day.month, day.day, 8, 30, tzinfo=TZ))
    result = annual.annual_profile(Settings(schedule_mode="fixed", wake_time="07:00"), 2027)
    first = result["points"][0]
    assert first["target"][11:16] == "07:00"
    assert first["sunrise"][11:16] == "08:30"
    assert first["effective"][11:16] == "07:00"
    assert first["effective_advance_minutes"] == 90


def test_effective_is_real_when_artificial_sunrise_is_later(monkeypatch):
    monkeypatch.setattr(annual, "local_sunrise", lambda settings, day: datetime(day.year, day.month, day.day, 8, 30, tzinfo=TZ))
    result = annual.annual_profile(Settings(schedule_mode="fixed", wake_time="09:00"), 2027)
    first = result["points"][0]
    assert first["target"][11:16] == "09:00"
    assert first["effective"][11:16] == "08:30"
    assert first["advance_minutes"] == -30
    assert first["effective_advance_minutes"] == 0


def test_effective_falls_back_to_artificial_when_no_sunrise(monkeypatch):
    monkeypatch.setattr(annual, "local_sunrise", lambda settings, day: None)
    result = annual.annual_profile(Settings(schedule_mode="natural", wake_time="07:45"), 2027)
    first = result["points"][0]
    assert first["sunrise"] is None
    assert first["effective"] == first["target"]
    assert first["effective_advance_minutes"] is None


def test_main_cards_are_in_intended_order_and_preview_has_controls():
    html = HTML.read_text()
    card_ids = ["chart-title", "upcoming-title", "schedule-title", "annual-title", "preview-title"]
    positions = [html.index(f'aria-labelledby="{card}"') for card in card_ids]
    assert positions == sorted(positions)
    assert html.count('id="device-title"') == 1
    assert 'id="preview-dock"' in html
    assert 'id="preview-dock-stop"' in html
    assert 'id="annual-effective-legend"' in html


def test_effective_sunrise_uses_previous_calendar_day_when_needed(monkeypatch):
    monkeypatch.setattr(annual, "local_sunrise", lambda settings, day: datetime(day.year, day.month, day.day, 6, 0, tzinfo=TZ))
    result = annual.annual_profile(Settings(schedule_mode="natural", natural_advance_minutes=600), 2027)
    first = result["points"][0]
    assert first["target"].startswith("2026-12-31T20:00")
    assert first["effective"] == first["target"]
    assert first["effective_advance_minutes"] == 600
