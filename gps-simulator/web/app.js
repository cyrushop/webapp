/* global L */
// GPS 定位控制器 — browser UI. Talks to the local bridge over WebSocket (/ws).
import { estimateRoute } from './lib/planting.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const DEFAULT_OSRM = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
const prefs = Object.assign(
  { bloomSpeed: 7, osrmUrl: DEFAULT_OSRM, follow: true, routing: 'road' },
  store.get('gpssim.prefs', {}),
);
const savePrefs = () => store.set('gpssim.prefs', prefs);

// ------------------------------------------------------------------ utils
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const s =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const fmtLL = (p) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function confirmDialog(title, body) {
  return new Promise((resolve) => {
    const dlg = $('confirmDlg');
    $('confirmTitle').textContent = title;
    $('confirmBody').innerHTML = body;
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.showModal();
  });
}

/** Parse "lat, lng", "lat lng", Google Maps URLs (@lat,lng / q=lat,lng / !3d..!4d..), geo: URIs. */
export function parseCoords(text) {
  const s = String(text).trim();
  const tryPair = (a, b) => {
    const lat = parseFloat(a);
    const lng = parseFloat(b);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng }
      : null;
  };
  let m = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return tryPair(m[1], m[2]);
  m = s.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (m) return tryPair(m[1], m[2]);
  m = s.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return tryPair(m[1], m[2]);
  m = s.match(/^(?:geo:)?\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/i);
  if (m) return tryPair(m[1], m[2]);
  return null;
}

// ------------------------------------------------------------------ websocket
let ws;
let reqId = 0;
const pending = new Map();
let server = null; // latest state snapshot

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setDot('ws', 'on', '橋接已連線');
  ws.onclose = () => {
    setDot('ws', 'off', '未連線（重試中…）');
    setDot('adb', 'off', '—');
    for (const [, p] of pending) p({ ok: false, error: 'disconnected' });
    pending.clear();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === 'state') onState(data);
    else if (type === 'route') onServerRoute(data);
    else if (type === 'adb') onAdb(data);
    else if (type === 'device') onDevice(data);
    else if (type === 'reply') {
      const fn = pending.get(data.id);
      if (fn) {
        pending.delete(data.id);
        fn(data);
      }
    } else if (type === 'hello' && data.dryRun) toast('橋接以 DRY RUN 模式運行：不會真正改變手機定位');
  };
}

function rpc(type, data = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: '未連線到本地橋接' });
    const id = ++reqId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type, id, data }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }
    }, 15000);
  });
}
function fire(type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function setDot(which, cls, text) {
  $(`${which}Dot`).className = `dot ${cls}`;
  $(`${which}Text`).textContent = text;
}

// ------------------------------------------------------------------ map
const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([35.658581, 139.745433], 16);
const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
});
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
);
street.addTo(map);
L.control.layers({ 街道: street, 衛星: satellite }, {}, { position: 'topleft' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const phoneIcon = L.divIcon({ className: 'phone-icon', html: '<div class="arrow"></div>', iconSize: [14, 14], iconAnchor: [7, 9] });
const phoneDot = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 });
const phoneArrow = L.marker([0, 0], { icon: phoneIcon, interactive: false, keyboard: false });
const accCircle = L.circle([0, 0], { radius: 5, color: '#2563eb', weight: 1, fillOpacity: 0.08 });
const trail = L.polyline([], { color: '#2563eb', weight: 3, opacity: 0.45 });
const targetMarker = L.marker([0, 0], { draggable: true });
const actionMarker = L.circleMarker([0, 0], { radius: 6, color: '#e85d9a', weight: 2, fillOpacity: 0.3 });
const routeLine = L.polyline([], { color: '#e85d9a', weight: 4, opacity: 0.8 });
const serverRouteLine = L.polyline([], { color: '#2e9e5b', weight: 5, opacity: 0.55, dashArray: '6 6' });
const wpLayer = L.layerGroup().addTo(map);
let phoneShown = false;

let clickMode = 'pick'; // pick | draw
function setClickMode(m) {
  clickMode = m;
  $('modePick').classList.toggle('active', m === 'pick');
  $('modeDraw').classList.toggle('active', m === 'draw');
  map.getContainer().style.cursor = m === 'draw' ? 'crosshair' : '';
  if (m === 'draw') switchTab('route');
}
$('modePick').onclick = () => setClickMode('pick');
$('modeDraw').onclick = () => setClickMode('draw');
$('followBtn').classList.toggle('active', prefs.follow);
$('followBtn').onclick = () => {
  prefs.follow = !prefs.follow;
  savePrefs();
  $('followBtn').classList.toggle('active', prefs.follow);
  if (prefs.follow && server) map.panTo([server.output.lat, server.output.lng]);
};
map.on('dragstart', () => {
  if (prefs.follow) {
    prefs.follow = false;
    $('followBtn').classList.remove('active');
  }
});

map.on('click', (e) => {
  const p = { lat: e.latlng.lat, lng: L.Util.wrapNum(e.latlng.lng, [-180, 180], true) };
  if (clickMode === 'draw') addWaypoint(p);
  else setTarget(p);
});

