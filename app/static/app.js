"use strict";
let currentSettings = null;
const $ = id => document.getElementById(id);
const fields = ["entity_id", "latitude", "longitude", "timezone", "wake_time", "ramp_minutes", "sunrise_offset_minutes", "fade_minutes", "maximum_hold_minutes", "gamma", "minimum_brightness_pct", "update_seconds"];
const numbers = new Set(["latitude", "longitude", "ramp_minutes", "sunrise_offset_minutes", "fade_minutes", "maximum_hold_minutes", "gamma", "minimum_brightness_pct", "update_seconds"]);
let noticeTimer;

async function request(url, options = {}) {
  const response = await fetch(url, {headers: {"Content-Type": "application/json"}, ...options});
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const detail = data.detail;
    const msg = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map(x => x.msg).join("; ") : response.statusText;
    throw new Error(msg || `HTTP ${response.status}`);
  }
  return data;
}
function inform(text, isError = false) {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").style.background = isError ? "#8d3d34" : "#303942";
  $("notice").hidden = false;
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 6000);
}
function fill(settings) {
  currentSettings = settings;
  for (const f of fields) $(f).value = settings[f];
  $("enabled").checked = settings.enabled;
  document.querySelectorAll("input[name=weekday]").forEach(el => { el.checked = settings.weekdays.includes(Number(el.value)); });
  $("test-on").disabled = settings.enabled;
  $("test-off").disabled = settings.enabled;
}
function collect() {
  const settings = {...currentSettings};
  for (const f of fields) settings[f] = numbers.has(f) ? Number($(f).value) : $(f).value;
  settings.enabled = $("enabled").checked;
  settings.weekdays = [...document.querySelectorAll("input[name=weekday]:checked")].map(el => Number(el.value));
  return settings;
}
function formatDate(iso) {
  if (!iso) return "Not available";
  const options = {timeZone: currentSettings.timezone, weekday: "short", hour: "numeric", minute: "2-digit", hour12: true};
  return new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
}
function updateSchedule(data) {
  const status = data.phase.replaceAll("_", " ");
  $("phase-badge").textContent = status[0].toUpperCase() + status.slice(1);
  const sched = data.current_run || data.next_run;
  if (sched) {
    $("s-ramp").textContent = formatDate(sched.ramp_start);
    $("s-wake").textContent = formatDate(sched.wake);
    $("s-sunrise").textContent = sched.sunrise ? formatDate(sched.sunrise) : "Unavailable (using hold cap)";
    $("s-fade").textContent = formatDate(sched.fade_start);
    $("s-end").textContent = formatDate(sched.fade_end);
  }
  let note = data.phase === "disabled" ? "Alarm disabled. Enable and save to activate the schedule." :
    data.phase === "skipped" ? "Today's alarm was stopped. Tomorrow's schedule is unaffected." :
    data.target_brightness_pct === null ? "Waiting for the next scheduled ramp." :
    `Currently ${data.phase}; target ${data.target_brightness_pct}% brightness.`;
  $("runtime-note").textContent = note;
  $("error-note").hidden = !data.last_error;
  $("error-note").textContent = data.last_error || "";
}
async function refresh() {
  try { updateSchedule(await request("/api/status")); }
  catch (e) { inform(`Status error: ${e.message}`, true); }
}
async function load() {
  try { fill(await request("/api/settings")); await refresh(); }
  catch (e) { inform(`Unable to load settings: ${e.message}`, true); }
}
$("settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const settings = collect();
    if (!settings.weekdays.length) throw new Error("Select at least one weekday");
    const updated = await request("/api/settings", {method:"PUT", body:JSON.stringify(settings)});
    fill(updated);
    await refresh();
    inform("Settings saved.");
  } catch (e) { inform(e.message, true); }
});
$("refresh").addEventListener("click", refresh);
$("skip").addEventListener("click", async () => {
  if (!confirm("Stop the current sunrise, turn the light off, and skip this run?")) return;
  try { await request("/api/skip", {method:"POST"}); await refresh(); inform("Alarm stopped for this run."); }
  catch (e) { inform(e.message, true); }
});
$("check-device").addEventListener("click", async () => {
  try {
    const d = await request("/api/device");
    $("device-status").textContent = `${d.entity_id}: ${d.state}; HA brightness: ${d.brightness ?? "not reported"}`;
    inform("Home Assistant connection works.");
  } catch (e) { $("device-status").textContent = e.message; inform(e.message, true); }
});
$("test-on").addEventListener("click", async () => {
  try { await request("/api/test-brightness", {method:"POST", body:JSON.stringify({pct:10})}); inform("Sent 10% brightness."); }
  catch (e) { inform(e.message, true); }
});
$("test-off").addEventListener("click", async () => {
  try { await request("/api/test-off", {method:"POST"}); inform("Sent light off command."); }
  catch (e) { inform(e.message, true); }
});
load();
setInterval(refresh, 5000);
