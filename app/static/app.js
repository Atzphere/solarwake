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
  // The backend returns local time with the correct UTC offset; browser
  // timezone databases can lag B.C.'s permanent UTC-7 change.
  const d = new Date(`${iso.slice(0,10)}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat(undefined,{weekday:"short",timeZone:"UTC"}).format(d);
  const hh = Number(iso.slice(11,13));
  const minute = iso.slice(14,16);
  return `${weekday} ${hh%12||12}:${minute} ${hh<12?"AM":"PM"}`;
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
    await loadChart();
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

async function updatePreview() {
  try {
    const p = await request("/api/preview");
    const pct = p.total_seconds ? Math.round(100*p.elapsed_seconds/p.total_seconds) : 0;
    $("preview-progress").setAttribute("aria-valuenow", pct);
    $("preview-fill").style.width = `${pct}%`;
    $("preview-status").textContent = `${p.phase} · ${Math.round(p.brightness_pct)}% brightness · ${Math.round(p.elapsed_seconds)} / ${Math.round(p.total_seconds)} simulated seconds`;
    $("preview-error").hidden = !p.error;
    $("preview-error").textContent = p.error || "";
    $("preview-start").disabled = p.active;
    $("preview-stop").disabled = !p.active;
    $("preview-speed").disabled = p.active;
    $("preview-live").disabled = p.active;
    $("test-on").disabled = p.active || currentSettings?.enabled;
    $("test-off").disabled = p.active || currentSettings?.enabled;
  } catch(e) { $("preview-error").hidden = false; $("preview-error").textContent = e.message; }
}
$("preview-start").addEventListener("click", async () => {
  const live = $("preview-live").checked;
  const speed = Number($("preview-speed").value);
  if (live && !confirm(`Drive the real light at ${speed}×? High speeds may cause abrupt or unexpected changes. The daily alarm must be disabled.`)) return;
  try {
    await request("/api/preview/start", {method:"POST",body:JSON.stringify({speed,live})});
    inform(live ? "Live test started; original light state will be restored when stopped." : "Simulation preview started.");
    await updatePreview();
  } catch(e) { inform(e.message,true); }
});
$("preview-stop").addEventListener("click", async () => {
  try { await request("/api/preview/stop", {method:"POST"}); await updatePreview(); inform("Preview stopped; restoration attempted."); }
  catch(e) { inform(e.message,true); }
});
updatePreview();
setInterval(updatePreview, 1000);

// Read-only schedule visualization. All plotted values come from the actual
// Python scheduler model; no duplicated gamma/phase calculations in the browser.
const SVG_NS = "http://www.w3.org/2000/svg";
let chartToday = null;
let chartSelected = null;

function svgNode(parent, name, attrs = {}, text = null) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== null) el.textContent = String(text);
  parent.appendChild(el);
  return el;
}
function chartClock(iso) {
  // The server has the authoritative zoneinfo (especially important for
  // B.C.'s post-2026 UTC-7 rules). Preserve its local clock, do not reformat
  // via browser tzdata, which might be out of date.
  return iso ? iso.slice(11,16) : "—";
}
function isoDayPlus(day, delta) {
  const dt = new Date(`${day}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0,10);
}
function renderDailyChart(data) {
  const svg = $("daily-chart");
  svg.replaceChildren();
  const W = 840, H = 310, L = 56, R = 22, T = 34, B = 51;
  const PW = W - L - R, PH = H - T - B;
  const y = value => T + PH * (1 - value / 100);
  const start = Date.parse(data.start), end = Date.parse(data.end);
  const span = Math.max(1, end - start);
  const x = iso => L + (Date.parse(iso) - start) / span * PW;
  const txt = {"font-size":13,"font-family":"system-ui, sans-serif",fill:"#5b6570"};

  // Background phase bands make ramp/hold/fade durations obvious at a glance.
  const boundaries = data.schedule;
  for (const [from, to, fill] of [
    [boundaries.ramp_start,boundaries.wake,"#f4f5f7"],
    [boundaries.wake,boundaries.fade_start,"#fcf7ed"],
    [boundaries.fade_start,boundaries.fade_end,"#f3f6f7"]
  ]) {
    const left = Math.max(L,x(from)), right = Math.min(L+PW,x(to));
    if (right > left) svgNode(svg,"rect",{x:left,y:T,width:right-left,height:PH,fill});
  }

  for (const value of [0,25,50,75,100]) {
    const yy = y(value);
    svgNode(svg,"line",{x1:L,y1:yy,x2:L+PW,y2:yy,stroke:"#dfe4e8","stroke-width":1});
    svgNode(svg,"text",{x:L-11,y:yy+4,"text-anchor":"end",...txt},`${value}%`);
  }
  const axisTicks = 6;
  for (let i=0; i<=axisTicks; i++) {
    const tickMs = start + span * i / axisTicks;
    const xx = L + PW * i / axisTicks;
    svgNode(svg,"line",{x1:xx,y1:T,x2:xx,y2:T+PH,stroke:"#e8ebed","stroke-width":1});
    // Use the nearest server-supplied ISO timestamp for reliable local time.
    const nearest = data.points.reduce((a,b) =>
      Math.abs(Date.parse(a.at)-tickMs) <= Math.abs(Date.parse(b.at)-tickMs) ? a : b);
    svgNode(svg,"text",{x:xx,y:H-B+24,"text-anchor":i===0?"start":i===axisTicks?"end":"middle",...txt},chartClock(nearest.at));
  }

  const coords = data.points.map(p => [x(p.at),y(p.brightness_pct)]);
  const path = coords.map(([xx,yy],i)=>`${i ? "L" : "M"}${xx.toFixed(2)},${yy.toFixed(2)}`).join(" ");
  const fillPath = `${path} L${coords.at(-1)[0]},${y(0)} L${coords[0][0]},${y(0)} Z`;
  svgNode(svg,"path",{d:fillPath,fill:"#b4864b","fill-opacity":"0.13"});
  svgNode(svg,"path",{d:path,stroke:"#a7793d","stroke-width":3,fill:"none","stroke-linejoin":"round"});

  // Astronomical sunrise is independent of the programmed sunrise.
  if (boundaries.sunrise) {
    const xx = x(boundaries.sunrise);
    svgNode(svg,"line",{x1:xx,y1:T,x2:xx,y2:T+PH,stroke:"#5087a3","stroke-width":2,"stroke-dasharray":"6 5"});
    svgNode(svg,"text",{x:Math.max(L+43,Math.min(L+PW-43,xx)),y:17,"text-anchor":"middle",...txt,fill:"#366b87"},"Sunrise");
  }
  // Wake time line is a separate reference; avoid a second label if close
  // to the astronomical marker.
  const wx = x(boundaries.wake);
  svgNode(svg,"line",{x1:wx,y1:T,x2:wx,y2:T+PH,stroke:"#5b6570","stroke-width":1.4,"stroke-dasharray":"3 4"});
  if (!boundaries.sunrise || Math.abs(x(boundaries.sunrise)-wx) > 98) {
    svgNode(svg,"text",{x:Math.max(L+28,Math.min(L+PW-28,wx)),y:17,"text-anchor":"middle",...txt},"Wake");
  }
  // Mark "now" only for today's chart, to avoid misleading markers on
  // historical/future dates. Its position uses the server's actual instant.
  if (chartToday === data.day) {
    const now = Date.parse(data.now);
    if (now >= start && now <= end) {
      const nx = L + PW * (now-start)/span;
      svgNode(svg,"line",{x1:nx,y1:T,x2:nx,y2:T+PH,stroke:"#657681","stroke-width":2,"stroke-dasharray":"2 5"});
    }
  }

  const readout = $("chart-readout");
  const base = `${data.day} · Ramp ${chartClock(boundaries.ramp_start)}–${chartClock(boundaries.wake)} · Fade ${chartClock(boundaries.fade_start)}–${chartClock(boundaries.fade_end)}`;
  readout.textContent = base;
  const cursor = svgNode(svg,"line",{x1:0,y1:T,x2:0,y2:T+PH,stroke:"#7f8991","stroke-width":1,visibility:"hidden"});
  const dot = svgNode(svg,"circle",{cx:0,cy:0,r:5,fill:"#a7793d",stroke:"white","stroke-width":1.5,visibility:"hidden"});
  const hitbox = svgNode(svg,"rect",{x:L,y:T,width:PW,height:PH,fill:"transparent",style:"cursor:crosshair"});
  hitbox.addEventListener("pointermove",event => {
    const bounds = svg.getBoundingClientRect();
    const px = (event.clientX - bounds.left) * W / bounds.width;
    const fraction = Math.max(0,Math.min(1,(px-L)/PW));
    const at = start + fraction*span;
    const nearest = data.points.reduce((a,b) => Math.abs(Date.parse(a.at)-at) <= Math.abs(Date.parse(b.at)-at) ? a : b);
    const xx=x(nearest.at);
    cursor.setAttribute("x1",xx);cursor.setAttribute("x2",xx);cursor.setAttribute("visibility","visible");
    dot.setAttribute("cx",xx);dot.setAttribute("cy",y(nearest.brightness_pct));dot.setAttribute("visibility","visible");
    readout.textContent = `${chartClock(nearest.at)} · ${nearest.brightness_pct}% brightness · ${nearest.phase}`;
  });
  hitbox.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility","hidden");
    dot.setAttribute("visibility","hidden");
    readout.textContent = base;
  });

  let note = "Graph shows the saved requested brightness, not measured lux. The E80S may use roughly 20 discrete brightness levels.";
  if (!data.scheduled_weekday) note = "This weekday is not selected for the alarm. The curve shows the schedule if it were enabled. " + note;
  else if (!data.alarm_enabled) note = "The alarm is disabled. This is a planning preview only. " + note;
  if (!boundaries.sunrise) note += " Astronomical sunrise is unavailable; maximum hold cap is used.";
  $("chart-note").textContent = note;
  svg.setAttribute("aria-label",`Brightness curve for ${data.day}; wake ${chartClock(boundaries.wake)}, real sunrise ${chartClock(boundaries.sunrise)}, fade begins ${chartClock(boundaries.fade_start)}.`);
}
async function loadChart() {
  const day = $("chart-day").value;
  if (!day) return;
  try {
    const result = await request(`/api/chart?day=${encodeURIComponent(day)}`);
    // Ignore a stale response if someone changes the selected date quickly.
    if ($("chart-day").value !== result.day) return;
    renderDailyChart(result);
    $("chart-error").hidden = true;
    chartSelected = result.day;
  } catch(e) {
    $("chart-error").hidden = false;
    $("chart-error").textContent = `Unable to load chart: ${e.message}`;
  }
}
async function setChartToday() {
  try {
    const status = await request("/api/status");
    chartToday = status.now.slice(0,10);
    $("chart-day").value = chartToday;
    await loadChart();
  } catch(e) { $("chart-error").hidden=false; $("chart-error").textContent=e.message; }
}
$("chart-prev").addEventListener("click",()=>{
  $("chart-day").value = isoDayPlus($("chart-day").value,-1);
  loadChart();
});
$("chart-next").addEventListener("click",()=>{
  $("chart-day").value = isoDayPlus($("chart-day").value,1);
  loadChart();
});
$("chart-day").addEventListener("change",loadChart);
$("chart-today").addEventListener("click",setChartToday);
setChartToday();
setInterval(() => { if (chartSelected) loadChart(); },60_000);
