"""Offline tests: no Home Assistant, network, or astronomy service required."""

import unittest
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.model import Settings, day_schedule, phase_and_brightness

TZ = ZoneInfo("America/Vancouver")


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings(wake_time="07:00", ramp_minutes=30,
                                 sunrise_offset_minutes=20, fade_minutes=15,
                                 maximum_hold_minutes=180, gamma=2.0)
        self.day = date(2026, 1, 15)

    def make(self, hour, minute):
        solar_rise = datetime(2026, 1, 15, hour, minute, tzinfo=TZ)
        return day_schedule(self.settings, self.day, solar_rise, use_override=True)

    def test_winter_hold(self):
        sched = self.make(8, 10)
        self.assertEqual(sched.ramp_start.strftime("%H:%M"), "06:30")
        self.assertEqual(sched.fade_start.strftime("%H:%M"), "08:30")
        self.assertEqual(sched.fade_end.strftime("%H:%M"), "08:45")
        phase, brightness = phase_and_brightness(self.settings, sched,
                                                datetime(2026, 1, 15, 8, 15, tzinfo=TZ))
        self.assertEqual((phase, brightness), ("holding", 100))

    def test_early_summer_sunrise_fades_at_wake(self):
        sched = self.make(5, 30)
        self.assertEqual(sched.fade_start.strftime("%H:%M"), "07:00")
        self.assertEqual(sched.fade_end.strftime("%H:%M"), "07:15")

    def test_max_hold_cap(self):
        sched = self.make(11, 30)
        self.assertEqual(sched.fade_start.strftime("%H:%M"), "10:00")

    def test_polar_fallback(self):
        sched = day_schedule(self.settings, self.day, None, use_override=True)
        self.assertEqual(sched.sunrise_status, "unavailable")
        self.assertEqual(sched.fade_start.strftime("%H:%M"), "10:00")

    def test_phases_and_brightness(self):
        sched = self.make(8, 10)
        now = datetime(2026, 1, 15, 6, 30, tzinfo=TZ)
        self.assertEqual(phase_and_brightness(self.settings, sched, now), ("ramping", 1))
        phase, brightness = phase_and_brightness(self.settings, sched, now + timedelta(minutes=15))
        self.assertEqual(phase, "ramping")
        self.assertTrue(20 <= brightness <= 30)  # gamma=2, halfway ~26%
        phase, brightness = phase_and_brightness(self.settings, sched,
                                                datetime(2026, 1, 15, 8, 37, tzinfo=TZ))
        self.assertEqual(phase, "fading")
        self.assertTrue(1 <= brightness <= 100)
        self.assertEqual(phase_and_brightness(self.settings, sched,
                         datetime(2026, 1, 15, 8, 46, tzinfo=TZ)), ("finished", None))

    def test_weekday_validation(self):
        with self.assertRaises(ValueError):
            Settings(weekdays=[])
        with self.assertRaises(ValueError):
            Settings(weekdays=[0, 0])


if __name__ == "__main__":
    unittest.main()
