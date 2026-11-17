# Solarwake — minimal sunrise alarm

A small, Python-based sunrise light controller. It uses **Home Assistant** as the
light-control layer, **Astral** to calculate your actual local sunrise, and a
plain, server-hosted web UI. No Node/React build step. All times are calculated
server-side and schedules continue when the browser is closed.

## What it does

- Ramps `light.e80s_id` (or another dimmable Home Assistant light) from a
  configurable minimum to 100%, reaching maximum brightness at wake-up time.
- Holds it at full brightness until **local sunrise + an offset** (20 minutes by
  default), capped at a configurable maximum hold time.
- Fades out and sends `light.turn_off` once the fade completes.
- Repeats on selected weekdays; stores the schedule across restarts.
- Recalculates the appropriate lighting phase after restarting the app. If a
  previously started run finished during downtime, the app turns its light off.
- Has a stop/skip-this-run action and device connectivity/brightness tests.

The initial installation is **disabled by default**. The `49.2827, -123.1207`
coordinates are an **example in central Vancouver**, not your home location.
Change them in Advanced settings if needed. The app never needs your street
address.

## Deployment on brandywine (Docker VM)

1. Copy/unzip the project into e.g. `/opt/compose/services/solarwake`.
2. Inside that directory:

   ```sh
   cp .env.example .env
   nano .env
   chmod 600 .env
   ```

   Set:
   - `HA_URL` to the actual Home Assistant base URL reachable **from Docker**
     (no trailing `/config` or `/api`), for example `http://192.168.1.80`
     if that is how you currently access your HA instance. Some HA setups
     instead use `http://IP:8123`.
   - `HA_TOKEN` to a **long-lived access token** created in Home Assistant:
     click your user profile, then **Security → Long-Lived Access Tokens**.
   - `BIND_IP` to the address on brandywine that you want to listen on. The
     example is `192.168.1.71`. Never expose this unauthenticated MVP to the
     public Internet.

3. Start it:

   ```sh
   docker compose up -d --build
   docker compose logs -f --tail=80
   ```

4. Open `http://192.168.1.71:8765/` (replace with your chosen BIND_IP).
5. Verify E80S is **physically set to warm-white mode**, and not its hardware
   sunrise alarm mode. Click **Check connection**; with the alarm disabled,
   click **Test light at 10%**, then **Turn light off**.
6. Confirm the timezone, approximate location, wake time and selected days.
   Enable the alarm and **Save settings**.

For the first few mornings, keep a conventional alarm as a backup until this
has demonstrated reliable operation for your device and environment.

### Testing a ramp during the day

Disable the alarm and save, then set the wake time 3–5 minutes in the future,
set the ramp duration to 2 minutes, and re-enable the alarm. If the day's
sunrise was earlier, fade begins at the chosen wake time; this is expected.
After the test, restore your real schedule.

### Important operational notes

- This is a **single-process** scheduler. Leave Uvicorn at **one worker** and
  do not run multiple containers for the same schedule.
- `solarwake_data` is a persistent Docker volume containing `settings.json`
  and `runtime.json`; it survives normal container recreations.
- The app sends commands through HA's `/api/services/light/turn_on` and
  `light/turn_off` REST API, with `brightness_pct`, using the secret token on
  the server. The browser never receives the HA token.
- The scheduler typically updates every 5 seconds while ramping/fading; while
  holding it periodically reasserts the full brightness (about every 90 sec)
  if the device changes state unexpectedly. It uses a best-effort retry on
  connection errors, and reports the most recent failure in the UI.
- The **Stop / skip** button turns the light off and suppresses this scheduled
  run. Manual physical switching is **not automatically recognized as an
  override** in this MVP; use Stop/skip to pause the app for the morning.
- With the alarm enabled, the app may join the current scheduled ramp/hold
  immediately if the current time lies inside that window. Disable before
  running a manual light test.
- Calculated sunrise uses the standard unobstructed-horizon definition; it
  does not know about weather, window direction, or indoor illumination.
- For very high latitudes where there is no sunrise on a date, the app uses
  the maximum hold cap rather than waiting forever.
- Wake times around the 1–3 a.m. daylight-saving clock change are not fully
  disambiguated; normal morning times such as 6–8 a.m. are unaffected.
