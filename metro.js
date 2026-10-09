'use strict';

// 台北捷運動態圖
// - 路線圖是自己畫的(Leaflet 的 CRS.Simple,座標是「格」),樣式參考台北捷運官方路網圖。
// - 列車位置依時刻表推算:data/rail.json(collector/build_static.py 從 TDX 產生)有每個停靠模式
//   (路線、方向、終點、車種)各站的發車時刻和站間時間。把各站的發車時刻串成一班一班的車,
//   再依時間算出每班車現在在哪兩站之間。文湖線沒有時刻表,用班距推估。
// - 之後接上台北捷運官方即時 API(要申請會員)就改用即時資料,見 README。

const U = 40;                 // 縮放 0 時 1 格 = 40 像素
const TW = 8 * 3600;
const PRE_DEP = 60;           // 起站發車前 1 分鐘就顯示在月台
const TERM_STAY = 60;         // 到終點後再顯示 1 分鐘
const TICK_MS = 1000;
const FONT_PX = 12;           // 站名字體(要跟 style.css 的 .sl 一致,自動排站名用)

// ---------- 路線圖 ----------
// 每條線是幾段路徑,路徑上的站依序排列:[站代碼, x, y] 有座標;只寫站代碼的站平均分布在前後兩個
// 有座標的站之間;['>', x, y] 是轉折點。x 往右、y 往下,單位是格。橫向的線站距 1.5 格(站名放上下),
// 直向、斜向的線 1 格(站名放左右)。同一個座標的站畫成一個轉乘站。
const LAYOUT = {
  BL: [[
    ['BL01', -7, 10], ['BL02', -7, 9], ['BL03', -7, 8], ['BL04', -7, 7], ['BL05', -7, 6], ['BL06', -7, 5],
    ['BL07', -7, 4], ['BL08', -6, 3], ['BL09', -5, 2], ['BL10', -4, 1], ['BL11', -3, 0], ['BL12', 0, 0],
    ['BL13', 1.5, 0], ['BL14', 3, 0], ['BL15', 6, 0], ['BL16', 7.5, 0], ['BL17', 9, 0], ['BL18', 10.5, 0],
    ['BL19', 12, 0], ['BL20', 13.5, 0], ['BL21', 15, 0], ['BL22', 16.5, 0], ['BL23', 18, 0],
  ]],
  R: [[
    ['R01', 12, 2], ['R02', 10.5, 2], ['R03', 9, 2], ['R04', 7.5, 2], ['R05', 6, 2], ['R06', 4.5, 2], ['R07', 3, 2],
    ['R08', 0, 2], ['R09', 0, 1], ['R10', 0, 0], ['R11', 0, -2], ['R12', 0, -3], ['R13', 0, -4], ['R14', 0, -5],
    ['R15', 0, -6], ['R16', 0, -7], ['R17', 0, -8], ['R18', 0, -9], ['R19', 0, -10], ['R20', -1, -11],
    ['R21', -2, -12], ['R22', -3, -13], ['R23', -4, -14], ['R24', -5, -15], ['R25', -6, -16], ['R26', -7, -17],
    ['R27', -8, -18], ['R28', -9, -19],
  ], [['R22', -3, -13], ['R22A', -2, -14]]],
  G: [[
    ['G01', 1.5, 11.5], ['G02', 1.5, 10.5], ['G03', 1.5, 9.5], ['G04', 1.5, 8.5], ['G05', 1.5, 7.5], ['G06', 1.5, 6.5],
    ['G07', 1.5, 5.5], ['G08', 1.5, 4.5], ['G09', 1.5, 3.5], ['G10', 0, 2], ['G11', -1.5, 2], ['>', -3, 0.5],
    ['G12', -3, 0], ['G13', -3, -1], ['>', -3, -2], ['G14', 0, -2], ['G15', 3, -2], ['G16', 6, -2], ['G17', 7.5, -2],
    ['G18', 9, -2], ['G19', 10.5, -2],
  ], [['G03', 1.5, 9.5], ['G03A', 0.5, 10.5]]],
  O: [[
    ['O01', -2.5, 7.5], ['O02', -1.5, 6.5], ['O03', -0.5, 5.5], ['O04', 0.5, 4.5], ['O05', 1.5, 3.5], ['O06', 3, 2],
    ['O07', 3, 0], ['O08', 3, -2], ['O09', 3, -3], ['O10', 3, -4], ['O11', 0, -4], ['O12', -1.5, -4], ['O13', -3, -4],
    ['O14', -5, -4], ['O15', -6.5, -4], ['O16', -8, -4], ['O17', -9, -3], ['O18', -10, -2], ['O19', -11, -1],
    ['O20', -12, 0], ['O21', -13, 1],
  ], [['O12', -1.5, -4], ['O50', -2.5, -5], ['O51', -3.5, -6], ['O52', -4.5, -7], ['O53', -5.5, -8], ['O54', -6.5, -9]]],
  BR: [[
    ['BR01', 8, 10], ['BR02', 8, 9], ['BR03', 8, 8], ['BR04', 8, 7], ['BR05', 8, 6], ['BR06', 8, 5], ['BR07', 7, 4],
    ['BR08', 6, 3], ['BR09', 6, 2], ['BR10', 6, 0], ['BR11', 6, -2], ['BR12', 6, -3], ['BR13', 6, -4], ['BR14', 6, -5],
    ['BR15', 6, -6], ['BR16', 7, -7], ['BR17', 8.5, -7], ['BR18', 10, -7], ['BR19', 11.5, -7], ['BR20', 13, -7],
    ['BR21', 14.5, -7], ['BR22', 16, -7], ['BR23', 17, -6], ['>', 18, -5], ['BR24', 18, 0],
  ]],
  Y: [[
    ['Y07', 1.5, 8.5], ['Y08', 0.5, 8.5], 'Y09', 'Y10', ['Y11', -1.5, 6.5], ['Y12', -3, 6.5], ['Y13', -4.5, 6.5],
    ['Y14', -6, 6.5], ['Y15', -6, 5], ['Y16', -7, 4], ['Y17', -7, 3], ['>', -7, -1], ['Y18', -9, -3], ['Y19', -10, -4],
    ['Y20', -10, -5],
  ]],
  A: [[
    ['A1', -1, -1], ['>', -5, -5], ['A2', -6.5, -5], ['A3', -10, -5], ['A4', -11.5, -5], ['A5', -13, -5],
    ['A6', -14.5, -5], ['A7', -16, -5], ['A8', -17.5, -5], ['A9', -19, -5], ['A10', -20.5, -5], ['A11', -22, -5],
    ['A12', -23.5, -5], ['A13', -25, -5], ['A14a', -26, -4], ['A15', -26, -3], ['A16', -26, -2], ['A17', -26, -1],
    ['A18', -26, 0], ['A19', -26, 1], ['A20', -26, 2], ['A21', -26, 3], ['A22', -26, 4],
  ]],
  LB: [[
    ['LB01', -7, 10], ['LB02', -8, 11], ['LB03', -9, 12], ['LB04', -10, 13], ['LB05', -11, 14], ['LB06', -12, 15],
    ['LB07', -13, 16], ['LB08', -14.5, 16], ['LB09', -16, 16], ['LB10', -17.5, 16], ['LB11', -19, 16], ['LB12', -20.5, 16],
  ]],
  K: [[
    ['K01', -0.5, 16.5], ['K02', -0.5, 15.5], ['K03', -0.5, 14.5], ['K04', -0.5, 13.5], ['K05', -0.5, 12.5],
    ['K06', -0.5, 11.5], ['K07', -0.5, 10.5], ['K08', -0.5, 9.5], ['K09', 0.5, 8.5],
  ]],
  V: [[
    ['V01', -8, -18], ['V02', -7, -19], ['V03', -7, -20], ['V04', -7, -21], ['V05', -7, -22], ['V06', -7, -23],
    ['V07', -7, -24], ['V08', -8, -25], ['V09', -9, -26], ['V10', -9, -27], ['V11', -9, -28],
  ], [['V09', -9, -26], ['V28', -10, -25], ['V27', -10, -24], ['V26', -10, -23]]],
};
// 圖上的順序:先畫的在下面
const LINE_ORDER = ['K', 'V', 'LB', 'A', 'Y', 'BR', 'O', 'G', 'R', 'BL'];
const LIGHT = new Set(['K', 'V']);        // 輕軌畫細一點
// 不同座標、但可以轉乘的站:畫一條連接線
const CONNECT = [['A1', 'R10'], ['BL08', 'Y17'], ['A2', 'O15']];
const NO_LABEL = new Set(['A1', 'A2']);   // 旁邊的轉乘站已經有站名