// ------------------------------------------------------------------ state from server
function onState(s) {
  server = s;
  const p = [s.output.lat, s.output.lng];
  if (!phoneShown) {
    phoneDot.addTo(map);
    phoneArrow.addTo(map);
    accCircle.addTo(map);
    trail.addTo(map);
    phoneShown = true;
    map.setView(p, map.getZoom());
  }
  phoneDot.setLatLng(p);
  phoneArrow.setLatLng(p);
  accCircle.setLatLng(p).setRadius(s.settings.accuracyM);
  const arrow = phoneArrow.getElement()?.querySelector('.arrow');
  if (arrow) {
    arrow.style.transform = `rotate(${s.bearing}deg)`;
    arrow.style.opacity = s.speedKmh > 0.2 ? '1' : '0';
  }
  const tl = trail.getLatLngs();
  const last = tl[tl.length - 1];
  if (!last || dist({ lat: last.lat, lng: last.lng }, s.output) > 1) {
    if (last && dist({ lat: last.lat, lng: last.lng }, s.output) > 2000) trail.setLatLngs([]);
    trail.addLatLng(p);
    if (trail.getLatLngs().length > 600) trail.setLatLngs(trail.getLatLngs().slice(-500));
  }
  if (prefs.follow) map.panTo(p, { animate: true, duration: 0.5 });

  $('posText').textContent = fmtLL(s.output);
  $('spdText').textContent = `${s.speedKmh.toFixed(1)} km/h`;
  const modeName = { idle: '靜止', route: '路線中', joystick: '搖桿' }[s.mode] || s.mode;
  $('modeText').textContent = s.mocking ? modeName : '已還原真實 GPS';
  syncSettings(s.settings);
  renderRouteStatus(s.route);
  renderPlanting(s);
  renderCooldown();
  if (s.adb) onAdb(s.adb);
  if (s.device) onDevice({ ...s.device, transport: s.transport });
  if (s.lastAction) actionMarker.setLatLng([s.lastAction.lat, s.lastAction.lng]).addTo(map);
  else actionMarker.remove();
}

let lastAdb = null;
let lastDevice = null;
function onAdb(a) {
  lastAdb = a;
  renderLink();
}
function onDevice(d) {
  lastDevice = { ...lastDevice, ...d };
  renderLink();
}
function renderLink() {
  const a = lastAdb;
  const d = lastDevice;
  const transport = d?.transport || server?.transport || 'none';
  if (transport === 'ws' && d) {
    setDot('adb', d.mockApp === false || d.error ? 'warn' : 'on', `USB 直連${d.rttMs != null ? ` ${d.rttMs} ms` : ''}`);
  } else if (a?.dryRun) setDot('adb', 'warn', 'DRY RUN');
  else if (transport === 'adb' && a) setDot('adb', a.lastError ? 'warn' : 'on', `ADB 廣播 ${a.serial || ''}`);
  else setDot('adb', 'off', '手機未連線');

  const lines = [];
  lines.push(`<b>傳送方式：${{ ws: 'USB 直連（WebSocket）', adb: 'ADB 廣播（後備）', none: '—' }[transport]}</b>`);
  if (d) {
    lines.push(
      `直連：${d.connected ? '✅' : '❌'}${d.connected ? `　${esc(d.model || '?')} · Android SDK ${d.sdk ?? '?'} · App ${esc(d.app || '?')}` : ''}`,
    );
    if (d.connected) {
      lines.push(`延遲 ${d.rttMs ?? '—'} ms　已送出 ${d.sent}　手機已套用 ${d.fixes ?? '—'}`);
      lines.push(`模擬位置 App：${d.mockApp == null ? '—' : d.mockApp ? '✅' : '❌ 未選取'}　Providers：${esc((d.providers || []).join(', ') || '—')}`);
      if (d.error) lines.push(`<span class="warn">手機錯誤：${esc(d.error)}</span>`);
    }
  }
  if (a) {
    lines.push(`ADB：${a.dryRun ? 'DRY RUN' : a.connected ? '✅' : '❌'}　裝置 ${esc(a.serial || '—')}　reverse ${a.reverseOk ? `✅ tcp:${a.reversePort}` : '❌'}`);
    lines.push(`廣播已送出 ${a.sent}　丟棄 ${a.dropped}　待回應 ${a.pending}　套件 ${esc(a.pkg)}`);
    if (a.lastError) lines.push(`<span class="warn">最近錯誤：${esc(a.lastError)}</span>`);
  }
  $('devStatus').innerHTML = lines.join('<br>');
}

