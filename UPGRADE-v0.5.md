# Solarwake v0.5 — UI polish

Small incremental update from v0.4. It changes only the read-only annual
projection API and static frontend; **no settings, scheduler, device-control,
Docker, Caddy, Home Assistant, or dependency changes**.

## Changes

- Reorders the main cards: Daily light profile → Next sunrise → Lighting
  schedule → Annual sunrise schedule → Accelerated test run. Manual device
  checks are now in a disclosure inside Accelerated test run.
- Adds **effective sunrise**, the earlier instant of astronomical sunrise and
  the artificial full-brightness target, to the annual clock-time graph. In
  advancement view, plots the effective (nonnegative) advancement alongside
  the configured target deviation. Historical timezone offsets are preserved;
  previous-day targets appear as such on the time axis.
- An accelerated test now scrolls to the daily chart after it starts. A small
  bottom progress strip remains visible, including a Stop and restore button.
  The same server preview session and progress values drive both UI controls.
- Changes the daily graph's `Wake` marker to `Peak`, matching daylight
  normalization terminology.

No drag-to-edit functionality is included yet. The annual graph remains read-only;
seasonal control points are edited in the lighting schedule form.

## Install (from a clean v0.4 Git checkout)

Copy `solarwake-ui-polish-v0.5.zip` to `/tmp` on brandywine. Then:

```sh
cd /opt/compose/services/solarwake
git status --short
# Commit or stash any local edits before proceeding.
git switch -c feature/ui-polish-v0.5
unzip -o /tmp/solarwake-ui-polish-v0.5.zip
# Only frontend files, app/annual.py, and an isolated test are replaced.
docker compose up -d --build
docker compose logs --tail=50
```

Verify the effective sunrise line in both annual views, start a *simulation-only*
preview at 10× and confirm auto-scroll, floating progress, and floating Stop.
If you test a real device, retain the existing v0.4 safety warning and disable
saved scheduling beforehand.

Commit after verifying:

```sh
git add app/annual.py app/static/ tests/test_polish.py UPGRADE-v0.5.md
git commit -m "Polish daylight charts and accelerated preview controls"
git push -u origin HEAD
```

## Rollback

```sh
cd /opt/compose/services/solarwake
git switch feature/scheduling-modes   # Or whichever branch contains your tested v0.4
docker compose up -d --build
```

Unlike v0.4's scheduling migration, v0.5 does not change stored settings.
Do not use `docker compose down -v`.

## Verification

- Python: 29 tests passed, including new effective-time/polar and card-order checks
- JavaScript: syntax check passed
- Browser: desktop and mobile mocked API integration checks passed (chart
  curves, view toggle, auto-scroll, floating status and Stop), with no page errors
- Not yet verified against your live HA/E80S deployment