// ---------- 小工具 ----------

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
};
const nowSec = () => Date.now() / 1000;
const twDate = (t) => new Date((t + TW) * 1000);            // 用 getUTC* 讀出台灣時間
const hhmm = (t) => twDate(t).toISOString().slice(11, 16);
const toLL = (x, y) => L.latLng(-y * U, x * U);

/** 營運日:凌晨 4 點前算前一天。{ start: 營運日 0 點(epoch 秒), wd: 0=星期一 … 6=星期日 } */
function serviceDay(t) {
  const d = twDate(t - 4 * 3600);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - TW, wd: (d.getUTCDay() + 6) % 7 };
}

let RAIL = null;               // data/rail.json
const STN = {};                // 站代碼 → { id, x, y, line, g: 所屬的實體站 }
const GROUPS = [];             // 實體站(同一個座標的站合在一起):{ ids, x, y, name, lines, xfer }
const PATHS = {};              // 線 → [{ pts: [{x, y}], cum: [累計長度], at: Map(站 → 在路徑上的距離) }]

function stName(id) {
  const n = RAIL.st[id]?.[0] || id;
  return n.endsWith('站') && !n.endsWith('車站') ? n.slice(0, -1) : n;
}
const lineName = (l) => RAIL.lines[l]?.[0] || l;
const lineColor = (l) => RAIL.lines[l]?.[1] || '#888';