// ------------------------------------------------------------------ movement settings
let settingsDirty = 0;
function pushSettings(patch) {
  settingsDirty = Date.now();
  fire('settings', patch);
}
function syncSettings(st) {
  if (Date.now() - settingsDirty < 1500) return; // don't fight the user while they edit
  if (document.activeElement !== $('speed')) {
    $('speed').value = st.speedKmh;
    $('speedOut').value = st.speedKmh.toFixed(1);
  }
  if (document.activeElement !== $('jitter')) $('jitter').value = st.jitterM;
  if (document.activeElement !== $('variance')) $('variance').value = st.speedVariancePct;
  if (document.activeElement !== $('accuracy')) $('accuracy').value = st.accuracyM;
  $('jitterIdle').checked = st.jitterWhenIdle;
  $('autoMark').checked = st.autoMarkOnTeleport;
  if (document.activeElement !== $('loopMode')) $('loopMode').value = st.loopMode;
  if (document.activeElement !== $('cdTable')) $('cdTable').value = st.cooldownTable.map((r) => r.join(', ')).join('\n');
  updateSpeedWarn(st.speedKmh);
}
function updateSpeedWarn(v) {
  $('speedWarn').classList.toggle('hidden', v < 16);
  document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === v));
}
function setSpeed(v) {
  v = Math.max(0.5, Math.min(60, Number(v)));
  $('speed').value = v;
  $('speedOut').value = v.toFixed(1);
  updateSpeedWarn(v);
  pushSettings({ speedKmh: v });
}
$('speed').oninput = (e) => setSpeed(e.target.value);
document.querySelectorAll('[data-speed]').forEach((b) => (b.onclick = () => setSpeed(b.dataset.speed)));
$('bloomPresetVal').textContent = prefs.bloomSpeed;
$('bloomSpeed').value = prefs.bloomSpeed;
$('bloomPreset').onclick = () => setSpeed(prefs.bloomSpeed);
$('bloomSpeed').onchange = (e) => {
  prefs.bloomSpeed = Math.max(1, Math.min(20, Number(e.target.value) || 7));
  $('bloomPresetVal').textContent = prefs.bloomSpeed;
  savePrefs();
};
$('jitter').onchange = (e) => pushSettings({ jitterM: Number(e.target.value) });
$('variance').onchange = (e) => pushSettings({ speedVariancePct: Number(e.target.value) });
$('jitterIdle').onchange = (e) => pushSettings({ jitterWhenIdle: e.target.checked });
$('accuracy').onchange = (e) => pushSettings({ accuracyM: Number(e.target.value) });
$('autoMark').onchange = (e) => pushSettings({ autoMarkOnTeleport: e.target.checked });
$('loopMode').onchange = (e) => pushSettings({ loopMode: e.target.value });
$('osrmUrl').value = prefs.osrmUrl;
$('osrmUrl').onchange = (e) => {
  prefs.osrmUrl = e.target.value.trim().replace(/\/+$/, '') || DEFAULT_OSRM;
  e.target.value = prefs.osrmUrl;
  savePrefs();
};

// ------------------------------------------------------------------ tabs / panel
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'dev') refreshDevices();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
$('panelToggle').onclick = () => {
  $('panel').classList.toggle('collapsed');
  setTimeout(() => map.invalidateSize(), 50);
};

// ------------------------------------------------------------------ teleport
let target = null;
function setTarget(p, label = '') {
  target = { lat: p.lat, lng: p.lng, label };
  targetMarker.setLatLng([p.lat, p.lng]).addTo(map);
  $('targetBox').classList.remove('hidden');
  $('targetCoords').textContent = fmtLL(p);
  switchTab('tp');
  renderTargetInfo();
}
targetMarker.on('dragend', () => {
  const ll = targetMarker.getLatLng();
  setTarget({ lat: ll.lat, lng: ll.lng }, target?.label);
});
function renderTargetInfo() {
  if (!target) return;
  const parts = [];
  if (target.label) parts.push(esc(target.label));
  if (server) parts.push(`距手機 ${fmtDist(dist(server.position, target))}`);
  const cd = cooldownPreview(target);
  if (cd) parts.push(cd.remainingSec > 0 ? `<span class="warn">冷卻尚餘 ${fmtDur(cd.remainingSec)}（需 ${cd.requiredMin} 分）</span>` : `冷卻：可出發（需 ${cd.requiredMin} 分，已過）`);
  $('targetInfo').innerHTML = parts.join('　·　');
}

function cooldownPreview(p) {
  if (!server?.lastAction) return null;
  const km = dist(server.lastAction, p) / 1000;
  const table = server.settings.cooldownTable;
  let requiredMin = 0;
  if (km > 0) {
    requiredMin = table[table.length - 1][1];
    for (const [d, m] of table) if (km <= d) { requiredMin = m; break; }
  }
  const elapsed = (Date.now() - server.lastAction.at) / 60000;
  return { km, requiredMin, remainingSec: Math.max(0, Math.ceil((requiredMin - elapsed) * 60)) };
}

