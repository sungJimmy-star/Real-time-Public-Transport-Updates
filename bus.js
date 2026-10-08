'use strict';

// 等公車(參考「台北等公車」):路線各站的預估到站時間、常用站牌、附近站牌。
// - 預估到站時間用官方的 GetEstimateTime(跟台北等公車同一個來源),約 20 秒更新一次;
//   車子停在哪一站、剛離開哪一站用 GetBusEvent。
// - 只在畫面用得到時才下載(路線頁、附近站牌、首頁有常用站牌),而且只抓需要的城市。
// - 使用 app.js 的最上層變數(routes、stopData、map、fetchGz…)。自己的東西都包在 BusUI 裡,
//   避免跟 plan.js 的函式撞名。
window.BusUI = (() => {
  const EST_MS = 20000;
  const NEAR_M = 500;          // 附近站牌的範圍(直線距離)
  const NEAR_GROUPS = 12;
  const DEFAULT_COLOR = '#1f62b4';
  const STATUS = { '-1': '尚未發車', '-2': '交管不停靠', '-3': '末班駛離', '-4': '今日未營運' };
  const BUS_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 4a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v12a2 2 0 0 1-1 1.7V20a1 1 0 0 1-2 0v-2H8v2a1 1 0 0 1-2 0v-2.3A2 2 0 0 1 5 16zm2 2v5h10V6zm1.5 7.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4m7 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4"/></svg>';

  const S = {
    tab: 'watch',
    route: null,                    // 路線頁:{ k, d, s: 選中的站牌, scroll: 要不要捲到選中的站, drawn }
    est: {}, estAt: {}, err: {},    // 城市 → 官方預估、下載時間、上次是否失敗
    ev: {},                         // 城市 → Map('路線|方向' → [{ s: 站牌, on: 停在站上, plate }])
    timer: null, loading: false, again: false,
    favs: LS.get('fav:v1', []),     // 常用站牌 [{ k, d, s, n: 站名 }]
    editing: false,
    near: null,                     // { lat, lon, label, gps, groups: [{ name, dist, lat, lon, items: [{ k, d, s }] }] }
    stopIdx: null,                  // 'tpe:12345' → [[路線 key, 方向], ...]
    stopList: null,
    pos: null,                      // 使用者最後的位置 [緯度, 經度, 時間]
  };

  const colorOf = (k) => watch.find((w) => w.k === k)?.color || DEFAULT_COLOR;
  const stopName = (c, s) => stopData?.stops[`${c}:${s}`]?.[0] || '';

  // ---------- 使用者的位置(路線頁標出「離你最近」的站) ----------

  function lastPos() {
    if (S.pos && Date.now() - S.pos[2] < 10 * 60e3) return S.pos;
    const ll = meMarker?.getLatLng();   // app.js 的「我的位置」按鈕
    return ll ? [ll.lat, ll.lng] : null;
  }

  /** 已經允許過定位才去抓,不會跳出詢問 */
  function quietLocate() {
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
      if (p.state !== 'granted') return;
      navigator.geolocation.getCurrentPosition((g) => {
        S.pos = [g.coords.latitude, g.coords.longitude, Date.now()];
        if (S.route) renderRoute();
      }, () => {}, { maximumAge: 60000, timeout: 10000 });
    }).catch(() => {});
  }

  /** 這條路線這個方向離使用者最近的站(1 公里內) */
  function nearestStop(k, d) {
    const pos = lastPos();
    const r = routes[k];
    const ids = stopData?.lines[k]?.[d];
    if (!pos || !ids) return null;
    const kx = Math.cos(pos[0] * Math.PI / 180);
    let best = null, bd = (1000 / 111000) ** 2;
    for (const s of ids) {
      const p = stopData.stops[`${r.c}:${s}`];
      if (!p) continue;
      const dd = ((p[1] - pos[1]) * kx) ** 2 + (p[2] - pos[0]) ** 2;
      if (dd < bd) { bd = dd; best = s; }
    }
    return best;
  }

  // ---------- 資料 ----------

  function estMap(rows) {
    const m = new Map();
    for (const e of rows) {
      const v = +e.EstimateTime;
      if (Number.isNaN(v)) continue;
      m.set(`${e.RouteID}:${e.StopID}:${e.GoBack}`, v);
      // 尚未發車、末班駛離這些狀態的 GoBack 是 2、3(不分方向),所以另外存一份不分方向的
      const k2 = `${e.RouteID}:${e.StopID}`;
      if (!(m.get(k2) >= 0)) m.set(k2, v);
    }
    return m;
  }

  function evMap(city, rows) {
    const m = new Map();
    const now = Date.now();
    for (const e of rows) {
      if (e.DutyStatus !== '1' || (e.GoBack !== '0' && e.GoBack !== '1')) continue;
      const k = paIndex[city + ':' + e.RouteID];
      if (!k || now - parseTw(e.DataTime) > 30 * 60e3) continue;   // 半小時沒有新事件的車當作已經離線
      const key = k + '|' + e.GoBack;
      (m.get(key) || m.set(key, []).get(key)).push({ s: +e.StopID, on: e.CarOnStop === '1', plate: e.BusID });
    }
    return m;
  }

  const busesOf = (k, d) => S.ev[routes[k]?.c]?.get(k + '|' + d) || [];
  const onStop = (k, d, s) => busesOf(k, d).some((b) => b.on && b.s === s);

  /** 官方預估:秒數;負數是狀態(見 STATUS);undefined = 沒有資料 */
  function estOf(k, d, s) {
    const m = S.est[routes[k]?.c];
    if (!m) return undefined;
    const id = k.split(':')[1];
    const v = m.get(`${id}:${s}:${d}`);
    return v !== undefined ? v : m.get(`${id}:${s}`);
  }

  /** [文字, 樣式] */
  function badge(k, d, s) {
    if (onStop(k, d, s)) return ['進站中', 'e-now'];
    const v = estOf(k, d, s);
    if (v === undefined) return [S.est[routes[k]?.c] ? '--' : '…', 'e-off'];
    if (v >= 0) {
      if (v < 60) return ['將到站', 'e-soon'];
      const m = Math.floor(v / 60);
      return [m + ' 分', m <= 5 ? 'e-near' : 'e-min'];
    }
    return [STATUS[v] || '--', 'e-off'];
  }
  const etaHtml = ([t, cls]) => `<span class="eta ${cls}">${t}</span>`;

  /** 排序用:進站中 < 秒數 < 尚未發車 < 交管不停靠 < 末班駛離 < 今日未營運 < 沒資料 */
  function rank(k, d, s) {
    if (onStop(k, d, s)) return -1;
    const v = estOf(k, d, s);
    if (v === undefined) return 3e6;
    return v >= 0 ? v : 1e6 - v;
  }

  /** 現在畫面需要哪些城市的到站資料 */
  function cities() {
    let ks = [];
    if (S.route) ks = [S.route.k];
    else if (S.tab === 'near') ks = S.near ? S.near.groups.flatMap((g) => g.items.map((x) => x.k)) : [];
    else if (S.tab === 'watch') ks = S.favs.map((f) => f.k);
    return [...new Set(ks.map((k) => routes[k]?.c).filter(Boolean))];
  }

  async function refresh() {
    clearTimeout(S.timer);
    S.timer = null;
    const cs = cities();
    if (!cs.length || document.hidden) return;
    S.timer = setTimeout(refresh, EST_MS);
    if (S.loading) { S.again = true; return; }
    S.loading = true;
    try {
      await Promise.all(cs.map(async (c) => {
        const [est, ev] = await Promise.allSettled([
          fetchGz(FEEDS[c].base + 'GetEstimateTime.gz', true),
          fetchGz(FEEDS[c].base + 'GetBusEvent.gz', true),
        ]);
        if (est.status === 'fulfilled') { S.est[c] = estMap(est.value.BusInfo); S.estAt[c] = Date.now(); delete S.err[c]; }
        else S.err[c] = true;
        if (ev.status === 'fulfilled') S.ev[c] = evMap(c, ev.value.BusInfo);
      }));
    } finally {
      S.loading = false;
    }
    render();
    if (S.again) { S.again = false; ensure(); }
  }

  /** 換畫面時:需要的資料太舊就馬上抓,否則照原本的時間表更新 */
  function ensure() {
    render();
    const cs = cities();
    if (!cs.length) return;
    const ages = cs.map((c) => Date.now() - (S.estAt[c] || 0));
    if (Math.max(...ages) >= EST_MS - 1000) refresh();
    else if (!S.timer) S.timer = setTimeout(refresh, EST_MS - Math.max(...ages));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensure(); });

  function updText() {
    const cs = cities();
    if (!cs.length) return '';
    if (cs.some((c) => S.err[c] && !S.est[c])) return '到站時間暫時抓不到,稍後自動重試';
    const at = Math.min(...cs.map((c) => S.estAt[c] || 0));
    if (!at) return '載入到站時間…';
    const sec = Math.round((Date.now() - at) / 1000);
    return (cs.some((c) => S.err[c]) ? '連線不穩・' : '') + `官方預估,${sec < 5 ? '剛剛' : sec + ' 秒前'}更新`;
  }
  function renderUpd() {
    const t = updText();
    for (const id of ['rt-upd', 'favs-upd', 'near-upd']) $('#' + id).textContent = t;
  }
  setInterval(() => { if (!document.hidden) renderUpd(); }, 1000);

  function render() {
    if (S.route) renderRoute();
    else if (S.tab === 'near') renderNear();
    renderFavs();
    renderUpd();
  }

  // ---------- 地圖 ----------

  /** 把某一點移到地圖沒被面板蓋住的範圍中間 */
  function showPoint(lat, lon, minZoom) {
    const s = $('#sheet').getBoundingClientRect();
    const z = Math.max(map.getZoom(), minZoom);
    const off = window.innerWidth >= 768 ? L.point(-s.right / 2, 0) : L.point(0, (window.innerHeight - s.top) / 2);
    map.setView(map.unproject(map.project([lat, lon], z).add(off), z), z);
  }

  /** 地圖沒被面板蓋住的範圍的中心 */
  function visibleCenter() {
    const s = $('#sheet').getBoundingClientRect();
    const size = map.getSize();
    const pt = window.innerWidth >= 768 ? L.point((s.right + size.x) / 2, size.y / 2) : L.point(size.x / 2, Math.max(80, s.top) / 2);
    return map.containerPointToLatLng(pt);
  }

  const focusLayer = L.layerGroup().addTo(map);
  let selMk = null;

  /** 路線頁:畫這個方向的路線和站牌 */
  function drawFocus(fit) {
    focusLayer.clearLayers();
    selMk = null;
    const R = S.route;
    const r = R && routes[R.k];
    const ids = r && stopData?.lines[R.k]?.[R.d];
    if (!ids?.length) return;
    const color = colorOf(R.k);
    R.drawn = color + '|' + R.d;
    const pts = ids.map((s) => { const p = stopData.stops[`${r.c}:${s}`]; return p && [p[2], p[1]]; });
    const sh = shapeOf(R.k, R.d);
    const line = sh ? sh.pts : pts.filter(Boolean);
    L.polyline(line, { color: '#fff', weight: 10, opacity: 0.9, interactive: false }).addTo(focusLayer);
    L.polyline(line, { color, weight: 6, opacity: 0.9, interactive: false }).addTo(focusLayer);
    ids.forEach((s, i) => {
      if (!pts[i]) return;
      L.circleMarker(pts[i], { renderer: canvas, radius: 5, color, weight: 2.5, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(stopName(r.c, s), { direction: 'top', offset: [0, -5] })
        .on('click', () => selectStop(s, true))
        .addTo(focusLayer);
    });
    if (fit && line.length) map.fitBounds(L.latLngBounds(line), { ...sheetPadding(), maxZoom: 16 });
  }

  function drawSel() {
    if (selMk) { focusLayer.removeLayer(selMk); selMk = null; }
    const R = S.route;
    if (!R || R.s == null) return;
    const r = routes[R.k];
    const p = stopData?.stops[`${r.c}:${R.s}`];
    if (!p) return;
    selMk = L.circleMarker([p[2], p[1]], { radius: 9, color: colorOf(R.k), weight: 4, fillColor: '#fff', fillOpacity: 1, interactive: false })
      .bindTooltip(`${esc(p[0])}・${badge(R.k, R.d, R.s)[0]}`, { permanent: true, direction: 'top', offset: [0, -9], className: 'sel-tip' })
      .addTo(focusLayer);
  }

  // ---------- 路線頁 ----------

  function openRoute(k, d, s) {
    if (!routes[k]) return;
    S.route = { k, d: d ?? 0, s: s ?? null, scroll: s != null, drawn: null, nearDone: -1 };
    if (s == null) quietLocate();
    for (const t of ['watch', 'near', 'plan']) $('#tab-' + t).hidden = true;
    $('#tab-route').hidden = false;
    $('#rt-stops').scrollTop = 0;
    collapse(false);
    syncNearLayer();
    ensure();
    poll();   // app.js:抓這條路線的車子位置(地圖)
    loadStops().then(() => {
      const R = S.route;
      if (R?.k !== k) return;
      drawFocus(R.s == null);
      renderRoute();
      if (R.s != null) {
        const p = stopData?.stops[`${routes[k].c}:${R.s}`];
        if (p) showPoint(p[2], p[1], 16);
      }
    });
  }

  function closeRoute() {
    if (!S.route) return;
    S.route = null;
    focusLayer.clearLayers();
    selMk = null;
    $('#tab-route').hidden = true;
    drawBuses();   // 拿掉這條路線的車(沒有加入地圖的話)
  }

  function back() {
    closeRoute();
    $('#tab-' + currentTab).hidden = false;
    syncNearLayer();
    ensure();
    poll();
  }

  function renderRoute() {
    const R = S.route;
    const r = R && routes[R.k];
    if (!r) return;
    const color = colorOf(R.k);
    $('#tab-route').style.setProperty('--c', color);
    $('#rt-name').textContent = r.n;
    $('#rt-city').textContent = FEEDS[r.c].name;
    $('#rt-sub').textContent = [`${r.d} ↔ ${r.t}`, r.p].filter(Boolean).join('・');
    const pinned = watch.some((w) => w.k === R.k);
    $('#rt-pin').textContent = pinned ? '已加入地圖' : '加入地圖';
    $('#rt-pin').classList.toggle('added', pinned);

    const ln = stopData?.lines[R.k];
    const dirs = [0, 1].filter((d) => !ln || ln[d]?.length);
    if (!dirs.includes(R.d)) R.d = dirs[0] ?? 0;
    $('#rt-dirs').innerHTML = dirs.map((d) => `<button role="tab" data-d="${d}" aria-selected="${d === R.d}">`
      + `<span>${esc(dirText(r, d))}</span><small>${busesOf(R.k, d).length} 台行駛中</small></button>`).join('');

    const box = $('#rt-stops');
    if (!stopData) { box.innerHTML = '<li class="hint">站牌資料載入中…(第一次約 4 MB,之後會快取)</li>'; return; }
    const ids = ln?.[R.d];
    if (!ids?.length) { box.innerHTML = '<li class="hint">這條路線沒有站牌資料</li>'; return; }
    if (R.drawn !== color + '|' + R.d) drawFocus(false);

    const at = new Map();   // 站牌 → 停在這站或剛離開這站的車
    for (const b of busesOf(R.k, R.d)) (at.get(b.s) || at.set(b.s, []).get(b.s)).push(b);
    const favs = new Set(S.favs.filter((f) => f.k === R.k && f.d === R.d).map((f) => f.s));
    const mine = nearestStop(R.k, R.d);
    const drawn = new Set();
    box.innerHTML = ids.map((s, i) => {
      const bs = drawn.has(s) ? [] : at.get(s) || [];   // 環狀路線同一站出現兩次,車只畫在第一次
      drawn.add(s);
      const on = bs.some((b) => b.on), off = bs.some((b) => !b.on);
      const plates = bs.map((b) => `<span class="plate${b.on ? '' : ' off'}">${BUS_SVG}${esc(b.plate)}</span>`).join('');
      return `<li class="stp${R.s === s ? ' sel' : ''}" data-s="${s}" data-i="${i}">${etaHtml(badge(R.k, R.d, s))}`
        + `<span class="tl"><i class="node"></i>${on ? `<i class="veh on">${BUS_SVG}</i>` : ''}${off ? `<i class="veh off">${BUS_SVG}</i>` : ''}</span>`
        + `<span class="nm">${esc(stopName(r.c, s))}${s === mine ? '<span class="near-tag">離你最近</span>' : ''}`
        + `${plates ? `<span class="plates">${plates}</span>` : ''}</span>`
        + `<button class="star${favs.has(s) ? ' on' : ''}" data-act="fav" aria-label="${favs.has(s) ? '移出' : '加入'}常用站牌">${favs.has(s) ? '★' : '☆'}</button></li>`;
    }).join('');
    // 捲到選中的站;沒有選站的話,第一次顯示這個方向時捲到離使用者最近的站
    const target = R.scroll && R.s != null ? R.s : R.s == null && mine != null && R.nearDone !== R.d ? mine : null;
    if (target != null) {
      const row = box.querySelector(`li[data-s="${target}"]`);
      if (row) box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2;
      R.scroll = false;
      if (target === mine) R.nearDone = R.d;
    }
    drawSel();
  }

  function selectStop(s, fromMap) {
    const R = S.route;
    if (!R) return;
    R.s = s;
    R.scroll = fromMap;
    renderRoute();
    if (!fromMap) {
      const p = stopData?.stops[`${routes[R.k].c}:${s}`];
      if (p) showPoint(p[2], p[1], 16);
    }
  }

  $('#rt-back').addEventListener('click', back);
  $('#rt-pin').addEventListener('click', () => {
    const k = S.route?.k;
    if (k) (watch.some((w) => w.k === k) ? removeWatch : addWatch)(k);
  });
  $('#rt-dirs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    if (!b || !S.route || +b.dataset.d === S.route.d) return;
    S.route.d = +b.dataset.d;
    S.route.s = null;
    $('#rt-stops').scrollTop = 0;
    drawFocus(true);
    renderRoute();
  });
  $('#rt-stops').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-s]');
    if (!li || !S.route) return;
    if (e.target.closest('button[data-act="fav"]')) return toggleFav(S.route.k, S.route.d, +li.dataset.s);
    selectStop(+li.dataset.s, false);
  });

  // ---------- 常用站牌 ----------

  const isFav = (k, d, s) => S.favs.some((f) => f.k === k && f.d === d && f.s === s);

  function toggleFav(k, d, s) {
    const i = S.favs.findIndex((f) => f.k === k && f.d === d && f.s === s);
    if (i >= 0) S.favs.splice(i, 1);
    else S.favs.push({ k, d, s, n: stopName(routes[k].c, s) });
    LS.set('fav:v1', S.favs);
    render();
  }

  function renderFavs() {
    const list = S.favs.filter((f) => routes[f.k]);
    if (!list.length) S.editing = false;
    $('#favs-box').hidden = !list.length;
    $('#favs-edit').textContent = S.editing ? '完成' : '編輯';
    $('#favs').innerHTML = list.map((f) => {
      const r = routes[f.k];
      return `<li class="tap" data-k="${esc(f.k)}" data-d="${f.d}" data-s="${f.s}">${etaHtml(badge(f.k, f.d, f.s))}`
        + `<div class="info"><b>${esc(r.n)}</b> <span class="to">${esc(dirText(r, f.d))}</span><small>${esc(f.n)}</small></div>`
        + (S.editing ? `<button class="icon-btn" data-act="rm" aria-label="移除">${ICON_X}</button>` : '') + '</li>';
    }).join('');
    syncHint();
  }

  $('#favs-edit').addEventListener('click', () => { S.editing = !S.editing; renderFavs(); });
  $('#favs').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li) return;
    const [k, d, s] = [li.dataset.k, +li.dataset.d, +li.dataset.s];
    if (e.target.closest('button[data-act="rm"]')) return toggleFav(k, d, s);
    openRoute(k, d, s);
  });

  // ---------- 附近站牌 ----------

  const nearLayer = L.layerGroup();
  function syncNearLayer() {
    if (S.tab === 'near' && !S.route) nearLayer.addTo(map);
    else nearLayer.remove();
  }

  function nearMsg(msg) { $('#near-msg').textContent = msg; $('#near-msg').hidden = !msg; }

  function buildStopIdx() {
    if (S.stopIdx) return;
    S.stopIdx = new Map();
    for (const [k, dirs] of Object.entries(stopData.lines)) {
      const c = k.split(':')[0];
      dirs.forEach((ids, d) => {
        for (const s of ids) {
          const key = c + ':' + s;
          (S.stopIdx.get(key) || S.stopIdx.set(key, []).get(key)).push([k, d]);
        }
      });
    }
    S.stopList = Object.entries(stopData.stops).filter(([key]) => S.stopIdx.has(key));
  }

  function locateNear() {
    nearMsg('定位中…');
    if (!navigator.geolocation) return nearAtCenter('這個瀏覽器不支援定位,先用地圖中心');
    navigator.geolocation.getCurrentPosition(
      (p) => findNear(p.coords.latitude, p.coords.longitude, '目前位置', true),
      () => nearAtCenter('無法取得目前位置(請允許定位權限),先用地圖中心'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  function nearAtCenter(msg) {
    const c = visibleCenter();
    findNear(c.lat, c.lng, '地圖中心', false, msg);
  }

  async function findNear(lat, lon, label, gps, msg = '') {
    if (!stopData) {
      nearMsg('載入站牌資料中…(第一次約 4 MB,之後會快取)');
      await loadStops();
      if (!stopData) return nearMsg('站牌資料下載失敗,請檢查網路後重試');
    }
    buildStopIdx();
    const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
    const byName = new Map();   // 同名的站牌(例如馬路兩邊)合成一組
    for (const [key, [n, x, y]] of S.stopList) {
      const dx = (x - lon) * kx, dy = (y - lat) * ky;
      if (dx > NEAR_M || dx < -NEAR_M || dy > NEAR_M || dy < -NEAR_M) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > NEAR_M) continue;
      const g = byName.get(n) || byName.set(n, { name: n, dist, lat: y, lon: x, stops: [] }).get(n);
      if (dist < g.dist) Object.assign(g, { dist, lat: y, lon: x });
      g.stops.push([key, dist]);
    }
    const groups = [...byName.values()].sort((a, b) => a.dist - b.dist).slice(0, NEAR_GROUPS);
    for (const g of groups) {
      g.stops.sort((a, b) => a[1] - b[1]);
      const seen = new Set();
      g.items = [];
      for (const [key] of g.stops) {
        for (const [k, d] of S.stopIdx.get(key)) {
          if (!routes[k] || seen.has(k + '|' + d)) continue;
          seen.add(k + '|' + d);
          g.items.push({ k, d, s: +key.split(':')[1] });
        }
      }
    }
    S.near = { lat, lon, label, gps, groups: groups.filter((g) => g.items.length) };
    if (gps) S.pos = [lat, lon, Date.now()];
    nearMsg(msg || (S.near.groups.length ? '' : `${NEAR_M} 公尺內沒有公車站牌`));
    $('#near').scrollTop = 0;
    drawNear();
    ensure();
  }

  function drawNear() {
    nearLayer.clearLayers();
    const N = S.near;
    if (!N) return;
    L.marker([N.lat, N.lon], {
      icon: L.divIcon({ className: 'bus-icon', html: `<div class="${N.gps ? 'me' : 'here'}"></div>`, iconSize: [16, 16] }),
      interactive: false, zIndexOffset: 1000,
    }).addTo(nearLayer);
    N.groups.forEach((g, i) => {
      L.circleMarker([g.lat, g.lon], { radius: 7, color: '#fff', weight: 2, fillColor: DEFAULT_COLOR, fillOpacity: 1 })
        .bindTooltip(g.name, { direction: 'top', offset: [0, -7] })
        .on('click', () => {
          const el = $(`#near section[data-g="${i}"]`);
          if (el) $('#near').scrollTop = el.offsetTop;
        })
        .addTo(nearLayer);
    });
    syncNearLayer();
    showPoint(N.lat, N.lon, 16);
  }

  function renderNear() {
    const N = S.near;
    $('#near-where').textContent = N ? `${N.label}附近 ${NEAR_M} 公尺` : '';
    if (!N) { $('#near').innerHTML = ''; return; }
    $('#near').innerHTML = N.groups.map((g, i) => {
      const items = [...g.items].sort((a, b) => rank(a.k, a.d, a.s) - rank(b.k, b.d, b.s));
      return `<section class="ng" data-g="${i}"><h3 class="ng-h" data-g="${i}"><b>${esc(g.name)}</b><small>${Math.max(10, Math.round(g.dist / 10) * 10)} 公尺</small></h3><ul class="list">`
        + items.map((x) => {
          const r = routes[x.k];
          const fav = isFav(x.k, x.d, x.s);
          return `<li class="tap" data-k="${esc(x.k)}" data-d="${x.d}" data-s="${x.s}">${etaHtml(badge(x.k, x.d, x.s))}`
            + `<div class="info"><b>${esc(r.n)}</b> <span class="to">${esc(dirText(r, x.d))}</span></div>`
            + `<button class="star${fav ? ' on' : ''}" data-act="fav" aria-label="${fav ? '移出' : '加入'}常用站牌">${fav ? '★' : '☆'}</button></li>`;
        }).join('') + '</ul></section>';
    }).join('');
  }

  $('#near-gps').addEventListener('click', locateNear);
  $('#near-center').addEventListener('click', () => nearAtCenter(''));
  $('#near').addEventListener('click', (e) => {
    const h = e.target.closest('h3[data-g]');
    if (h) { const g = S.near.groups[+h.dataset.g]; return showPoint(g.lat, g.lon, 17); }
    const li = e.target.closest('li[data-k]');
    if (!li) return;
    const [k, d, s] = [li.dataset.k, +li.dataset.d, +li.dataset.s];
    if (e.target.closest('button[data-act="fav"]')) return toggleFav(k, d, s);
    openRoute(k, d, s);
  });

  // ---------- 給 app.js 呼叫 ----------

  function onTab(name) {
    S.tab = name;
    closeRoute();
    syncNearLayer();
    if (name === 'near' && !S.near) locateNear();
    ensure();
  }

  return {
    start() { renderFavs(); ensure(); },
    render,
    openRoute,
    onTab,
    focus: () => (S.route ? { k: S.route.k, color: colorOf(S.route.k) } : null),
    favCount: () => S.favs.filter((f) => routes[f.k]).length,
  };
})();