// ---------- 建立路線圖的幾何資料 ----------

function resolvePath(line, entries) {
  const items = entries.map((e) => {
    if (typeof e === 'string') return { id: e };
    if (e[0] === '>') return { via: true, x: e[1], y: e[2] };
    return { id: e[0], x: e[1], y: e[2] };
  });
  // 沒座標的站:沿著前後兩個有座標的站之間的折線平均分布
  for (let i = 0; i < items.length; i++) {
    if (items[i].x !== undefined) continue;
    let a = i - 1;
    while (items[a].x === undefined || items[a].via) a--;
    let b = i + 1;
    while (items[b].x === undefined || items[b].via) b++;
    const poly = items.slice(a, b + 1).filter((it) => it.x !== undefined);
    const free = items.slice(a + 1, b).filter((it) => it.x === undefined);
    const cum = [0];
    for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + Math.hypot(poly[k].x - poly[k - 1].x, poly[k].y - poly[k - 1].y));
    free.forEach((it, j) => {
      const p = pointAt(poly, cum, (cum[cum.length - 1] * (j + 1)) / (free.length + 1));
      it.x = p.x;
      it.y = p.y;
    });
  }
  const pts = items.map((it) => ({ x: it.x, y: it.y }));
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  const at = new Map();
  items.forEach((it, k) => {
    if (it.via) return;
    at.set(it.id, cum[k]);
    STN[it.id] ??= { id: it.id, x: it.x, y: it.y, line };
  });
  return { pts, cum, at };
}

/** 折線上距離起點 d 的點,以及那一段的方向(弧度,畫面座標) */
function pointAt(pts, cum, d) {
  let k = 1;
  while (k < pts.length - 1 && cum[k] < d) k++;
  const a = pts[k - 1], b = pts[k];
  const len = cum[k] - cum[k - 1] || 1;
  const f = Math.max(0, Math.min(1, (d - cum[k - 1]) / len));
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dir: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** 同一條線上兩站之間沿著路線圖的折線(a → b 的方向) */
const segCache = new Map();
function segment(line, a, b) {
  const key = line + '|' + a + '|' + b;
  if (segCache.has(key)) return segCache.get(key);
  let out = null;
  for (const P of PATHS[line] || []) {
    if (!P.at.has(a) || !P.at.has(b)) continue;
    const da = P.at.get(a), db = P.at.get(b);
    const lo = Math.min(da, db), hi = Math.max(da, db);
    const pts = [pointAt(P.pts, P.cum, lo)];
    for (let k = 0; k < P.pts.length; k++) if (P.cum[k] > lo && P.cum[k] < hi) pts.push(P.pts[k]);
    pts.push(pointAt(P.pts, P.cum, hi));
    if (da > db) pts.reverse();
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
    out = { pts, cum, len: cum[cum.length - 1] };
    break;
  }
  segCache.set(key, out);
  return out;
}

function buildGeometry() {
  for (const line of LINE_ORDER) PATHS[line] = (LAYOUT[line] || []).map((e) => resolvePath(line, e));
  const byPos = new Map();
  for (const s of Object.values(STN)) {
    const key = s.x.toFixed(2) + ',' + s.y.toFixed(2);
    let g = byPos.get(key);
    if (!g) { g = { ids: [], x: s.x, y: s.y, lines: [], xfer: false }; byPos.set(key, g); GROUPS.push(g); }
    g.ids.push(s.id);
    if (!g.lines.includes(s.line)) g.lines.push(s.line);
    s.g = g;
  }
  const ends = new Set();       // 路徑的兩端(終點站、支線的端點):拉遠時也顯示站名
  for (const line of LINE_ORDER) {
    for (const e of LAYOUT[line] || []) {
      const ids = e.map((x) => (typeof x === 'string' ? x : x[0])).filter((x) => x !== '>');
      ends.add(ids[0]);
      ends.add(ids[ids.length - 1]);
    }
  }
  for (const g of GROUPS) {
    g.name = stName(g.ids[0]);
    g.xfer = g.lines.length > 1;
    g.end = g.ids.some((id) => ends.has(id));
  }
  for (const [a, b] of CONNECT) {
    if (STN[a] && STN[b]) { STN[a].g.xfer = true; STN[b].g.xfer = true; }
  }
}

// ---------- 自動排站名:依序試右、左、上、下(橫線先試上下),選不會壓到線、站、其他站名的位置 ----------

function textWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? FONT_PX : FONT_PX * 0.58;
  return (w + 4) / U;
}

