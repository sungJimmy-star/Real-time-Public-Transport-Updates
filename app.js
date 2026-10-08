'use strict';

// 臺北市、新北市公車動態資訊中心的開放資料:不用金鑰、允許跨網域讀取,約每 15 秒更新。
// 兩個城市的路線、子路線、車輛完全不重疊。
const FEEDS = {
  tpe: { name: '台北', base: 'https://tcgbusfs.blob.core.windows.net/blobbus/' },
  ntpc: { name: '新北', base: 'https://tcgbusfs.blob.core.windows.net/ntpcbus/' },
};
const POLL_MS = 15000;
const ROUTE_CACHE_MS = 12 * 3600e3;
const PALETTE = ['#d62728', '#1f62b4', '#2a8a2a', '#8e44ad', '#d35400', '#00838f',
  '#c2185b', '#6d4c41', '#3949ab', '#827717', '#00695c', '#455a64'];

// localStorage 在私密瀏覽等情況可能無法使用,讀寫失敗時當作沒有資料
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseTw = (s) => Date.parse(s.replace(' ', 'T') + '+08:00');   // '2026-10-08 15:10:10'(台灣時間)

let routes = {};      // 'tpe:10142' → { k, c, n, e, d, t, p, pa: [子路線編號...] }
let routeList = [];
let paIndex = {};     // 'tpe:157758' → 路線 key(即時資料的 RouteID 是子路線編號)
let watch = LS.get('watch:v1', []);   // [{ k, color }]
let lastData = {};    // city → { at, rows }
let lastErr = {};     // city → 錯誤訊息
let counts = {};      // 路線 key → [去程台數, 返程台數]
let pendingFit = null;

// ---------- 資料下載 ----------

async function fetchGz(url, fresh) {
  const res = await fetch(url, { cache: fresh ? 'no-store' : 'default' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text.replace(/^﻿/, ''));   // 伺服器出錯時內容是 HTML,這裡會丟出例外
}

async function loadRoutes() {
  const cached = LS.get('routes:v2', null);
  if (cached && Date.now() - cached.t < ROUTE_CACHE_MS) return setRoutes(cached.r);
  const out = [];
  const results = await Promise.allSettled(Object.keys(FEEDS).map(async (city) => {
    const j = await fetchGz(FEEDS[city].base + 'GetRoute.gz');
    const by = {};
    for (const r of j.BusInfo) {
      const k = city + ':' + r.Id;
      // s:首末班 [去程首班, 去程末班, 返程首班, 返程末班](平日、假日);h:班距 [尖峰, 離峰](平日、假日),'0510' = 5~10 分
      by[k] ??= {
        k, c: city, n: r.nameZh, e: r.nameEn || '', d: r.departureZh || '', t: r.destinationZh || '', p: r.providerName || '', pa: [],
        s: [[r.goFirstBusTime, r.goLastBusTime, r.backFirstBusTime, r.backLastBusTime],
          [r.holidayGoFirstBusTime, r.holidayGoLastBusTime, r.holidayBackFirstBusTime, r.holidayBackLastBusTime]],
        h: [[r.peakHeadway, r.offPeakHeadway], [r.holidayPeakHeadway, r.holidayOffPeakHeadway]],
      };
      by[k].pa.push(r.pathAttributeId);
    }
    out.push(...Object.values(by));
  }));
  const ok = results.every((r) => r.status === 'fulfilled');
  if (!out.length) {
    if (cached) return setRoutes(cached.r);
    throw new Error('路線資料下載失敗');
  }
  setRoutes(out);
  if (ok) LS.set('routes:v2', { t: Date.now(), r: out });
}

function setRoutes(list) {
  routeList = list;
  routes = {};
  paIndex = {};
  for (const r of list) {
    routes[r.k] = r;
    for (const pa of r.pa) paIndex[r.c + ':' + pa] = r.k;
  }
}

// ---------- 地圖 ----------

const view = LS.get('view:v1', { c: [25.045, 121.53], z: 12 });
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView(view.c, view.z);
L.control.attribution({ position: 'topleft', prefix: false }).addTo(map);
// 預設用國土測繪中心的臺灣通用電子地圖(中文、清爽、有捷運路線);OSM 當備用
const BASEMAPS = {
  '臺灣通用電子地圖': L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '&copy; <a href="https://maps.nlsc.gov.tw/">內政部國土測繪中心</a>',
  }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
};
(BASEMAPS[LS.get('base:v1', '')] || BASEMAPS['臺灣通用電子地圖']).addTo(map);
map.on('baselayerchange', (e) => LS.set('base:v1', e.name));
L.control.zoom({ position: 'topright' }).addTo(map);
map.on('moveend', () => { const c = map.getCenter(); LS.set('view:v1', { c: [c.lat, c.lng], z: map.getZoom() }); });