- The UI/API have **no authentication**. Restrict the port to your trusted LAN
  or Tailscale, and do not publish it through a public reverse proxy.

### Running with local Python instead of Docker

Python 3.11+ is recommended; with the sample `.env` loaded as environment
variables:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
mkdir -p data
export DATA_DIR="$PWD/data"
export HA_URL="http://YOUR_HA_HOST:8123"
export HA_TOKEN="YOUR_HA_TOKEN"
uvicorn app.main:app --host 127.0.0.1 --port 8765 --workers 1
```

Then visit `http://127.0.0.1:8765/`.

Unit tests:

```sh
python -m unittest discover -s tests -v
```

## Future extension points

- `app/model.py`: schedule + brightness model, independent of hardware.
- `app/scheduler.py`: state machine and solar handoff; future sensor policy.
- `app/device.py`: device transport; can be extended to multiple HA entities.
- Future per-light translation/calibration (1D LUT for brightness; CCT/RGB
  profiles) belongs between the schedule output and `HomeAssistantLight`.

The MVP only supports **one brightness-controlled light**. Multiple lights,
colour calibration, weather, ambience sensors and simulated seasons are not
implemented yet.

## Accelerated test runs (next iteration)

A dedicated **Accelerated test run** panel allows 1×, 5×, 10×, 30× or 60×
playback of the **saved** ramp, followed by a two-minute simulated hold and
then the saved fade. Preview does not modify the schedule or use actual sunrise.
It runs in simulation-only mode unless **Drive the actual E80S light** is
explicitly checked and confirmed. Live mode requires saving the alarm disabled.
Home Assistant commands are limited to one attempt every two seconds. Higher
speeds can skip steps or make the light jump abruptly.

Live preview snapshots the light's power and brightness before starting and
**attempts** to restore those values on stop or completion. A network or server
failure can prevent restoration, so the result is not guaranteed. Keep the
physical light controls available and avoid testing during a real alarm.
Preview progress is volatile and is not resumed after process restarts.

Future work: three scheduling modes (natural, fixed and seasonal compensation),
a yearly control-point curve with an annual impact graph, and phase-trigger
interpolation. These are deliberately not part of this test-run update.

## Daily light-profile chart (v0.3)

The **Daily light profile** panel visualizes a selected calendar day, including
its actual astronomical sunrise, planned ramp, hold, and fade. Choose a day with
the calendar picker or use the previous/next day buttons. It remains available
when the alarm is disabled and on unselected weekdays as a *planning preview*;
viewing a date never changes your settings or controls the light.

The `/api/chart?day=YYYY-MM-DD` endpoint samples the **same** Python
`phase_and_brightness` implementation as the live scheduler, including minimum
brightness, gamma, maximum-hold cap, and the final turn-off. It has no side
effects and adds no dependencies. The plot depicts commanded brightness, not
measured lux; although the E80S appears to have ~20 physical brightness steps,
there is no device-calibrated quantization model yet. The real sunrise marker
is independent of the artificial wake-up and might occur before or after it.

All graph timestamps are returned with their local UTC offset and the UI shows
those clock values directly, to avoid stale browser timezone databases under
B.C.'s 2026 permanent UTC−7 rules. The endpoint uses the currently *saved*
settings; unsaved edits will not appear until **Save settings**.

## Planned scheduling and daylight enhancements (not implemented)

- **Seasonal sunrise targets:** an annual editor with two interchangeable
  presentations of the *same* schedule: an absolute artificial-sunrise-time
  curve, and an advance/delay-in-minutes curve relative to real sunrise.
  Editing either should update the other and show the real astronomical times.
- **Weather-modulated handoff:** initially retain the real-sunrise anchor, but
  optionally extend the hold or slow the fade using available cloudiness or
  (preferably) forecast solar irradiance. Forecast cloud fraction alone is not
  a reliable room-brightness measurement. Handle missing/stale forecast data
  with a deterministic astronomy-only fallback; avoid abrupt brightness jumps.
- **Sensor-driven handoff:** later supplement the forecast with a local
  illuminance sensor and hysteresis, while maintaining a maximum hold limit.
- **Phase events:** emit single-shot triggers at configurable elapsed-time or
  brightness percentages through each sunrise phase, with restart-safe IDs.

These capabilities should remain opt-in and must not block the alarm if any
external weather API or light sensor becomes unavailable.