function placeLabels() {
  const segs = [];
  for (const line of LINE_ORDER) {
    for (const P of PATHS[line]) for (let k = 1; k < P.pts.length; k++) segs.push([P.pts[k - 1], P.pts[k]]);
  }
  for (const [a, b] of CONNECT) if (STN[a] && STN[b]) segs.push([STN[a], STN[b]]);
  const placed = [];
  const hitSeg = (r, [p, q]) => {
    // 線段跟方框有沒有交集:先排除完全在一邊的情況,再看四個角是否在線段兩側
    if (Math.max(p.x, q.x) < r[0] || Math.min(p.x, q.x) > r[2] || Math.max(p.y, q.y) < r[1] || Math.min(p.y, q.y) > r[3]) return false;
    const side = (x, y) => Math.sign((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x));
    const s = [side(r[0], r[1]), side(r[2], r[1]), side(r[0], r[3]), side(r[2], r[3])];
    return !(s.every((v) => v > 0) || s.every((v) => v < 0));
  };
  // 站名之間至少留一點空隙,不然兩個站名會連在一起讀
  const hitBox = (a, b) => !(a[2] + 0.15 <= b[0] || a[0] >= b[2] + 0.15 || a[3] + 0.05 <= b[1] || a[1] >= b[3] + 0.05);
  const order = [...GROUPS].sort((a, b) => (b.xfer - a.xfer) || 0);
  for (const g of order) {
    if (g.ids.every((id) => NO_LABEL.has(id))) { g.lab = null; continue; }
    const w = textWidth(g.name), h = 15 / U;
    const gap = ((g.xfer ? 11 : 9) + 1) / U, d = Math.round((g.xfer ? 11 : 9) * 0.6) / U;
    // 這站有橫向的線經過時,站名先試上下;四個方向都有線時才放斜角
    const horiz = segs.some(([p, q]) => p.y === q.y && Math.abs(p.y - g.y) < 1e-6 && Math.min(p.x, q.x) <= g.x + 1e-6 && Math.max(p.x, q.x) >= g.x - 1e-6);
    const cands = (horiz ? ['t', 'b', 'r', 'l'] : ['r', 'l', 't', 'b']).concat(['ur', 'dr', 'ul', 'dl']);
    let best = null;
    for (const [i, side] of cands.entries()) {
      const r = {
        r: [g.x + gap, g.y - h / 2, g.x + gap + w, g.y + h / 2],
        l: [g.x - gap - w, g.y - h / 2, g.x - gap, g.y + h / 2],
        t: [g.x - w / 2, g.y - gap - h, g.x + w / 2, g.y - gap],
        b: [g.x - w / 2, g.y + gap, g.x + w / 2, g.y + gap + h],
        ur: [g.x + d, g.y - d - h, g.x + d + w, g.y - d],
        ul: [g.x - d - w, g.y - d - h, g.x - d, g.y - d],
        dr: [g.x + d, g.y + d, g.x + d + w, g.y + d + h],
        dl: [g.x - d - w, g.y + d, g.x - d, g.y + d + h],
      }[side];
      let score = i * 0.1;
      for (const s of segs) if (hitSeg(r, s)) score += 10;
      for (const b of placed) if (hitBox(r, b)) score += 10;
      for (const o of GROUPS) {
        if (o === g) continue;
        if (o.x > r[0] - 0.2 && o.x < r[2] + 0.2 && o.y > r[1] - 0.2 && o.y < r[3] + 0.2) score += 5;
      }
      if (!best || score < best.score) best = { side, r, score };
    }
    g.lab = best.side;
    placed.push(best.r);
  }
}

// ---------- 地圖 ----------

const map = L.map('map', {
  crs: L.CRS.Simple, minZoom: -2.5, maxZoom: 3, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
  attributionControl: false, zoomControl: false,
});
L.control.zoom({ position: 'topright' }).addTo(map);
map.createPane('links').style.zIndex = 410;
map.createPane('lines').style.zIndex = 420;
map.createPane('stations').style.zIndex = 430;
map.createPane('labels').style.zIndex = 440;
map.createPane('trains').style.zIndex = 620;

const lineLayers = {};          // 線 → [polyline]
const stationLayers = [];       // [{ g, mk, lb: 站名標記 }]