async function teleportTo(p) {
  let r = await rpc('teleport', p);
  if (!r.ok && r.needsConfirm) {
    const cd = r.cooldown;
    const ok = await confirmDialog(
      '⏳ 冷卻時間未到',
      `距上次互動點 <b>${cd.km.toFixed(1)} km</b>，參考冷卻 <b>${cd.requiredMin} 分鐘</b>，尚餘 <b>${fmtDur(cd.remainingSec)}</b>。<br><br>` +
        '冷卻表為社群非官方數據。現在瞬移後若立即互動，可能較易被系統標記。仍然要瞬移嗎？',
    );
    if (!ok) return false;
    r = await rpc('teleport', { ...p, force: true });
  }
  if (!r.ok) {
    toast(`瞬移失敗：${r.error || ''}`);
    return false;
  }
  toast(`已瞬移到 ${fmtLL(p)}`);
  if (prefs.follow) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16));
  return true;
}
$('tpGo').onclick = () => target && teleportTo(target);
$('tpFav').onclick = () => target && addFavorite(target, target.label);
$('tpWaypoint').onclick = () => target && addWaypoint(target);

$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  const ll = parseCoords(q);
  const list = $('searchResults');
  list.innerHTML = '';
  if (ll) {
    setTarget(ll);
    map.setView([ll.lat, ll.lng], 17);
    return;
  }
  list.innerHTML = '<li class="muted">搜尋中…</li>';
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh-TW,en&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const rows = await res.json();
    list.innerHTML = rows.length ? '' : '<li class="muted">找不到結果</li>';
    for (const r of rows) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="grow">${esc(r.display_name)}</span>`;
      li.onclick = () => {
        const p = { lat: Number(r.lat), lng: Number(r.lon) };
        setTarget(p, r.name || r.display_name.split(',')[0]);
        map.setView([p.lat, p.lng], 17);
      };
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="muted">搜尋失敗：${esc(err.message)}</li>`;
  }
};

// ------------------------------------------------------------------ route editing
let waypoints = store.get('gpssim.waypoints', []);
let routeGeometry = [];
const wpHistory = [];
function saveWaypoints() {
  store.set('gpssim.waypoints', waypoints);
}
function addWaypoint(p) {
  wpHistory.push(waypoints.map((w) => ({ ...w })));
  waypoints.push({ lat: p.lat, lng: p.lng });
  saveWaypoints();
  renderWaypoints();
  previewStraight();
}
function renderWaypoints() {
  wpLayer.clearLayers();
  $('wpCount').textContent = waypoints.length;
  const ol = $('wpList');
  ol.innerHTML = '';
  waypoints.forEach((w, i) => {
    const icon = L.divIcon({ className: 'wp-icon', html: String(i + 1), iconSize: [20, 20] });
    const m = L.marker([w.lat, w.lng], { icon, draggable: true }).addTo(wpLayer);
    m.on('dragend', () => {
      const ll = m.getLatLng();
      wpHistory.push(waypoints.map((x) => ({ ...x })));
      waypoints[i] = { lat: ll.lat, lng: ll.lng };
      saveWaypoints();
      renderWaypoints();
      previewStraight();
    });
    const li = document.createElement('li');
    li.innerHTML = `<b>${i + 1}</b><span class="grow mono">${fmtLL(w)}</span>`;
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '✕';
    del.onclick = () => {
      wpHistory.push(waypoints.map((x) => ({ ...x })));
      waypoints.splice(i, 1);
      saveWaypoints();
      renderWaypoints();
      previewStraight();
    };
    li.appendChild(del);
    ol.appendChild(li);
  });
}
function previewStraight() {
  const pts = waypoints.map((w) => [w.lat, w.lng]);
  if ($('loopMode').value === 'circuit' && pts.length > 2) pts.push(pts[0]);
  routeLine.setLatLngs(pts).addTo(map);
  routeGeometry = [];
}
$('wpUndo').onclick = () => {
  if (!wpHistory.length) return;
  waypoints = wpHistory.pop();
  saveWaypoints();
  renderWaypoints();
  previewStraight();
};
$('wpClear').onclick = async () => {
  if (!waypoints.length) return;
  wpHistory.push(waypoints.map((w) => ({ ...w })));
  waypoints = [];
  saveWaypoints();
  renderWaypoints();
  previewStraight();
  await rpc('clearRoute');
};
$('routing').value = prefs.routing;
$('routing').onchange = (e) => {
  prefs.routing = e.target.value;
  savePrefs();
};

async function osrmRoute(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${prefs.osrmUrl}/${coords}?overview=full&geometries=geojson&continue_straight=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || 'no route');
  return j.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

$('buildRoute').onclick = async () => {
  if (waypoints.length < 2) return toast('請先在地圖上加入至少 2 個路徑點');
  const loop = $('loopMode').value;
  let pts = waypoints.slice();
  if (loop === 'circuit' && pts.length > 2) pts.push(pts[0]);
  let geom = pts;
  if ($('routing').value === 'road') {
    $('buildRoute').disabled = true;
    $('buildRoute').textContent = '計算道路路線中…';
    try {
      geom = await osrmRoute(pts);
    } catch (err) {
      const ok = await confirmDialog('道路路線失敗', `OSRM 回應：${esc(err.message)}<br>改用直線連接路徑點？`);
      if (!ok) return resetBuildBtn();
      geom = pts;
    }
    resetBuildBtn();
  }
  routeGeometry = geom;
  routeLine.setLatLngs(geom.map((p) => [p.lat, p.lng])).addTo(map);
  pushSettings({ loopMode: loop });
  const r = await rpc('setRoute', { points: geom });
  if (!r.ok) return toast(`載入路線失敗：${r.error}`);
  const speed = Number($('speed').value);
  $('routeInfo').textContent = `路線長度 ${fmtDist(r.lengthM)}，以 ${speed} km/h 每圈約 ${fmtDur(r.lengthM / (speed / 3.6))}`;
  if (loop === 'circuit') {
    const lapMin = r.lengthM / (speed / 3.6) / 60;
    if (lapMin < 5) $('routeInfo').textContent += '　⚠️ 每圈少於 5 分鐘，同一地點可能未過種花間隔';
  }
  toast('路線已載入，可按「開始」');
};
function resetBuildBtn() {
  $('buildRoute').disabled = false;
  $('buildRoute').textContent = '🧭 生成並載入路線';
}