// 路線線條與站牌(data/bus_stops.json、shapes.json,由 build_static.py 從 TDX 產生;沒有這些檔案就只顯示車)
const canvas = L.canvas({ padding: 0.5 });
const lineLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup();
let stopData = null;
let shapeData = null;
let stopDataPromise = null;

function loadStops() {
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  stopDataPromise ??= Promise.all([get('data/bus_stops.json'), get('data/shapes.json')])
    .then(([d, s]) => { stopData = d; shapeData = s; drawLines(); });
  return stopDataPromise;
}

/** Google encoded polyline → [[緯度, 經度], ...] */
function decodePolyline(s) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let b, shift = 0, v = 0;
      do { b = s.charCodeAt(i++) - 63; v |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = v & 1 ? ~(v >> 1) : v >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

/** 公車實際行駛的軌跡:{ pts: [[緯度, 經度], ...], ix: 第 i 站在軌跡的第幾段 };沒有軌跡回傳 null */
const shapeCache = new Map();
function shapeOf(rk, d) {
  const key = rk + '|' + d;
  if (shapeCache.has(key)) return shapeCache.get(key);
  const e = shapeData?.s?.[rk]?.[d];
  const sh = e && e.length ? { pts: decodePolyline(e[0]), ix: e[1] } : null;
  shapeCache.set(key, sh);
  return sh;
}

/** 第 i 站到第 j 站之間沿著軌跡的線(a、b 是兩站的 [緯度, 經度]) */
function shapeSlice(sh, i, j, a, b) {
  const proj = (p, s) => {   // p 投影到第 s 段上
    const [y1, x1] = sh.pts[s], [y2, x2] = sh.pts[s + 1];
    const k = Math.cos(y1 * Math.PI / 180);
    const dx = (x2 - x1) * k, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, (((p[1] - x1) * k) * dx + (p[0] - y1) * dy) / L2)) : 0;
    return [y1 + t * dy, x1 + t * (x2 - x1)];
  };
  const si = sh.ix[i], sj = sh.ix[j];
  return [proj(a, si), ...sh.pts.slice(si + 1, sj + 1), proj(b, sj)];
}

function drawLines() {
  lineLayer.clearLayers();
  stopLayer.clearLayers();
  if (!stopData) return;
  for (const w of watch) {
    const r = routes[w.k];
    const ln = r && stopData.lines[w.k];
    if (!ln) continue;
    ln.forEach((ids, d) => {
      const pts = ids.map((id) => stopData.stops[r.c + ':' + id]).filter(Boolean);
      if (pts.length < 2) return;
      // 沿著公車實際行駛的軌跡畫(沒有軌跡就把站連成直線),實線是去程、虛線是返程
      const sh = shapeOf(w.k, d);
      L.polyline(sh ? sh.pts : pts.map((p) => [p[2], p[1]]), {
        renderer: canvas, color: w.color, weight: 5, opacity: 0.85, dashArray: d ? '8 7' : null, interactive: false,
      }).addTo(lineLayer);
      for (const p of pts) {
        L.circleMarker([p[2], p[1]], { renderer: canvas, radius: 4, color: w.color, weight: 2, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(p[0], { direction: 'top', offset: [0, -4] }).addTo(stopLayer);
      }
    });
  }
}

// 站牌點只在拉近時顯示
const syncStopLayer = () => { if (map.getZoom() >= 15) stopLayer.addTo(map); else stopLayer.remove(); };
map.on('zoomend', syncStopLayer);
syncStopLayer();

const busLayer = L.layerGroup().addTo(map);
const markers = new Map();   // 'tpe:222235669' → marker(marker.bus 是最新資料)

const Locate = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar');
    div.innerHTML = '<a href="#" class="locate" title="我的位置" role="button" aria-label="我的位置">◎</a>';
    L.DomEvent.on(div.firstChild, 'click', (e) => { L.DomEvent.preventDefault(e); locate(); });
    L.DomEvent.disableClickPropagation(div);
    return div;
  },
});
new Locate().addTo(map);
L.control.layers(BASEMAPS, null, { position: 'topright' }).addTo(map);
let meMarker = null;
function locate() {
  if (!navigator.geolocation) return setStatus('這個瀏覽器不支援定位', true);
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: 'bus-icon', html: '<div class="me"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
    else meMarker.setLatLng(ll);
    map.setView(ll, Math.max(map.getZoom(), 15));
  }, () => setStatus('無法取得位置(請允許定位權限)', true), { enableHighAccuracy: true, timeout: 10000 });
}