// 轉乘站的框線、站的底色用 CSS 變數(深色模式),SVG 屬性不吃 var(),所以用 className 讓 CSS 蓋過去
function drawMap() {
  for (const [a, b] of CONNECT) {
    if (!STN[a] || !STN[b]) continue;
    L.polyline([toLL(STN[a].x, STN[a].y), toLL(STN[b].x, STN[b].y)], { pane: 'links', className: 'link', color: '#333', weight: 6, interactive: false }).addTo(map);
  }
  for (const line of LINE_ORDER) {
    lineLayers[line] = PATHS[line].map((P) => L.polyline(P.pts.map((p) => toLL(p.x, p.y)), {
      pane: 'lines', color: lineColor(line), weight: LIGHT.has(line) ? 4 : 6, lineJoin: 'round', lineCap: 'round', interactive: false,
    }).addTo(map));
  }
  for (const g of GROUPS) {
    const ll = toLL(g.x, g.y);
    const mk = L.circleMarker(ll, {
      pane: 'stations', className: g.xfer ? 'stn xf' : 'stn', radius: g.xfer ? 6 : 4,
      color: g.xfer ? '#333' : lineColor(g.lines[0]), weight: g.xfer ? 2.5 : 2, fillColor: '#fff', fillOpacity: 1, interactive: false,
    }).addTo(map);
    // 站很小不好點,另外放一個透明的大圓接點擊
    L.circleMarker(ll, { pane: 'stations', radius: 14, stroke: false, fill: true, fillOpacity: 0, bubblingMouseEvents: false })
      .on('click', () => selectStation(g)).addTo(map);
    let lb = null;
    if (g.lab) {
      const cls = `sl sl-${g.lab}${g.xfer ? ' sx' : ''}${g.end ? ' end' : ''}`;
      const gap = g.xfer ? 11 : 9;
      lb = L.marker(ll, {
        pane: 'labels',
        icon: L.divIcon({
          className: 'sl-icon', iconSize: [0, 0],
          html: `<span class="${cls}" style="--g:${gap}px;--d:${Math.round(gap * 0.6)}px">${esc(g.name)}</span>`,
        }),
      }).on('click', () => selectStation(g)).addTo(map);
    }
    stationLayers.push({ g, mk, lb });
  }
}

// 縮放時調整線的粗細,拉遠時只顯示轉乘站和終點站的站名
function syncZoom() {
  const z = map.getZoom();
  const f = Math.max(0.55, Math.min(1.6, 2 ** (z / 2)));
  for (const [line, ls] of Object.entries(lineLayers)) for (const pl of ls) pl.setStyle({ weight: (LIGHT.has(line) ? 4 : 6) * f });
  for (const { g, mk } of stationLayers) mk.setRadius((g.xfer ? 6 : 4) * Math.max(0.7, f));
  const c = map.getContainer();
  c.classList.toggle('z-far', z < -0.6);       // 只顯示轉乘站、終點站
  c.classList.toggle('z-very-far', z < -1.1);  // 只顯示終點站
  c.style.setProperty('--tk', Math.max(0.7, Math.min(1.4, f)).toFixed(2));
  tick();
}
map.on('zoomend', syncZoom);
map.on('moveend', () => { const c = map.getCenter(); LS.set('mview:v1', { c: [c.lat, c.lng], z: map.getZoom() }); });

// ---------- 列車:依時刻表推算 ----------

let DAY = null;               // 現在的營運日
let TRIPS = [];               // [{ id, p, i0, times: [各站發車時間(營運日秒數),終點是到站時間], fq }]

