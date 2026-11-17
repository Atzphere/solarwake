"""Separate, non-persistent sunrise test runner. Never changes the saved lighting schedule."""
from __future__ import annotations

import asyncio
import logging
import time

from .device import HomeAssistantLight
from .storage import Store

LOG = logging.getLogger(__name__)


class Preview:
    SPEEDS = {1, 5, 10, 30, 60}
    # Cap physical commands: high speeds skip intermediate points rather than flooding HA.
    INTERVAL_SECONDS = 2.0

    def __init__(self, store: Store, device: HomeAssistantLight):
        self.store, self.device = store, device
        self.task: asyncio.Task | None = None
        self.phase = "idle"
        self.live = False
        self.speed = 1
        self.elapsed = 0.0
        self.total = 0.0
        self.pct = 0
        self.error: str | None = None
        self._stop = asyncio.Event()
        self._restore: dict | None = None

    def active(self) -> bool:
        return self.task is not None and not self.task.done()

    def status(self) -> dict:
        return {"active": self.active(), "phase": self.phase, "live": self.live,
                "speed": self.speed, "elapsed_seconds": round(self.elapsed, 1),
                "total_seconds": self.total, "brightness_pct": self.pct,
                "error": self.error}

    async def start(self, speed: int, live: bool) -> dict:
        if speed not in self.SPEEDS:
            raise ValueError("Choose a supported preview speed")
        if self.active():
            raise ValueError("A preview is already running")
        if live and self.store.settings.enabled:
            raise ValueError("Disable and save the lighting schedule before driving the light")
        self._restore = None
        if live:
            state = await self.device.get_state(self.store.settings.entity_id)
            if state.get("state") not in ("on", "off"):
                raise ValueError("Cannot safely snapshot the current light state")
            self._restore = state
        self.speed, self.live = speed, live
        self.elapsed = 0
        self.pct = 0
        self.error = None
        self.total = float(60 * (self.store.settings.ramp_minutes + 2 + self.store.settings.fade_minutes))
        self.phase = "starting"
        self._stop = asyncio.Event()
        self.task = asyncio.create_task(self._run(), name="solarwake-preview")
        return self.status()

    async def stop(self) -> dict:
        if self.active():
            self._stop.set()
            await self.task
        return self.status()

    async def shutdown(self):
        await self.stop()

    def _target(self, seconds: float):
        settings = self.store.settings
        ramp = settings.ramp_minutes * 60
        hold_end = ramp + 120
        if seconds < ramp:
            self.phase = "ramping"
            frac = min(1, seconds / ramp)
            return round(settings.minimum_brightness_pct +
                         (100 - settings.minimum_brightness_pct) * frac ** settings.gamma)
        if seconds < hold_end:
            self.phase = "holding"
            return 100
        fade = settings.fade_minutes * 60
        if fade and seconds < hold_end + fade:
            self.phase = "fading"
            frac = (seconds - hold_end) / fade
            return max(settings.minimum_brightness_pct, round(100 * (1 - frac) ** settings.gamma))
        self.phase = "completed"
        return 0

    async def _restore_light(self):
        if not self.live or self._restore is None:
            return
        entity = self.store.settings.entity_id
        if self._restore["state"] == "off":
            await self.device.turn_off(entity)
        else:
            brightness = self._restore.get("attributes", {}).get("brightness")
            if isinstance(brightness, (int, float)):
                await self.device.set_brightness(entity, max(1, min(100, round(brightness / 255 * 100))))
            else:
                # Original on-state had no reported brightness; do not guess.
                raise ValueError("Original light was on but brightness was unavailable; restore manually")

    async def _run(self):
        started = time.monotonic()
        entity = self.store.settings.entity_id
        last_sent = None
        try:
            while not self._stop.is_set():
                self.elapsed = min(self.total, (time.monotonic() - started) * self.speed)
                self.pct = self._target(self.elapsed)
                if self.live and self.pct != last_sent:
                    if self.store.settings.enabled:
                        raise RuntimeError("Lighting schedule was enabled during live preview")
                    if self.pct:
                        await self.device.set_brightness(entity, self.pct)
                    else:
                        await self.device.turn_off(entity)
                    last_sent = self.pct
                if self.elapsed >= self.total:
                    break
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.INTERVAL_SECONDS)
                except asyncio.TimeoutError:
                    pass
            if self._stop.is_set():
                self.phase = "stopped"
        except Exception as exc:
            self.phase = "error"
            self.error = str(exc)
            LOG.warning("Preview failed: %s", exc)
        finally:
            try:
                await self._restore_light()
            except Exception as exc:
                self.error = f"Light restoration failed: {exc}"
                LOG.warning(self.error)
