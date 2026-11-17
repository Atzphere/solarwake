"use strict";
let currentSettings = null;
const $ = id => document.getElementById(id);
const fields = ["entity_id", "latitude", "longitude", "timezone", "wake_time", "ramp_minutes", "sunrise_offset_minutes", "fade_minutes", "maximum_hold_minutes", "gamma", "minimum_brightness_pct", "update_seconds"];
const numbers = new Set(["latitude", "longitude", "ramp_minutes", "sunrise_offset_minutes", "fade_minutes", "maximum_hold_minutes", "gamma", "minimum_brightness_pct", "update_seconds"]);
let seasonalDraftPoints = [];
let seasonalPointsBasis = "advance";
let currentPreview = null;
let chartLastData = null;
let annualData = null;
let annualFetchId = 0;
let annualDebounce = null;
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
  $("schedule_mode").value = settings.schedule_mode || "fixed";
  $("natural_advance_minutes").value = settings.natural_advance_minutes ?? 30;
  seasonalPointsBasis = settings.seasonal_basis || "advance";
  $("seasonal_basis").value = seasonalPointsBasis;
  seasonalDraftPoints = (settings.seasonal_points || []).map(p => ({...p}));
  renderSeasonalPoints();
  updateModeVisibility();
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
  settings.schedule_mode = $("schedule_mode").value;
  settings.natural_advance_minutes = Number($("natural_advance_minutes").value);
  settings.seasonal_basis = seasonalPointsBasis;
  settings.seasonal_points = readSeasonalPoints();
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
  let note = data.phase === "disabled" ? "Lighting schedule disabled. Enable and save to activate it." :
    data.phase === "skipped" ? "This light cycle was stopped. Subsequent cycles are unaffected." :
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
    if (settings.enabled && (currentSettings?.schedule_mode !== settings.schedule_mode ||
        currentSettings?.wake_time !== settings.wake_time) &&
        !confirm("Updating a live lighting schedule can start or alter this morning’s light cycle immediately. Continue?")) return;
    const updated = await request("/api/settings", {method:"PUT", body:JSON.stringify(settings)});
    fill(updated);
    await refresh();
    await loadChart();
    await loadAnnual();
    inform("Settings saved.");
  } catch (e) { inform(e.message, true); }
});
$("refresh").addEventListener("click", refresh);
$("skip").addEventListener("click", async () => {
  if (!confirm("Stop the current lighting cycle, turn the light off, and skip this run?")) return;
  try { await request("/api/skip", {method:"POST"}); await refresh(); inform("Light cycle stopped for this run."); }
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
    currentPreview = p;
    updateChartPlayhead();
  } catch(e) { $("preview-error").hidden = false; $("preview-error").textContent = e.message; }
}
$("preview-start").addEventListener("click", async () => {
  const live = $("preview-live").checked;
  const speed = Number($("preview-speed").value);
  if (live && !confirm(`Drive the real light at ${speed}×? High speeds may cause abrupt or unexpected changes. The lighting schedule must be disabled.`)) return;
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
  // Current time and accelerated-test time share the same dynamic marker.
  svgNode(svg,"line",{id:"chart-playhead",x1:L,y1:T,x2:L,y2:T+PH,stroke:"#657681","stroke-width":2,"stroke-dasharray":"2 5",visibility:"hidden"});
  svgNode(svg,"text",{id:"chart-playhead-label",x:L,y:T-8,"text-anchor":"middle",...txt,visibility:"hidden"},"Now");

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
  if (!data.scheduled_weekday) note = "This weekday is not selected for lighting. The curve shows the planned profile if enabled. " + note;
  else if (!data.schedule_enabled) note = "The lighting schedule is disabled. This is a planning preview only. " + note;
  if (!boundaries.sunrise) note += " Astronomical sunrise is unavailable; maximum hold cap is used.";
  $("chart-note").textContent = note;
  svg.setAttribute("aria-label",`Brightness curve for ${data.day}; wake ${chartClock(boundaries.wake)}, real sunrise ${chartClock(boundaries.sunrise)}, fade begins ${chartClock(boundaries.fade_start)}.`);
  chartLastData = data;
  updateChartPlayhead();
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

// Scheduling modes and annual curve editor. Anchor values are edited in a
// plain table; server-side Astral and PCHIP generate the plotted schedule.
function updateModeVisibility() {
  const mode = $("schedule_mode").value;
  $("natural-options").hidden = mode !== "natural";
  $("seasonal-options").hidden = mode !== "seasonal";
  $("wake-time-label").textContent = mode === "fixed" ? "Full-brightness time (fixed mode)" : "Fallback clock time (if no sunrise)";
  const help = {
    fixed: "Wake-up lighting: reach full brightness at your chosen clock time. This is a light-only schedule, not an audible alarm. Real sunrise still determines the fade-out handoff.",
    natural: "Daylight normalization: follow local astronomical sunrise, with a fixed advancement or delay. Positive minutes brighten the room earlier; real sunrise still governs the handoff.",
    seasonal: "Daylight normalization: define a recurring annual curve for target sunrise time or advancement. The actual sunrise remains the daylight handoff reference."
  };
  $("mode-help").textContent = help[mode];
}
function minutesClock(minutes) {
  const m = Math.round(minutes);
  return `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
}
function clockMinutes(value) {
  if (!/^\d\d:\d\d$/.test(value)) throw new Error("Enter control point times as HH:MM");
  const [h,m] = value.split(":").map(Number);
  if (h>23 || m>59) throw new Error("Control point clock time must be 00:00–23:59");
  return h*60+m;
}
function readSeasonalPoints() {
  const points=[];
  for (const row of document.querySelectorAll(".seasonal-point")) {
    const date = row.querySelector(".point-date").value.trim();
    const raw = row.querySelector(".point-value").value;
    if (!/^\d{2}-\d{2}$/.test(date)) throw new Error("Control point dates must be MM-DD");
    if (!raw) throw new Error(`Enter a value for ${date}`);
    const value = seasonalPointsBasis === "time" ? clockMinutes(raw) : Number(raw);
    if (!Number.isInteger(value)) throw new Error(`Enter a whole number at ${date}`);
    points.push({month_day:date,value});
  }
  return points;
}
function renderSeasonalPoints() {
  const list=$("seasonal-points");
  list.replaceChildren();
  seasonalDraftPoints.sort((a,b)=>a.month_day.localeCompare(b.month_day));
  seasonalDraftPoints.forEach((p,idx)=>{
    const row=document.createElement("div");
    row.className="seasonal-point";
    const dWrap=document.createElement("div");
    const dLabel=document.createElement("label"); dLabel.textContent="Date (MM-DD)";
    const d=document.createElement("input");
    d.className="point-date"; d.value=p.month_day; d.maxLength=5; d.placeholder="MM-DD"; d.required=true;
    dLabel.appendChild(d); dWrap.appendChild(dLabel);
    const vWrap=document.createElement("div");
    const vLabel=document.createElement("label");
    vLabel.textContent=seasonalPointsBasis==="advance"?"Advance (minutes)":"Full brightness at";
    const v=document.createElement("input"); v.className="point-value";
    if(seasonalPointsBasis==="time") {v.type="time";v.value=minutesClock(p.value);}
    else {v.type="number";v.step="1";v.min="-720";v.max="720";v.value=String(p.value);}
    v.required=true; vLabel.appendChild(v); vWrap.appendChild(vLabel);
    const rm=document.createElement("button");rm.type="button";rm.textContent="Remove";rm.className="quiet";
    rm.disabled=seasonalDraftPoints.length<=2;
    rm.addEventListener("click",()=>{
      try { seasonalDraftPoints=readSeasonalPoints(); } catch(e) { inform(e.message,true); return; }
      seasonalDraftPoints.splice(idx,1);renderSeasonalPoints();scheduleAnnual();
    });
    row.append(dWrap,vWrap,rm);list.appendChild(row);
    d.addEventListener("input",scheduleAnnual);
    v.addEventListener("input",scheduleAnnual);
  });
}
$("schedule_mode").addEventListener("change",()=>{updateModeVisibility();scheduleAnnual();});
$("seasonal-add").addEventListener("click",()=>{
  try {seasonalDraftPoints=readSeasonalPoints();} catch(e) {inform(e.message,true);return;}
  if(seasonalDraftPoints.length>=24) {inform("Maximum 24 control points",true);return;}
  let next="03-01";
  const used=new Set(seasonalDraftPoints.map(p=>p.month_day));
  for(let month=1;month<=12;month++) {
    const d=`${String(month).padStart(2,"0")}-15`;
    if(!used.has(d)) {next=d;break;}
  }
  seasonalDraftPoints.push({month_day:next,value:seasonalPointsBasis==="time"?420:30});
  renderSeasonalPoints();scheduleAnnual();
});
$("seasonal_basis").addEventListener("change",async()=>{
  const desired=$("seasonal_basis").value;
  if(desired===seasonalPointsBasis)return;
  $("seasonal_basis").disabled=true;
  try {
    const settings=collect();
    const response=await request("/api/seasonal/convert",{method:"POST",body:JSON.stringify({
      year:Number($("annual-year").value),basis:desired,settings
    })});
    seasonalPointsBasis=desired;
    seasonalDraftPoints=response.points;
    $("annual-view").value=desired;
    renderSeasonalPoints();
    inform(`Converted anchor values using ${response.year}; review annual curve before saving.`);
    await loadAnnual();
  } catch(e) {
    $("seasonal_basis").value=seasonalPointsBasis;
    inform(`Could not change editing basis: ${e.message}`,true);
  } finally {$("seasonal_basis").disabled=false;}
});

// Compare the *unsaved* settings with real astronomical sunrise over a year.
const ANNUAL_W=840, ANNUAL_H=310, ANNUAL_L=65, ANNUAL_R=24, ANNUAL_T=29, ANNUAL_B=44;
function renderAnnual(profile) {
  annualData=profile;
  const svg=$("annual-chart"); svg.replaceChildren();
  const view=$("annual-view").value;
  const values=profile.points;
  const timeMinute=iso=> iso ? Number(iso.slice(11,13))*60+Number(iso.slice(14,16)) : null;
  const series = values.map(p=>view==="time"?{a:timeMinute(p.sunrise),b:timeMinute(p.target)}:{a:null,b:p.advance_minutes});
  const all=series.flatMap(p=>[p.a,p.b]).filter(v=>v!==null && Number.isFinite(v));
  if(!all.length){$("annual-error").hidden=false;$("annual-error").textContent="No available astronomical sunrise values.";return;}
  let ymin=Math.min(...all), ymax=Math.max(...all);
  if(view==="advance") {ymin=Math.min(0,ymin);ymax=Math.max(0,ymax);}
  const step = view==="time"?60:30;
  ymin = Math.floor((ymin-(view==="time"?30:15))/step)*step;
  ymax = Math.ceil((ymax+(view==="time"?30:15))/step)*step;
  if(ymax<=ymin)ymax=ymin+step;
  const PW=ANNUAL_W-ANNUAL_L-ANNUAL_R, PH=ANNUAL_H-ANNUAL_T-ANNUAL_B;
  const x=i=>ANNUAL_L+PW*i/(values.length-1);
  const y=v=>ANNUAL_T+PH*(1-(v-ymin)/(ymax-ymin));
  const txt={"font-size":12,fill:"#5b6570","font-family":"system-ui,sans-serif"};
  for(let i=0;i<=5;i++) {
    const v=ymin+(ymax-ymin)*i/5, yy=y(v);
    svgNode(svg,"line",{x1:ANNUAL_L,x2:ANNUAL_L+PW,y1:yy,y2:yy,stroke:"#e4e8eb"});
    svgNode(svg,"text",{x:ANNUAL_L-10,y:yy+4,"text-anchor":"end",...txt},view==="time"?minutesClock(Math.max(0,Math.round(v))):`${Math.round(v)}m`);
  }
  if(view==="advance" && ymin<=0 && ymax>=0) {
    svgNode(svg,"line",{x1:ANNUAL_L,x2:ANNUAL_L+PW,y1:y(0),y2:y(0),stroke:"#7e8a90","stroke-dasharray":"4 4"});
  }
  for(const month of [1,3,5,7,9,11]) {
    const date=`${profile.year}-${String(month).padStart(2,"0")}-01`;
    const index=values.findIndex(p=>p.day===date);
    const xx=x(index);
    svgNode(svg,"line",{x1:xx,y1:ANNUAL_T,x2:xx,y2:ANNUAL_T+PH,stroke:"#edf0f2"});
    svgNode(svg,"text",{x:xx,y:ANNUAL_H-15,"text-anchor":"middle",...txt},new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined,{month:"short",timeZone:"UTC"}));
  }
  function line(which,color,dashed=false) {
    let path="",drawing=false;
    series.forEach((v,i)=>{
      const n=v[which];
      if(n==null){drawing=false;return;}
      path+=`${drawing?" L":" M"}${x(i).toFixed(2)},${y(n).toFixed(2)}`;
      drawing=true;
    });
    svgNode(svg,"path",{d:path,stroke:color,"stroke-width":2.5,fill:"none",...(dashed?{"stroke-dasharray":"6 5"}:{})});
  }
  if(view==="time")line("a","#5087a3",true);
  line("b","#a7793d");
  // Anchors are marked; edits are made in the table to avoid accidental schedule changes.
  if($("schedule_mode").value==="seasonal") {
    for(const anchor of readSeasonalPoints()){
      const idx=values.findIndex(p=>p.day.slice(5)===anchor.month_day);
      if(idx>=0 && series[idx].b!=null)svgNode(svg,"circle",{cx:x(idx),cy:y(series[idx].b),r:4,fill:"#a7793d",stroke:"white","stroke-width":1});
    }
  }
  const cursor=svgNode(svg,"line",{x1:0,x2:0,y1:ANNUAL_T,y2:ANNUAL_T+PH,stroke:"#777",visibility:"hidden","stroke-dasharray":"2 3"});
  const hit=svgNode(svg,"rect",{x:ANNUAL_L,y:ANNUAL_T,width:PW,height:PH,fill:"transparent",style:"cursor:crosshair"});
  const readout=$("annual-readout");
  readout.textContent=`${profile.year} · ${profile.schedule_mode} mode · ${view==="time"?"local clock time":"minutes earlier than real sunrise"} · adjust the control points above`;
  hit.addEventListener("pointermove",ev=>{
    const bounds=svg.getBoundingClientRect();
    const px=(ev.clientX-bounds.left)*ANNUAL_W/bounds.width;
    const idx=Math.max(0,Math.min(values.length-1,Math.round((px-ANNUAL_L)/PW*(values.length-1))));
    cursor.setAttribute("x1",x(idx));cursor.setAttribute("x2",x(idx));cursor.setAttribute("visibility","visible");
    const p=values[idx];
    readout.textContent=`${p.day} · Real ${p.sunrise?chartClock(p.sunrise):"none"} · Target ${chartClock(p.target)} · ${p.advance_minutes===null?"offset unavailable":(p.advance_minutes>=0?"+":"")+p.advance_minutes+" min earlier"}`;
  });
  hit.addEventListener("pointerleave",()=>{cursor.setAttribute("visibility","hidden");readout.textContent=`${profile.year} · ${profile.schedule_mode} mode`;});
  $("annual-real-legend").hidden=view!=="time";
  $("annual-target-legend").hidden=view!=="time";
  $("annual-advance-legend").hidden=view!=="advance";
  svg.setAttribute("aria-label",`Annual ${view==="time"?"sunrise times":"advance from real sunrise"} for ${profile.year}`);
}
async function loadAnnual() {
  if(!currentSettings)return;
  const id=++annualFetchId;
  try {
    const settings=collect();
    const year=Number($("annual-year").value);
    const result=await request("/api/year/preview",{method:"POST",body:JSON.stringify({year,settings})});
    if(id!==annualFetchId)return;
    renderAnnual(result);
    $("annual-error").hidden=true;
  } catch(e) {
    if(id!==annualFetchId)return;
    $("annual-error").hidden=false;
    $("annual-error").textContent=`Complete valid schedule settings to preview: ${e.message}`;
  }
}
function scheduleAnnual(){clearTimeout(annualDebounce);annualDebounce=setTimeout(loadAnnual,650);}
$("annual-year").value=String(new Date().getFullYear());
$("annual-view").addEventListener("change",()=>{if(annualData)renderAnnual(annualData);});
$("annual-year").addEventListener("change",loadAnnual);
$("settings-form").addEventListener("input",event=>{
  if(event.target.id==="seasonal_basis")return;
  scheduleAnnual();
});
// The initial settings GET runs near the start of this file; defer the first
// annual request until settings have been loaded into the form.
const startupAnnual=setInterval(()=>{if(currentSettings){clearInterval(startupAnnual);loadAnnual();}},250);

// The "now" line follows the accelerated preview while it is running. When a
// preview ends, it resumes showing actual time for the selected current day.
function updateChartPlayhead(){
  const data=chartLastData;
  const line=$("chart-playhead"), label=$("chart-playhead-label");
  if(!data||!line||!label)return;
  const start=Date.parse(data.start),end=Date.parse(data.end);
  const W=840,L=56,R=22;
  let t=null, text="Now";
  if(currentPreview?.active) {
    const p=currentPreview;
    const ramp=(currentSettings?.ramp_minutes||30)*60;
    const fade=(currentSettings?.fade_minutes||0)*60;
    const elapsed=Math.max(0,p.elapsed_seconds);
    let a,b,f;
    if(elapsed<ramp){a="ramp_start";b="wake";f=elapsed/ramp;}
    else if(elapsed<ramp+120){a="wake";b="fade_start";f=(elapsed-ramp)/120;}
    else {a="fade_start";b="fade_end";f=fade?Math.min(1,(elapsed-ramp-120)/fade):1;}
    t=Date.parse(data.schedule[a])+(Date.parse(data.schedule[b])-Date.parse(data.schedule[a]))*f;
    text="Test";
  } else if(chartToday===data.day){t=Date.now();}
  if(t!==null && t>=start && t<=end){
    const xx=L+(t-start)/(end-start)*(W-L-R);
    line.setAttribute("x1",xx);line.setAttribute("x2",xx);
    line.setAttribute("visibility","visible");
    label.setAttribute("x",Math.max(L+26,Math.min(W-R-26,xx)));
    label.textContent=text;label.setAttribute("visibility","visible");
  } else {line.setAttribute("visibility","hidden");label.setAttribute("visibility","hidden");}
}
setInterval(updateChartPlayhead,1000);