function buildTrips(day) {
  const trips = [];
  RAIL.pats.forEach((p, pi) => {
    if (!PATHS[p.l]) return;
    const n = p.s.length;
    const list = [];
    if (p.dep) {
      const masks = Object.keys(p.dep).filter((m) => m[day.wd] === '1');
      if (!masks.length) return;
      const deps = [];
      for (let i = 0; i < n - 1; i++) deps[i] = masks.flatMap((m) => p.dep[m][i] || []).map((x) => x * 60).sort((a, b) => a - b);
      // 預計時間用時刻表本身的站間差(各班車在前後兩站時刻差的中位數)。TDX 的站間時間有時跟時刻表
      // 差很多,少數站(例如環狀線中和)的時刻甚至跟前一站一樣,用站間時間會串不起來、同一班車變成兩班
      const acc = [0];
      for (let i = 1; i < n - 1; i++) acc[i] = acc[i - 1] + (medianGap(deps[i - 1], deps[i]) ?? p.off[i] - p.off[i - 1]);
      // 各站的發車時刻串成一班一班的車:跟已經在跑的車的預計時間對得上(±90 秒)就是同一班;
      // 剩下的再跟還沒對到的車用 ±5 分鐘配一次(有些班次會在某站多停幾分鐘,例如中和新蘆線東門);
      // 還是對不上的,才是從這一站開始的車(清晨各站同時發車、短程車)
      const take = (e, i, s) => { e.used = true; e.t.times[i] = s; e.t.lastI = i; e.t.lastT = s; };
      for (let i = 0; i < n - 1; i++) {
        const exp = list.map((t) => ({ t, at: t.lastT + acc[i] - acc[t.lastI], used: false })).sort((a, b) => a.at - b.at);
        const rest = [];
        let j = 0;
        for (const s of deps[i]) {
          while (j < exp.length && exp[j].at < s - 90) j++;
          if (j < exp.length && exp[j].at <= s + 90) take(exp[j++], i, s);
          else rest.push(s);
        }
        for (const s of rest) {
          let best = null;
          for (const e of exp) {
            if (!e.used && Math.abs(e.at - s) <= 300 && (!best || Math.abs(e.at - s) < Math.abs(best.at - s))) best = e;
          }
          if (best) { take(best, i, s); continue; }
          const t = { i0: i, times: [], lastI: i, lastT: s };
          t.times[i] = s;
          list.push(t);
        }
      }
    } else if (p.fq) {
      const mask = Object.keys(p.fq).find((m) => m[day.wd] === '1');
      for (const [a, b, hw] of p.fq[mask] || []) {
        for (let s = a * 60; s < b * 60; s += hw) {
          const t = { i0: 0, times: [], fq: true };
          t.times[0] = s;
          list.push(t);
        }
      }
    }
    for (const t of list) {
      const T = t.times;
      // 不合理的時刻(跟站間時間比起來太短或太長)不用,改用前後站內插
      let prev = t.i0;
      for (let i = t.i0 + 1; i < n - 1; i++) {
        if (T[i] === undefined) continue;
        const want = p.off[i] - p.off[prev], got = T[i] - T[prev];
        if (got < want * 0.5 - 30 || got > want * 2 + 120) { T[i] = undefined; continue; }
        prev = i;
      }
      // 沒有時刻的站:夾在兩個有時刻的站中間就依站間時間比例內插,後面沒有了就用站間時間往後推;
      // 終點是到站時間
      let a = t.i0;
      for (let i = t.i0 + 1; i < n - 1; i++) {
        if (T[i] === undefined) continue;
        for (let k = a + 1; k < i; k++) T[k] = T[a] + (T[i] - T[a]) * (p.off[k] - p.off[a]) / (p.off[i] - p.off[a] || 1);
        a = i;
      }
      for (let k = a + 1; k < n; k++) T[k] = T[a] + p.off[k] - p.off[a];
      trips.push({ id: `${pi}:${t.i0}:${T[t.i0]}`, p: pi, i0: t.i0, times: T, fq: !!t.fq });
    }
  });
  return trips;
}

/** 兩站時刻表的站間差(秒):a 站每班車之後 b 站最近一班的時間差,取中位數 */
function medianGap(a, b) {
  const gaps = [];
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j] < x) j++;
    if (j < b.length && b[j] - x <= 900) gaps.push(b[j] - x);
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  return gaps[gaps.length >> 1];
}

/** 這班車在時間 t(營運日秒數)的狀態;不在路線上回傳 null */
function tripState(tr, t) {
  const p = RAIL.pats[tr.p];
  const n = p.s.length;
  const T = tr.times;
  if (t < T[tr.i0] - PRE_DEP || t > T[n - 1] + TERM_STAY) return null;
  if (t < T[tr.i0]) return { at: tr.i0, k: tr.i0, f: 0, mode: 'wait' };
  if (t >= T[n - 1]) return { at: n - 1, k: n - 2, f: 1, mode: 'end' };
  let k = tr.i0;
  while (k < n - 2 && T[k + 1] <= t) k++;
  const seg = p.off[k + 1] - p.off[k];
  const avail = T[k + 1] - T[k];
  // 站間時間含停站時間:先開過去,剩下的時間停在下一站(最後一段到終點就直接開到底)
  const run = k + 1 === n - 1 ? avail : Math.max(Math.min(avail * 0.8, 20), Math.min(seg - Math.min(30, seg * 0.25), avail - 10));
  const e = t - T[k];
  if (e < run) return { k, f: e / run, mode: 'run', eta: T[k] + run };
  return { at: k + 1, k, f: 1, mode: 'stop' };
}

// 列車標記:往行進方向的右邊偏移一點,兩個方向的車才不會疊在一起
const trainMarkers = new Map();
let selTrain = null;          // 選中的列車 id
let selStation = null;        // 選中的實體站
let focusLine = null;         // 只看某一條線