function onServerRoute(points) {
  serverRouteLine.setLatLngs((points || []).map((p) => [p.lat, p.lng]));
  if (points?.length) serverRouteLine.addTo(map);
  else serverRouteLine.remove();
}

$('routeStart').onclick = async () => {
  let r = await rpc('startRoute');
  if (!r.ok && r.needsTeleport) {
    const cd = r.cooldown;
    const cdText = cd.remainingSec > 0 ? `<br><span class="warn">冷卻尚餘 ${fmtDur(cd.remainingSec)}</span>` : '';
    const ok = await confirmDialog('先瞬移到起點？', `手機距離路線起點 ${fmtDist(r.gapM)}。${cdText}`);
    if (!ok) return;
    r = await rpc('startRoute', { teleportToStart: true, force: true });
  }
  if (!r.ok) toast(`無法開始：${r.error || ''}`);
};
$('routePause').onclick = () => rpc('pauseRoute');
$('routeStop').onclick = () => rpc('stopRoute');

function renderRouteStatus(rt) {
  if (!rt) {
    $('routeStatus').textContent = '未載入路線';
    $('routeBar').style.width = '0';
    return;
  }
  const names = { stopped: '已停止', running: '行走中', paused: '已暫停', finished: '已完成' };
  const modes = { once: '單次', pingpong: '往返', circuit: '繞圈' };
  $('routeBar').style.width = `${(rt.progress * 100).toFixed(1)}%`;
  $('routeStatus').textContent = `${names[rt.state]} · ${modes[rt.mode]} · 圈數 ${rt.lap} · 已走 ${fmtDist(rt.travelledM)} / 每圈 ${fmtDist(rt.lengthM)}`;
}

// GPX
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('不是有效的 GPX/XML');
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const nodes = [...doc.getElementsByTagName(tag)];
    if (nodes.length) {
      return nodes
        .map((n) => ({ lat: Number(n.getAttribute('lat')), lng: Number(n.getAttribute('lon')) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    }
  }
  return [];
}
function buildGpx(points, name = 'route') {
  const pts = points.map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gps-simulator" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${esc(name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('gpxIn').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const pts = parseGpx(await f.text());
    if (pts.length < 2) return toast('GPX 內沒有足夠的點');
    // Use the track as-is (already a path). Show a thinned set of editable waypoints.
    const step = Math.max(1, Math.ceil(pts.length / 40));
    waypoints = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    saveWaypoints();
    renderWaypoints();
    routeGeometry = pts;
    routeLine.setLatLngs(pts.map((p) => [p.lat, p.lng])).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    const r = await rpc('setRoute', { points: pts });
    toast(r.ok ? `已匯入 ${pts.length} 點，長度 ${fmtDist(r.lengthM)}` : `匯入失敗：${r.error}`);
  } catch (err) {
    toast(`GPX 讀取失敗：${err.message}`);
  }
};
$('gpxOut').onclick = () => {
  const pts = routeGeometry.length ? routeGeometry : waypoints;
  if (pts.length < 2) return toast('沒有可匯出的路線');
  download(`route-${new Date().toISOString().slice(0, 10)}.gpx`, buildGpx(pts), 'application/gpx+xml');
};