function busIcon(bus) {
  const r = routes[bus.rk];
  const az = bus.az >= 0 && bus.az < 360 ? bus.az : null;
  const html = `<div class="bus ${bus.dir === 1 ? 'back' : 'go'}" style="--c:${bus.color}">`
    + (az !== null ? `<i class="hdg" style="transform:rotate(${az}deg)"></i>` : '')
    + `<i class="dot"></i><b class="lbl">${esc(r.n)}</b></div>`;
  return L.divIcon({ className: 'bus-icon', html, iconSize: [0, 0] });
}

function dirText(r, dir) {
  if (dir === 0) return '往 ' + r.t;
  if (dir === 1) return '往 ' + r.d;
  return '';
}

function popupHtml(bus) {
  const r = routes[bus.rk];
  const age = Math.max(0, Math.round((Date.now() - parseTw(bus.time)) / 1000));
  return `<div class="pop"><b style="color:${bus.color}">${esc(r.n)}</b> ${esc(dirText(r, bus.dir))}<br>`
    + `車牌 ${esc(bus.plate)}・時速 ${bus.speed} km/h<br>`
    + `<span class="muted">${esc(bus.time.slice(11))}(${age} 秒前)・${esc(r.p)}</span></div>`;
}

function drawBuses() {
  const watched = new Map(watch.map((w) => [w.k, w]));
  const seen = new Set();
  counts = {};
  for (const [c, d] of Object.entries(lastData)) {
    for (const b of d.rows) {
      if (b.DutyStatus !== '1') continue;          // 2 = 收班或在場站待命
      const rk = paIndex[c + ':' + b.RouteID];
      const w = rk && watched.get(rk);
      if (!w) continue;
      const lat = +b.Latitude, lon = +b.Longitude;
      if (!lat || !lon) continue;
      const id = c + ':' + b.CarID;
      const dir = b.GoBack === '0' ? 0 : b.GoBack === '1' ? 1 : -1;
      const cnt = (counts[rk] ??= [0, 0]);
      if (dir >= 0) cnt[dir]++;
      const bus = { id, rk, color: w.color, dir, plate: b.BusID, speed: +b.Speed || 0, az: +b.Azimuth, time: b.DataTime };
      const key = `${w.color}|${dir}|${bus.az}`;
      let m = markers.get(id);
      if (!m) {
        m = L.marker([lat, lon], { icon: busIcon(bus), riseOnHover: true }).addTo(busLayer);
        m.bindPopup(() => popupHtml(m.bus), { autoPan: false });
        markers.set(id, m);
      } else {
        m.setLatLng([lat, lon]);
        if (m.iconKey !== key) m.setIcon(busIcon(bus));
      }
      m.iconKey = key;
      m.bus = bus;
      if (m.isPopupOpen()) m.getPopup().update();
      seen.add(id);
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { busLayer.removeLayer(m); markers.delete(id); }
  }
  if (pendingFit) {
    if (fitRoute(pendingFit, true)) pendingFit = null;
  }
}

function fitRoute(k, quiet) {
  const pts = [...markers.values()].filter((m) => m.bus.rk === k).map((m) => m.getLatLng());
  if (!pts.length) {
    if (!quiet) setStatus(`${routes[k]?.n ?? ''} 目前沒有營運中的車`, true);
    return false;
  }
  // 扣掉面板蓋住的範圍:手機在下方,寬螢幕在左邊
  const s = $('#sheet').getBoundingClientRect();
  const wide = window.innerWidth >= 768;
  map.fitBounds(L.latLngBounds(pts), {
    paddingTopLeft: [wide ? s.right + 30 : 30, 60],
    paddingBottomRight: [60, wide ? 30 : window.innerHeight - s.top + 30],
    maxZoom: 15,
  });
  return true;
}

// 拉遠時只顯示圓點,不然路線名稱會疊成一團
const syncZoomClass = () => map.getContainer().classList.toggle('zoom-far', map.getZoom() < 13);
map.on('zoomend', syncZoomClass);
syncZoomClass();

// ---------- 定時更新 ----------

let pollTimer = null;
let polling = false;
let pollAgain = false;   // 更新途中加入了路線,結束後馬上再抓一次

async function poll() {
  clearTimeout(pollTimer);
  if (polling) { pollAgain = true; return; }
  if (document.hidden) return;   // 回到前景時 visibilitychange 會再呼叫
  // 查看列表的路線 + 轉乘規劃選中的方案要搭的公車(plan.js 的 planCities)
  const extra = typeof planCities === 'function' ? planCities() : [];
  const cities = [...new Set([...watch.map((w) => routes[w.k]?.c), ...extra].filter(Boolean))];
  if (!cities.length) {
    lastData = {};
    drawBuses();
    renderWatch();
    setStatus('');
    return;
  }
  polling = true;
  try {
    const results = await Promise.allSettled(cities.map((c) => fetchGz(FEEDS[c].base + 'GetBusData.gz', true)));
    results.forEach((r, i) => {
      const c = cities[i];
      if (r.status === 'fulfilled') {
        lastData[c] = { at: Date.now(), rows: r.value.BusInfo };
        delete lastErr[c];
      } else {
        lastErr[c] = r.reason?.message || String(r.reason);
      }
    });
    for (const c of Object.keys(lastData)) if (!cities.includes(c)) delete lastData[c];
    drawBuses();
    renderWatch();
    if (typeof onBusData === 'function') onBusData();
    const failed = cities.filter((c) => lastErr[c]);
    if (failed.length) setStatus(`${failed.map((c) => FEEDS[c].name).join('、')}資料暫時抓不到,稍後自動重試`, true);
    else setStatus(`${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 更新`);
  } finally {
    polling = false;
  }
  if (pollAgain) { pollAgain = false; return poll(); }
  pollTimer = setTimeout(poll, POLL_MS);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

function setStatus(msg, err) {
  const el = $('#status');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('err', !!err);
}

// ---------- 查看列表 ----------

const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${d}</svg>`;
const ICON_FIT = svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>');
const ICON_X = svg('<path d="M6 6l12 12M18 6L6 18"/>');

function saveWatch() { LS.set('watch:v1', watch); }

function addWatch(k) {
  if (watch.some((w) => w.k === k)) return;
  const used = new Set(watch.map((w) => w.color));
  const color = PALETTE.find((c) => !used.has(c)) || PALETTE[watch.length % PALETTE.length];
  watch.push({ k, color });
  saveWatch();
  pendingFit = k;
  renderWatch();
  renderResults();
  loadStops().then(drawLines);
  poll();
}

function removeWatch(k) {
  watch = watch.filter((w) => w.k !== k);
  saveWatch();
  drawBuses();
  drawLines();
  renderWatch();
  renderResults();
}

function renderWatch() {
  const items = watch.filter((w) => routes[w.k]);
  $('#watch').innerHTML = items.map((w) => {
    const r = routes[w.k];
    const [g, b] = counts[w.k] || [0, 0];
    return `<li data-k="${esc(w.k)}" style="--c:${w.color}"><span class="sw"></span>`
      + `<div class="info"><b>${esc(r.n)}</b><span class="tag">${FEEDS[r.c].name}</span>`
      + `<small><i class="lg go"></i>${esc(dirText(r, 0))} ${g} 台</small>`
      + `<small><i class="lg back"></i>${esc(dirText(r, 1))} ${b} 台</small></div>`
      + `<button class="icon-btn" data-act="fit" title="在地圖上顯示" aria-label="在地圖上顯示">${ICON_FIT}</button>`
      + `<button class="icon-btn" data-act="rm" title="移除" aria-label="移除">${ICON_X}</button></li>`;
  }).join('');
  syncHint();
}

function syncHint() {
  const searching = !!$('#q').value.trim();
  $('#watch-empty').hidden = searching || watch.some((w) => routes[w.k]);
}

$('#watch').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  const li = e.target.closest('li');
  if (!li) return;
  if (btn?.dataset.act === 'rm') return removeWatch(li.dataset.k);
  if (window.innerWidth < 768) collapse(true);   // 先收合,地圖範圍才會算對
  fitRoute(li.dataset.k);
});

// ---------- 搜尋 ----------

const norm = (s) => (s || '').normalize('NFKC').toUpperCase().replace(/臺/g, '台').replace(/\s+/g, '');

function search(q) {
  q = norm(q);
  if (!q) return [];
  const res = [];
  for (const r of routeList) {
    const n = norm(r.n), e = norm(r.e);
    let s = -1;
    if (n === q || e === q) s = 0;
    else if (n.startsWith(q) || e.startsWith(q)) s = 1;
    else if (n.includes(q) || e.includes(q)) s = 2;
    else if (norm(r.d).includes(q) || norm(r.t).includes(q)) s = 3;
    if (s >= 0) res.push([s, n.length, r]);
  }
  res.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].n.localeCompare(b[2].n, 'zh-Hant'));
  return res.slice(0, 40).map((x) => x[2]);
}

function renderResults() {
  const q = $('#q').value;
  const box = $('#results');
  const searching = !!q.trim();
  box.hidden = !searching;
  $('#watch').hidden = searching;
  syncHint();
  if (!searching) return;
  if (!routeList.length) { box.innerHTML = '<li class="hint">路線資料載入中…</li>'; return; }
  const list = search(q);
  if (!list.length) { box.innerHTML = '<li class="hint">找不到符合的路線</li>'; return; }
  const added = new Set(watch.map((w) => w.k));
  box.innerHTML = list.map((r) => `<li data-k="${esc(r.k)}"><div class="info"><b>${esc(r.n)}</b>`
    + `<span class="tag">${FEEDS[r.c].name}</span><small>${esc(r.d)} ↔ ${esc(r.t)}</small>`
    + `<small>${esc(r.p)}</small></div>`
    + (added.has(r.k) ? '<button class="btn added" disabled>已加入</button>' : '<button class="btn" data-act="add">加入</button>')
    + '</li>').join('');
}

$('#q').addEventListener('input', renderResults);
$('#results').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="add"]');
  if (btn) addWatch(btn.closest('li').dataset.k);
});

// ---------- 面板 ----------

function collapse(on) { $('#sheet').classList.toggle('collapsed', on); }
$('#handle').addEventListener('click', () => collapse(!$('#sheet').classList.contains('collapsed')));
$('#q').addEventListener('focus', () => collapse(false));

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $('#tab-watch').hidden = b.dataset.tab !== 'watch';
  $('#tab-plan').hidden = b.dataset.tab !== 'plan';
  collapse(false);
  if (typeof onPlanTab === 'function') onPlanTab(b.dataset.tab === 'plan');
}));

// ---------- 啟動 ----------

(async function start() {
  if (typeof DecompressionStream === 'undefined') {
    setStatus('瀏覽器版本太舊,請更新(iOS 16.4 以上)', true);
    return;
  }
  renderWatch();
  try {
    await loadRoutes();
  } catch (e) {
    setStatus('路線資料下載失敗,請重新整理', true);
    return;
  }
  watch = watch.filter((w) => routes[w.k]);   // 路線已停駛就移除
  saveWatch();
  renderWatch();
  renderResults();
  if (watch.length) loadStops();
  poll();
})();
