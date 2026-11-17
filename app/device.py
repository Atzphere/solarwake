"""Home Assistant transport; future device implementations can share this interface."""

from __future__ import annotations

import os
import httpx


class DeviceError(RuntimeError):
    pass


class HomeAssistantLight:
    def __init__(self):
        self.url = os.environ.get("HA_URL", "").strip().rstrip("/")
        self.token = os.environ.get("HA_TOKEN", "").strip()
        self.client = httpx.AsyncClient(timeout=8.0)

    def _check(self) -> None:
        if not self.url or not self.token:
            raise DeviceError("Set HA_URL and HA_TOKEN in .env")
        if not self.url.startswith(("http://", "https://")):
            raise DeviceError("HA_URL must start with http:// or https://")

    async def _request(self, method: str, endpoint: str, json_data: dict | None = None) -> dict | list:
        self._check()
        try:
            response = await self.client.request(
                method,
                self.url + endpoint,
                headers={"Authorization": f"Bearer {self.token}"},
                json=json_data,
            )
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise DeviceError(f"Home Assistant request failed: {exc}") from exc

    async def get_state(self, entity_id: str) -> dict:
        result = await self._request("GET", f"/api/states/{entity_id}")
        return result if isinstance(result, dict) else {}

    async def set_brightness(self, entity_id: str, pct: int) -> None:
        await self._request("POST", "/api/services/light/turn_on",
                            {"entity_id": entity_id, "brightness_pct": pct})

    async def turn_off(self, entity_id: str) -> None:
        await self._request("POST", "/api/services/light/turn_off", {"entity_id": entity_id})

    async def close(self) -> None:
        await self.client.aclose()