// ------------------------------------------------------------------ favourites
const SEED_FAVS = [
  { name: '東京鐵塔', lat: 35.658581, lng: 139.745433, tags: ['示例', '東京'] },
  { name: '新宿站', lat: 35.690921, lng: 139.700258, tags: ['示例', '東京'] },
  { name: '台北 101', lat: 25.033976, lng: 121.564472, tags: ['示例', '台北'] },
  { name: '紐約中央公園（Bethesda Terrace）', lat: 40.774, lng: -73.9708, tags: ['示例', '公園'] },
  { name: '香港維多利亞公園', lat: 22.282, lng: 114.188, tags: ['示例', '香港', '公園'] },
];
let favs = store.get('gpssim.favs', null);
if (!Array.isArray(favs)) {
  favs = SEED_FAVS.map((f, i) => ({ id: `seed${i}`, createdAt: Date.now(), ...f }));
  store.set('gpssim.favs', favs);
}
let tagFilter = '';
const saveFavs = () => store.set('gpssim.favs', favs);
const parseTags = (s) =>
  [...new Set(String(s || '').split(/[\s,，]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];

function addFavorite(p, defaultName = '') {
  const name = prompt('名稱：', defaultName || fmtLL(p));
  if (name == null) return;
  const tags = parseTags(prompt('標籤（空格分隔，例如 #巨菇熱點 #美術館苗）：', '') || '');
  favs.unshift({ id: crypto.randomUUID?.() || String(Date.now()), name: name.trim() || fmtLL(p), lat: p.lat, lng: p.lng, tags, createdAt: Date.now() });
  saveFavs();
  renderFavs();
  toast('已加入收藏');
}
function renderFavs() {
  const q = $('favFilter').value.trim().toLowerCase();
  const allTags = [...new Set(favs.flatMap((f) => f.tags || []))].sort();
  const chips = $('tagChips');
  chips.innerHTML = '';
  for (const t of allTags) {
    const b = document.createElement('button');
    b.className = `chip${tagFilter === t ? ' active' : ''}`;
    b.textContent = `#${t}`;
    b.onclick = () => {
      tagFilter = tagFilter === t ? '' : t;
      renderFavs();
    };
    chips.appendChild(b);
  }
  const list = $('favList');
  list.innerHTML = '';
  const rows = favs.filter((f) => {
    if (tagFilter && !(f.tags || []).includes(tagFilter)) return false;
    if (!q) return true;
    const hay = `${f.name} ${(f.tags || []).map((t) => '#' + t).join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
  if (!rows.length) list.innerHTML = '<li class="muted">沒有收藏</li>';
  for (const f of rows) {
    const li = document.createElement('li');
    const cd = cooldownPreview(f);
    const cdTxt = cd && cd.remainingSec > 0 ? ` <span class="warn small">⏳${fmtDur(cd.remainingSec)}</span>` : '';
    li.innerHTML = `<span class="grow"><b>${esc(f.name)}</b>${cdTxt}<br><span class="tags">${(f.tags || []).map((t) => '#' + esc(t)).join(' ')}</span> <span class="small muted mono">${fmtLL(f)}</span></span>`;
    li.onclick = () => {
      setTarget(f, f.name);
      map.setView([f.lat, f.lng], 17);
    };
    const go = document.createElement('button');
    go.className = 'small primary';
    go.textContent = '⚡';
    go.title = '瞬移';
    go.onclick = (e) => {
      e.stopPropagation();
      teleportTo(f);
    };
    const edit = document.createElement('button');
    edit.className = 'small';
    edit.textContent = '✎';
    edit.title = '編輯';
    edit.onclick = (e) => {
      e.stopPropagation();
      const name = prompt('名稱：', f.name);
      if (name == null) return;
      const tags = prompt('標籤：', (f.tags || []).map((t) => '#' + t).join(' '));
      f.name = name.trim() || f.name;
      if (tags != null) f.tags = parseTags(tags);
      saveFavs();
      renderFavs();
    };
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '✕';
    del.title = '刪除';
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`刪除「${f.name}」？`)) return;
      favs = favs.filter((x) => x !== f);
      saveFavs();
      renderFavs();
    };
    li.append(go, edit, del);
    list.appendChild(li);
  }
}
$('favFilter').oninput = renderFavs;
$('favAddHere').onclick = () => server && addFavorite(server.position);
$('favExport').onclick = () =>
  download(`favorites-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, favorites: favs }, null, 2), 'application/json');
$('favImport').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const items = Array.isArray(j) ? j : j.favorites;
    if (!Array.isArray(items)) throw new Error('格式不符');
    let added = 0;
    for (const it of items) {
      const lat = Number(it.lat);
      const lng = Number(it.lng ?? it.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (favs.some((x) => Math.abs(x.lat - lat) < 1e-6 && Math.abs(x.lng - lng) < 1e-6)) continue;
      favs.push({
        id: crypto.randomUUID?.() || `${Date.now()}${added}`,
        name: String(it.name || fmtLL({ lat, lng })).slice(0, 120),
        lat,
        lng,
        tags: Array.isArray(it.tags) ? it.tags.map(String) : parseTags(it.tags),
        createdAt: Number(it.createdAt) || Date.now(),
      });
      added++;
    }
    saveFavs();
    renderFavs();
    toast(`已匯入 ${added} 個收藏（重複座標已略過）`);
  } catch (err) {
    toast(`匯入失敗：${err.message}`);
  }
};

// ------------------------------------------------------------------ flower planting estimate
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
let plantingDirty = 0;
function pushPlanting(patch) {
  plantingDirty = Date.now();
  pushSettings({ planting: patch });
}
function renderPlanting(s) {
  const p = s.planting;
  if (!p) return;
  const cfg = p.cfg;
  $('bloomFlowers').textContent = `${fmtInt(p.flowers)} 朵`;
  const wastedPct = p.petalsUsed > 0 ? (p.petalsWasted / p.petalsUsed) * 100 : 0;
  $('bloomStats').innerHTML = [
    `已用花瓣 ${p.petalsUsed.toFixed(1)}${p.petalsLeft != null ? `（剩 ${p.petalsLeft.toFixed(0)}）` : ''}`,
    `重複格浪費 ${p.petalsWasted.toFixed(1)} 片（${wastedPct.toFixed(0)}%）`,
    `最近 1 分鐘速率 ≈ ${fmtInt(p.flowersPerHourNow)} 朵/小時`,
    `種花時間 ${fmtDur(p.plantingSec)}　超速 ${fmtDur(p.overSpeedSec)}`,
    s.speedKmh > cfg.speedCapKmh ? `<span class="warn">⚠️ 現時 ${s.speedKmh.toFixed(1)} km/h 超過上限 ${cfg.speedCapKmh}，唔會種花</span>` : '',
  ]
    .filter(Boolean)
    .join('<br>');
  if (Date.now() - plantingDirty > 1500) {
    if (document.activeElement !== $('squad')) {
      $('squad').value = cfg.squad;
      $('squadOut').value = cfg.squad;
    }
    if (document.activeElement !== $('petalsAvail')) $('petalsAvail').value = cfg.petalsAvailable;
    document.querySelectorAll('[data-pl]').forEach((el) => {
      if (document.activeElement !== el) el.value = cfg[el.dataset.pl];
    });
  }
  renderPlan(s);
}
function renderPlan(s) {
  const cfg = s.planting.cfg;
  const speed = s.settings.speedKmh;
  const lines = [];
  const rt = s.route;
  const base = estimateRoute(cfg, { lapM: 1e9, speedKmh: speed });
  lines.push(`以 ${speed} km/h、${cfg.squad} 隻皮克敏：約 <b>${fmtInt(base.flowersPerHour)} 朵/小時</b>，用 ${fmtInt(base.petalsPerHour)} 片花瓣/小時`);
  if (base.hoursUntilEmpty != null) {
    const h = base.hoursUntilEmpty;
    lines.push(`現有花瓣約可種 ${h >= 1 ? `${h.toFixed(1)} 小時` : `${Math.round(h * 60)} 分鐘`}`);
  }
  let routeLine = '';
  if (rt && rt.lengthM > 0) {
    const pingpong = rt.mode === 'pingpong';
    const r = estimateRoute(cfg, { lapM: rt.lengthM, speedKmh: speed, pingpong });
    routeLine = `目前路線：每圈 ${fmtDur(r.lapSec)}，第一圈約 ${fmtInt(r.flowersFirstLap)} 朵`;
    if (rt.mode !== 'once') {
      routeLine += `，之後每圈約 ${fmtInt(r.flowersPerLap)} 朵，循環約 <b>${fmtInt(r.flowersPerHour)} 朵/小時</b>`;
      if (r.fresh < 1) routeLine += `<br><span class="warn">⚠️ 同一位置 ${cfg.cooldownMin} 分鐘內會再經過，只有約 ${(r.fresh * 100).toFixed(0)}% 經過有效；加長路線或減慢速度可改善</span>`;
    }
    lines.push(routeLine);
  }
  if (base.overCap) lines.push(`<span class="warn">⚠️ 速度超過 ${cfg.speedCapKmh} km/h 上限，估算為 0</span>`);
  $('bloomPlan').innerHTML = lines.join('<br>');
  $('routePlan').innerHTML = routeLine ? `🌸 ${routeLine}` : '';
}
$('squad').oninput = (e) => {
  $('squadOut').value = e.target.value;
  pushPlanting({ squad: Number(e.target.value) });
};
$('petalsAvail').onchange = (e) => pushPlanting({ petalsAvailable: Math.max(0, Number(e.target.value) || 0) });
document.querySelectorAll('[data-pl]').forEach((el) => {
  el.onchange = () => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= 0) pushPlanting({ [el.dataset.pl]: v });
  };
});
$('bloomReset').onclick = async () => {
  if (await confirmDialog('重設種花統計？', '已種花、已用花瓣等數字會歸零（設定保留）。')) rpc('resetPlanting');
};