function trainPos(p, st) {
  const a = p.s[st.k], b = p.s[st.k + 1];
  const sg = b ? segment(p.l, a, b) : null;
  let x, y, dir;
  if (!sg) {
    const s = STN[p.s[st.at ?? st.k]];
    return { x: s.x, y: s.y, dir: 0 };
  }
  ({ x, y, dir } = pointAt(sg.pts, sg.cum, sg.len * st.f));
  if (st.mode === 'wait') ({ dir } = pointAt(sg.pts, sg.cum, 0));
  return { x, y, dir };
}

function tick() {
  if (!RAIL) return;
  const now = nowSec();
  const day = serviceDay(now);
  if (!DAY || DAY.start !== day.start) { DAY = day; TRIPS = buildTrips(day); }
  const t = now - DAY.start;
  const z = map.getZoom();
  const off = 5 * Math.max(0.7, Math.min(1.4, 2 ** (z / 2)));   // 偏移幾像素
  const seen = new Set();
  let running = 0;
  for (const tr of TRIPS) {
    const st = tripState(tr, t);
    if (!st) continue;
    const p = RAIL.pats[tr.p];
    running++;
    const pos = trainPos(p, st);
    // 在畫面座標上往行進方向的右邊偏移
    const pt = map.project(toLL(pos.x, pos.y), z).add(L.point(-Math.sin(pos.dir) * off, Math.cos(pos.dir) * off));
    const ll = map.unproject(pt, z);
    let m = trainMarkers.get(tr.id);
    const deg = Math.round(pos.dir * 180 / Math.PI);
    if (!m) {
      m = L.marker(ll, { pane: 'trains', icon: trainIcon(p, tr, deg), keyboard: false });
      m.on('click', () => selectTrain(tr.id));
      m.addTo(map);
      m.deg = deg;
      trainMarkers.set(tr.id, m);
    } else {
      m.setLatLng(ll);
      if (m.deg !== deg) {
        m.deg = deg;
        const el = m.getElement()?.querySelector('.tr');
        if (el) el.style.transform = `rotate(${deg}deg)`;
      }
    }
    m.getElement()?.classList.toggle('dim', !!focusLine && focusLine !== p.l);
    m.getElement()?.classList.toggle('sel', selTrain === tr.id);
    m.tr = tr;
    m.st = st;
    seen.add(tr.id);
  }
  for (const [id, m] of trainMarkers) if (!seen.has(id)) { m.remove(); trainMarkers.delete(id); }
  if (selTrain && !seen.has(selTrain)) selTrain = null;
  $('#clock').textContent = twDate(now).toISOString().slice(11, 19);
  $('#count').textContent = running ? `${running} 班列車行駛中` : '目前沒有列車行駛';
  renderCard(t);
}

function trainIcon(p, tr, deg) {
  const express = p.l === 'A' && p.tt === 2;
  const html = `<div class="tr${LIGHT.has(p.l) ? ' lrt' : ''}${express ? ' exp' : ''}" style="--c:${lineColor(p.l)};transform:rotate(${deg}deg)"><i></i></div>`;
  return L.divIcon({ className: 'tr-icon', html, iconSize: [0, 0] });
}

// ---------- 資訊卡 ----------

function selectTrain(id) {
  selTrain = id;
  selStation = null;
  tick();
}

function selectStation(g) {
  selStation = g;
  selTrain = null;
  tick();
}

function closeCard() {
  selTrain = null;
  selStation = null;
  tick();
}

const chip = (l) => `<span class="chip" style="--c:${lineColor(l)}">${esc(lineName(l))}</span>`;
const minsFrom = (sec) => (sec < 45 ? '即將進站' : `${Math.round(sec / 60)} 分`);

