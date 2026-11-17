# Solarwake v0.4 — Scheduling modes

This **incremental update** replaces the Python app and static UI only. It does
not include or overwrite your `compose.yaml`, `.env`, Docker volume, or Caddy
configuration. It includes all files needed whether you currently have the
accelerated-preview update (v0.2) or the daily-chart update (v0.3).

## What's new

- **Natural**: finish artificial sunrise at real sunrise minus a signed, fixed
  number of minutes. This enhances dawn without picking an alarm time.
- **Fixed**: finish artificial sunrise at a specified wake-up/clock time.
- **Seasonal**: finish artificial sunrise according to a repeating annual
  sequence of editable date control points. Control either the target sunrise
  clock time or the advancement relative to astronomical sunrise.
- **Annual visualization**: view the real and artificial sunrise times or the
  signed deviation, with unsaved changes shown immediately. Editing-basis
  conversion preserves *anchor targets* in the selected reference year, but
  interpolation between them can differ.
- **Daily chart playhead**: tracks the accelerated preview along a virtual
  ramp/hold/fade timeline. No change to the actual scheduled times.
- UI terminology distinguishes daylight normalization from fixed-time wake-up
  lighting. There is **no audio alarm** in Solarwake.

**Compatibility:** Existing saved installations without `schedule_mode` remain
in fixed-time mode (they do *not* silently change their wake times). Fresh
installations use natural mode. The data volume is left intact.

## Deploy to brandywine

Copy the ZIP to `/tmp/` (from PowerShell use `scp`). On brandywine:

```sh
cd /opt/compose/services/solarwake
git status --short
# Continue only if the working tree is clean. Commit or stash existing edits.
git switch -c feature/scheduling-modes
unzip -o /tmp/solarwake-scheduling-modes-v0.4.zip
python3 -m pytest -q       # optional if pytest is installed on brandywine
# Keep your existing compose.yaml and Caddy configuration unchanged.
docker compose up -d --build
docker compose logs --tail=60
```

Reload `https://solarwake.azhao.arpa` and inspect the selected mode, daily
chart, and annual graph. The annual graph can be examined without enabling the
lighting schedule. Avoid deploying during an active morning light cycle; for
safety, temporarily disable the schedule beforehand if appropriate.

**Keep an external alarm as a backup** while testing. Switching a live
schedule's mode can immediately change a light if the new cycle is already in
progress.

If everything works:

```sh
git add app tests README.md UPGRADE-v0.4.md
git commit -m "Add natural, fixed, and seasonal daylight scheduling"
git push -u origin feature/scheduling-modes
```

## Rollback

To revert the files without deleting the persistent schedule database:

```sh
cd /opt/compose/services/solarwake
git switch <your-previous-working-branch>
docker compose up -d --build
```

**Data caveat:** Saving v0.4 settings writes the new fields to `settings.json`.
The prior app version may reject those newer fields. If you anticipate needing
rollback, back up the Docker volume's `settings.json` before saving v0.4
settings, or manually remove the new `schedule_mode`,
`natural_advance_minutes`, `seasonal_basis`, and `seasonal_points` keys when
rolling back. Do not run `docker compose down -v`.

The app is still single-light and local-only. Weather modulation, ambient light
sensors, sunrise-duration astronomy, graphical dragging of annual control
points, and automation triggers remain future work.
