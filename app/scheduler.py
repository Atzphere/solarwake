"""Single-process, restart-resumable scheduler with a solar handoff policy."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging
from zoneinfo import ZoneInfo

from .model import Settings, day_schedule, phase_and_brightness, schedule_to_dict, in_utc
from .storage import Store
from .device import HomeAssistantLight

LOG = logging.getLogger(__name__)
ACTIVE = {"ramping", "holding", "fading"}


class Scheduler:
    def __init__(self, store: Store, device: HomeAssistantLight):
        self.store = store
        self.device = device
        self.lock = asyncio.Lock()
        self.last_error: str | None = None
        self.last_success: str | None = None
        # On restart, always reconcile the active device state once.
        self.needs_reconcile = True

    def _select(self, now: datetime):
        settings = self.store.settings
        local = now.astimezone(ZoneInfo(settings.timezone))
        for day in (local.date() - timedelta(days=1), local.date(),
                    local.date() + timedelta(days=1)):
            if day.weekday() not in settings.weekdays:
                continue
            sched = day_schedule(settings, day)
            phase, pct = phase_and_brightness(settings, sched, now)
            if phase in ACTIVE:
                return sched, phase, pct
        return None, "idle", None

    def _next(self, now: datetime):
        settings = self.store.settings
        local = now.astimezone(ZoneInfo(settings.timezone))
        for i in range(9):
            day = local.date() + timedelta(days=i)
            if day.weekday() not in settings.weekdays:
                continue
            sched = day_schedule(settings, day)
            if in_utc(sched.ramp_start) > in_utc(now):
                return sched
        return None

    async def _off_owned(self) -> None:
        runtime = self.store.runtime
        if runtime.get("last_phase") not in ACTIVE:
            return
        await self.device.turn_off(self.store.settings.entity_id)
        runtime["last_phase"] = "finished"
        runtime["last_pct"] = None
        runtime["last_sent_at"] = datetime.now(timezone.utc).isoformat()
        self.store.save_runtime()
        self.last_error = None
        self.last_success = runtime["last_sent_at"]

    async def tick(self) -> None:
        async with self.lock:
            now = datetime.now(timezone.utc)
            settings = self.store.settings
            runtime = self.store.runtime
            try:
                if not settings.enabled:
                    await self._off_owned()
                    return
                sched, phase, pct = self._select(now)
                if sched is None or sched.day.isoformat() == runtime.get("skipped_run"):
                    # An active run may have just ended, including during downtime.
                    await self._off_owned()
                    return
                run_id = sched.day.isoformat()
                prior_run = runtime.get("last_run")
                prior_phase = runtime.get("last_phase")
                if prior_run != run_id and prior_phase in ACTIVE:
                    await self._off_owned()
                previous_pct = runtime.get("last_pct") if prior_run == run_id else None
                sent_at = runtime.get("last_sent_at")
                resend = self.needs_reconcile or not sent_at
                if sent_at and not resend:
                    try:
                        resend = ((now - datetime.fromisoformat(sent_at)).total_seconds() >= 90)
                    except (TypeError, ValueError):
                        resend = True
                if previous_pct != pct or resend:
                    await self.device.set_brightness(settings.entity_id, int(pct))
                    runtime.update(last_run=run_id, last_phase=phase, last_pct=pct,
                                   last_sent_at=now.isoformat())
                    self.store.save_runtime()
                    self.last_success = now.isoformat()
                self.needs_reconcile = False
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                LOG.warning("Scheduler tick failed: %s", exc)

    async def loop(self):
        while True:
            await self.tick()
            await asyncio.sleep(self.store.settings.update_seconds)

    async def apply_settings(self, settings: Settings) -> None:
        async with self.lock:
            prior = self.store.settings
            if not settings.enabled:
                # Saving "disabled" must succeed even if Home Assistant is
                # temporarily unreachable. The next tick will retry turning
                # off a previously controlled light.
                self.store.save_settings(settings)
                self.needs_reconcile = True
                try:
                    await self._off_owned()
                except Exception as exc:
                    self.last_error = str(exc)
                    LOG.warning("Disabled lighting schedule, but could not turn light off: %s", exc)
                return
            if settings.entity_id != prior.entity_id and self.store.runtime.get("last_phase") in ACTIVE:
                # Avoid orphaning an active lamp on an old entity ID.
                await self.device.turn_off(prior.entity_id)
                self.store.runtime.update(last_phase="finished", last_pct=None)
                self.store.save_runtime()
            self.store.save_settings(settings)
            self.needs_reconcile = True
            self.last_error = None

    async def skip_current_run(self) -> dict:
        async with self.lock:
            now = datetime.now(timezone.utc)
            sched, phase, _ = self._select(now)
            date = (sched.day if sched else
                    now.astimezone(ZoneInfo(self.store.settings.timezone)).date())
            self.store.runtime["skipped_run"] = date.isoformat()
            self.store.save_runtime()
            # Explicit skip turns the light off regardless of previous state.
            await self.device.turn_off(self.store.settings.entity_id)
            self.store.runtime.update(last_run=date.isoformat(), last_phase="finished",
                                      last_pct=None, last_sent_at=now.isoformat())
            self.store.save_runtime()
            self.last_error = None
            return {"skipped_run": date.isoformat()}

    async def manual_test(self, pct: int | None):
        async with self.lock:
            if self.store.settings.enabled:
                raise ValueError("Disable the lighting schedule before using manual light tests")
            if pct is None:
                await self.device.turn_off(self.store.settings.entity_id)
            else:
                await self.device.set_brightness(self.store.settings.entity_id, pct)

    def status(self) -> dict:
        settings = self.store.settings
        now = datetime.now(timezone.utc)
        current, phase, pct = self._select(now)
        if not settings.enabled:
            phase, pct = "disabled", None
        elif current and current.day.isoformat() == self.store.runtime.get("skipped_run"):
            phase, pct = "skipped", None
        next_schedule = self._next(now)
        return {
            "now": now.astimezone(ZoneInfo(settings.timezone)).isoformat(),
            "phase": phase,
            "target_brightness_pct": pct,
            "current_run": schedule_to_dict(current) if current else None,
            "next_run": schedule_to_dict(next_schedule) if next_schedule else None,
            "skipped_run": self.store.runtime.get("skipped_run"),
            "last_error": self.last_error,
            "last_success": self.last_success,
        }