function renderCard(t) {
  const card = $('#card');
  if (selTrain) {
    const m = trainMarkers.get(selTrain);
    if (!m) { card.hidden = true; return; }
    const tr = m.tr, st = m.st, p = RAIL.pats[tr.p];
    const n = p.s.length;
    const kind = p.l === 'A' ? (p.tt === 2 ? '直達車' : '普通車') : '';
    const after = (sec, done, soon) => (sec < 45 ? soon : `約 ${Math.round(sec / 60)} 分${done}`);
    let now;
    if (st.mode === 'wait') now = `停在 <b>${esc(stName(p.s[tr.i0]))}</b>,${after(tr.times[tr.i0] - t, '後發車', '即將發車')}`;
    else if (st.mode === 'end') now = `已抵達終點 <b>${esc(stName(p.s[n - 1]))}</b>`;
    else if (st.mode === 'stop') now = `停靠 <b>${esc(stName(p.s[st.at]))}</b>`;
    else now = `下一站 <b>${esc(stName(p.s[st.k + 1]))}</b>,${after(st.eta - t, '後到站', '即將到站')}`;
    const left = st.mode === 'end' ? '' : `<p>${hhmm(DAY.start + tr.times[n - 1])} 抵達 ${esc(stName(p.to))}(還有 ${n - 1 - (st.at ?? st.k)} 站)</p>`;
    card.innerHTML = `<button class="x" aria-label="關閉">✕</button>`
      + `<div class="ct">${chip(p.l)}<b>往 ${esc(stName(p.to))}</b>${kind ? `<span class="tag">${kind}</span>` : ''}</div>`
      + `<p>${now}</p>${left}`
      + `<p class="note">${tr.fq ? '這條線沒有時刻表,依班距推估,位置僅供參考' : '依時刻表推算,不含誤點'}</p>`;
    card.hidden = false;
    return;
  }
  if (selStation) {
    const g = selStation;
    const ids = new Set(g.ids);
    // 各方向接下來的車(依時刻表),同一條線、同一個終點、同一車種一組
    const rows = new Map();
    for (const tr of TRIPS) {
      const p = RAIL.pats[tr.p];
      for (let i = tr.i0; i < p.s.length - 1; i++) {
        if (!ids.has(p.s[i])) continue;
        const dt = tr.times[i] - t;
        if (dt < -20 || dt > 3600) continue;
        const key = `${p.l}|${p.to}|${p.tt}`;
        const r = rows.get(key) || rows.set(key, { l: p.l, to: p.to, tt: p.tt, fq: tr.fq, list: [] }).get(key);
        r.list.push(dt);
      }
    }
    const list = [...rows.values()].map((r) => ({ ...r, list: r.list.sort((a, b) => a - b).slice(0, 3) }))
      .sort((a, b) => a.l.localeCompare(b.l) || a.list[0] - b.list[0]);
    const body = list.length
      ? list.map((r) => `<li>${chip(r.l)}<span class="to">往 ${esc(stName(r.to))}${r.l === 'A' ? (r.tt === 2 ? '(直達)' : '(普通)') : ''}</span>`
        + `<span class="next">${r.list.map(minsFrom).join('、')}${r.fq ? '<small>(依班距)</small>' : ''}</span></li>`).join('')
      : '<li class="none">1 小時內沒有列車</li>';
    card.innerHTML = `<button class="x" aria-label="關閉">✕</button>`
      + `<div class="ct"><b>${esc(g.name)}</b>${g.lines.map(chip).join('')}</div>`
      + `<ul class="deps">${body}</ul><p class="note">依時刻表推算,不含誤點</p>`;
    card.hidden = false;
    return;
  }
  card.hidden = true;
}

$('#card').addEventListener('click', (e) => { if (e.target.closest('.x')) closeCard(); });
map.on('click', closeCard);

// ---------- 路線色條:點了只看那條線 ----------

function renderLegend() {
  $('#legend').innerHTML = LINE_ORDER.slice().reverse().filter((l) => RAIL.lines[l]).map((l) =>
    `<button data-l="${l}" style="--c:${lineColor(l)}" aria-pressed="${focusLine === l}">${esc(lineName(l))}</button>`).join('');
}

$('#legend').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-l]');
  if (!b) return;
  focusLine = focusLine === b.dataset.l ? null : b.dataset.l;
  for (const [line, ls] of Object.entries(lineLayers)) for (const pl of ls) pl.setStyle({ opacity: !focusLine || focusLine === line ? 1 : 0.15 });
  for (const { g, mk, lb } of stationLayers) {
    const on = !focusLine || g.lines.includes(focusLine);
    mk.setStyle({ opacity: on ? 1 : 0.15, fillOpacity: on ? 1 : 0.15 });
    lb?.getElement()?.classList.toggle('dim', !on);
  }
  if (focusLine) {
    const pts = PATHS[focusLine].flatMap((P) => P.pts.map((p) => toLL(p.x, p.y)));
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 0.5 });
  }
  renderLegend();
  tick();
});

$('#info-btn').addEventListener('click', () => { $('#about').hidden = !$('#about').hidden; });
$('#about').addEventListener('click', (e) => { if (e.target.closest('.x')) $('#about').hidden = true; });

// ---------- 啟動 ----------

(async function start() {
  try {
    RAIL = await fetch('data/rail.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  } catch {
    $('#count').textContent = '路線資料下載失敗,請重新整理';
    return;
  }
  buildGeometry();
  placeLabels();
  drawMap();
  renderLegend();
  const v = LS.get('mview:v1', null);
  if (v) map.setView(v.c, v.z);
  else map.setView(toLL(3, -1), window.innerWidth >= 768 ? 0.25 : -0.25);
  syncZoom();
  setInterval(() => { if (!document.hidden) tick(); }, TICK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