// ------------------------------------------------------------------ cooldown
function renderCooldown() {
  const la = server?.lastAction;
  if (!la) {
    $('cdLast').textContent = '未記錄';
    $('cdLive').textContent = '—';
    $('cdDetail').textContent = '記錄一次互動後，會顯示前往目標點所需的冷卻時間。';
  } else {
    $('cdLast').textContent = `${fmtLL(la)} @ ${new Date(la.at).toLocaleTimeString()}`;
    const ref = target || server.position;
    const cd = cooldownPreview(ref);
    $('cdLive').textContent = cd.remainingSec > 0 ? `⏳ ${fmtDur(cd.remainingSec)}` : '✅ 可行動';
    $('cdDetail').textContent = `${target ? '到目標點' : '到手機目前位置'}：${cd.km.toFixed(2)} km → 參考冷卻 ${cd.requiredMin} 分鐘；距上次互動已過 ${fmtDur((Date.now() - la.at) / 1000)}`;
  }
  renderTargetInfo();
}
$('cdMark').onclick = () => rpc('markAction').then(() => toast('已記錄互動點'));
$('cdClear').onclick = () => rpc('clearAction');
$('cdApply').onclick = () => {
  const rows = $('cdTable')
    .value.split('\n')
    .map((l) => l.split(/[,\s]+/).map(Number))
    .filter((r) => r.length >= 2 && r[0] > 0 && r[1] >= 0);
  if (!rows.length) return toast('冷卻表格式：每行「距離km, 分鐘」');
  pushSettings({ cooldownTable: rows });
  toast(`已套用 ${rows.length} 行冷卻表`);
};
setInterval(() => {
  renderCooldown();
  if (document.querySelector('#tab-fav.active')) renderFavs();
}, 1000);

