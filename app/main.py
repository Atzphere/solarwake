"""Web API and intentionally minimal UI. Run exactly one Uvicorn worker."""

from __future__ import annotations

import asyncio
from datetime import date, datetime
from zoneinfo import ZoneInfo
from contextlib import asynccontextmanager
from pathlib import Path
import os

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .device import DeviceError, HomeAssistantLight
from .model import Settings
from .chart import chart_for_day
from .scheduler import Scheduler
from .preview import Preview
from .storage import Store

ROOT = Path(__file__).resolve().parent
store = Store(os.getenv("DATA_DIR", "/data"))
device = HomeAssistantLight()
scheduler = Scheduler(store, device)
preview = Preview(store, device)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(scheduler.loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await preview.shutdown()
        await device.close()


app = FastAPI(title="Solarwake", docs_url="/api/docs", redoc_url=None, lifespan=lifespan)


@app.get("/")
async def homepage():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/static/style.css")
async def css():
    return FileResponse(ROOT / "static" / "style.css", media_type="text/css")


@app.get("/static/app.js")
async def javascript():
    return FileResponse(ROOT / "static" / "app.js", media_type="application/javascript")


@app.get("/api/settings")
async def get_settings():
    return store.settings


@app.put("/api/settings")
async def put_settings(settings: Settings):
    if preview.active():
        raise HTTPException(status_code=409, detail="Stop the preview before changing alarm settings")
    try:
        await scheduler.apply_settings(settings)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return store.settings


@app.get("/api/status")
async def status():
    return scheduler.status()


@app.get("/api/chart")
async def chart(day: date | None = None):
    """Daily planned curve, including when the alarm is disabled. No side effects."""
    settings = store.settings
    if day is None:
        day = datetime.now(ZoneInfo(settings.timezone)).date()
    return chart_for_day(settings, day)


@app.get("/api/device")
async def device_status():
    try:
        state = await device.get_state(store.settings.entity_id)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"entity_id": store.settings.entity_id, "state": state.get("state"),
            "brightness": state.get("attributes", {}).get("brightness")}


@app.post("/api/skip")
async def skip():
    try:
        return await scheduler.skip_current_run()
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class TestBrightness(BaseModel):
    pct: int


@app.post("/api/test-brightness")
async def test_brightness(test: TestBrightness):
    if test.pct < 1 or test.pct > 100:
        raise HTTPException(status_code=422, detail="Brightness must be 1–100%")
    if preview.active():
        raise HTTPException(status_code=409, detail="Stop the preview first")
    try:
        await scheduler.manual_test(test.pct)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/test-off")
async def test_off():
    if preview.active():
        raise HTTPException(status_code=409, detail="Stop the preview first")
    try:
        await scheduler.manual_test(None)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True}


class PreviewStart(BaseModel):
    speed: int = 10
    live: bool = False


@app.get("/api/preview")
async def preview_status():
    return preview.status()


@app.post("/api/preview/start")
async def preview_start(options: PreviewStart):
    try:
        return await preview.start(options.speed, options.live)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/preview/stop")
async def preview_stop():
    return await preview.stop()