// ------------------------------------------------------------------ device
async function refreshDevices() {
  const r = await rpc('devices');
  const sel = $('devSelect');
  sel.innerHTML = '';
  if (!r.ok) {
    sel.innerHTML = '<option>（adb 不可用）</option>';
    return toast(`adb：${r.error}`);
  }
  for (const d of r.devices) {
    const o = document.createElement('option');
    o.value = d.serial;
    o.textContent = `${d.serial} ${d.model || ''} [${d.state}]`;
    if (server?.adb?.serial === d.serial) o.selected = true;
    sel.appendChild(o);
  }
  if (!r.devices.length) sel.innerHTML = '<option value="">（沒有裝置）</option>';
}
$('devRefresh').onclick = refreshDevices;
$('devConnect').onclick = async () => {
  const r = await rpc('selectDevice', { serial: $('devSelect').value });
  toast(r.ok ? `已連接 ${r.serial || ''}` : `連接失敗：${r.error}`);
};
$('devSetup').onclick = async () => {
  $('devLog').classList.remove('hidden');
  $('devLog').textContent = '執行中…';
  const r = await rpc('setupPhone');
  $('devLog').textContent = (r.log || [r.error]).join('\n\n');
  toast(r.ok ? '手機設定完成' : '部分步驟失敗，請看記錄');
};
$('devReverse').onclick = async () => {
  const r = await rpc('reverse');
  toast(r.ok ? 'adb reverse 已建立，手機 App 會自動重連' : (r.skipped ? '已略過（DRY RUN 或 TRANSPORT=adb）' : `adb reverse 失敗：${r.error || ''}`));
};
$('devStop').onclick = async () => {
  const ok = await confirmDialog('還原真實 GPS？', '會停止路線並通知手機移除模擬定位提供者。之後瞬移或開始路線會自動重新啟用模擬。');
  if (ok) await rpc('stopMocking');
};

// ------------------------------------------------------------------ joystick
const joy = $('joystick');
const knob = $('knob');
let joyVec = { x: 0, y: 0 };
let joyPointer = null;
const keys = new Set();

function sendJoy() {
  const kx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
  const ky = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
  let v = joyPointer != null ? joyVec : { x: kx, y: ky };
  const m = Math.hypot(v.x, v.y);
  if (m > 1) v = { x: v.x / m, y: v.y / m };
  const r = joy.clientWidth / 2 - 26;
  knob.style.transform = `translate(${v.x * r}px, ${-v.y * r}px)`;
  fire('joystick', v);
}
// Re-send while held so a dropped packet can't leave the phone walking forever.
setInterval(() => {
  if (joyPointer != null || keys.size) sendJoy();
}, 250);

function joyFromEvent(e) {
  const rect = joy.getBoundingClientRect();
  const r = rect.width / 2;
  const x = (e.clientX - rect.left - r) / (r - 13);
  const y = -(e.clientY - rect.top - r) / (r - 13);
  joyVec = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  sendJoy();
}
joy.addEventListener('pointerdown', (e) => {
  joyPointer = e.pointerId;
  joy.setPointerCapture(e.pointerId);
  joy.classList.add('active');
  joyFromEvent(e);
});
joy.addEventListener('pointermove', (e) => {
  if (e.pointerId === joyPointer) joyFromEvent(e);
});
const joyEnd = (e) => {
  if (e.pointerId !== joyPointer) return;
  joyPointer = null;
  joyVec = { x: 0, y: 0 };
  joy.classList.remove('active');
  sendJoy();
};
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);
// Keep Leaflet from treating joystick drags as map drags/clicks.
L.DomEvent.disableClickPropagation(joy);
L.DomEvent.disableScrollPropagation(joy);

const KEYMAP = { w: 'w', a: 'a', s: 's', d: 'd', arrowup: 'w', arrowleft: 'a', arrowdown: 's', arrowright: 'd' };
function typing() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.key.toLowerCase()];
  if (!k || typing() || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (!keys.has(k)) {
    keys.add(k);
    sendJoy();
  }
});
window.addEventListener('keyup', (e) => {
  const k = KEYMAP[e.key.toLowerCase()];
  if (!k || !keys.has(k)) return;
  keys.delete(k);
  sendJoy();
});
window.addEventListener('blur', () => {
  if (keys.size || joyPointer != null) {
    keys.clear();
    joyPointer = null;
    joyVec = { x: 0, y: 0 };
    sendJoy();
  }
});

// ------------------------------------------------------------------ boot
renderWaypoints();
if (waypoints.length) previewStraight();
renderFavs();
connect();
