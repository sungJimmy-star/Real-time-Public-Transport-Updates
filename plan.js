'use strict';

// 轉乘規劃:在手機上用 RAPTOR 演算法找出公車 + 捷運最快的走法。
// - 公車:每台車目前在哪一站(GetBusEvent)+ 車速模型(model.json)的站間車程 × 這台車最近的快慢係數。
//   還沒發車的班次依班距推估。
// - 捷運、機捷、輕軌:各站時刻表(rail.json);沒有時刻表的線(文湖線)用班距。
// 時間一律用 epoch 秒;時段、星期都用台灣時間判斷,不受手機時區影響。

const WALK_MPS = 1.15;            // 走路速度(公尺/秒,約每分鐘 70 公尺)
const DETOUR = 1.3;               // 實際步行距離 ≈ 直線距離 × 1.3
const ACCESS_M = 800;             // 起點、終點最多走多遠到站(直線距離)
const XFER_M = 400;               // 轉乘最多走多遠
const WALK_ONLY_M = 2500;         // 這個距離以內也列出「直接走路」
const RAIL_IN = 180;              // 進站走到月台(秒)
const RAIL_OUT = 120;             // 月台走到出口
const SLACK = 60;                 // 上車前至少提早 1 分鐘到
const MAX_ROUNDS = 4;             // 最多搭幾段車(捷運換線也算一段)
const HORIZON = 3 * 3600;         // 只推算 3 小時內的班次
const TW = 8 * 3600;
const EV_MS = 15000;              // 規劃中每 15 秒更新公車位置
const REPLAN_MS = 30000;

const PL = {
  ready: false, loading: null, model: null, rail: null,
  N: 0, lat: null, lon: null, kind: null, name: [], key: [], idx: new Map(), exits: [], railId: [],
  grid: new Map(), pats: [], stopPats: [], busPat: new Map(), xfer: new Map(), nb: new Map(),
  veh: new Map(), vehByPid: new Map(), evAt: 0, est: {}, estAt: 0,
  from: null, to: null, results: [], sel: null, timer: null, lastPlan: 0, active: false,
  places: null, field: 'to',
};

// ---------- 小工具 ----------

function distM(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 360 * Math.PI);
  const y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * 6371000;
}
const walkSec = (m) => m * DETOUR / WALK_MPS;
const nowSec = () => Date.now() / 1000;
const twDate = (t) => new Date((t + TW) * 1000);           // 用 getUTC* 讀出台灣時間
const fmt = (t) => twDate(t).toISOString().slice(11, 16);
const mins = (s) => Math.max(0, Math.round(s / 60));
function phi(z) {   // 標準常態分布累積機率
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** 營運日:凌晨 4 點前算前一天。回傳 { start: 營運日 0 點(epoch 秒), wd: 0=星期一 … 6=星期日 } */
function serviceDay(t) {
  const d = twDate(t - 4 * 3600);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - TW;
  return { start, wd: (d.getUTCDay() + 6) % 7 };
}

/** 與 build_model.py 的 bin_of() 相同:平日/假日 × 6 個時段 */
function binOf(t) {
  const periods = PL.model?.periods || [[5, 7], [7, 9], [9, 16], [16, 19], [19, 22], [22, 29]];
  const h0 = twDate(t).getUTCHours();
  const h = h0 < 5 ? h0 + 24 : h0;
  const day = twDate(h0 < 5 ? t - 5 * 3600 : t).getUTCDay();
  let p = periods.length - 1;
  for (let i = 0; i < periods.length; i++) if (periods[i][0] <= h && h < periods[i][1]) { p = i; break; }
  return (day === 0 || day === 6 ? 1 : 0) * periods.length + p;
}

// ---------- 載入資料、建立路網 ----------

function loadPlanData() {
  PL.loading ??= (async () => {
    planMsg('載入轉乘資料中…(第一次約 5 MB,之後會快取)');
    const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [model, rail] = await Promise.all([get('data/model.json'), get('data/rail.json'), loadStops()]);
    if (!stopData || !rail) throw new Error('轉乘資料下載失敗');
    PL.model = model;
    PL.rail = rail;
    buildNetwork();
    PL.ready = true;
    planMsg('');
  })();
  return PL.loading;
}

function buildNetwork() {
  const bus = Object.entries(stopData.stops);
  const rail = Object.entries(PL.rail.st);
  const N = bus.length + rail.length;
  PL.N = N;
  PL.lat = new Float64Array(N);
  PL.lon = new Float64Array(N);
  PL.kind = new Uint8Array(N);
  let i = 0;
  for (const [k, [n, lon, lat]] of bus) {
    PL.idx.set(k, i); PL.key[i] = k; PL.name[i] = n; PL.lat[i] = lat; PL.lon[i] = lon; i++;
  }
  for (const [id, [n, lon, lat, exits]] of rail) {
    PL.idx.set('m:' + id, i); PL.key[i] = 'm:' + id; PL.name[i] = n; PL.lat[i] = lat; PL.lon[i] = lon;
    PL.kind[i] = 1; PL.exits[i] = exits.length ? exits : [[lon, lat]]; PL.railId[i] = id; i++;
  }
  PL.railIdx = [];
  for (let s = 0; s < N; s++) {
    if (PL.kind[s]) { PL.railIdx.push(s); continue; }   // 捷運站另外找(要算到出口的距離)
    const k = cellOf(PL.lat[s], PL.lon[s]);
    (PL.grid.get(k) || PL.grid.set(k, []).get(k)).push(s);
  }
  // 公車:每條路線每個方向是一個停靠模式
  for (const [rk, dirs] of Object.entries(stopData.lines)) {
    const r = routes[rk];
    if (!r) continue;
    dirs.forEach((ids, d) => {
      if (ids.length < 2) return;
      const stops = ids.map((id) => PL.idx.get(r.c + ':' + id));
      if (stops.some((s) => s === undefined)) return;
      const pos = new Map();
      ids.forEach((id, j) => (pos.get(id) || pos.set(id, []).get(id)).push(j));
      PL.busPat.set(rk + '|' + d, PL.pats.length);
      PL.pats.push({ kind: 0, rk, d, c: r.c, stops, pos });
    });
  }
  // 軌道
  for (const p of PL.rail.pats) {
    const stops = p.s.map((id) => PL.idx.get('m:' + id));
    if (stops.some((s) => s === undefined)) continue;
    PL.pats.push({ kind: 1, p, stops, line: p.l });
  }
  PL.stopPats = Array.from({ length: N }, () => []);
  PL.pats.forEach((pat, pid) => pat.stops.forEach((s, pos) => {
    if (pos < pat.stops.length - 1) PL.stopPats[s].push(pid, pos);
  }));
  for (const [a, b, sec] of PL.rail.xfer) {
    const ia = PL.idx.get('m:' + a), ib = PL.idx.get('m:' + b);
    if (ia === undefined || ib === undefined) continue;
    (PL.xfer.get(ia) || PL.xfer.set(ia, new Map()).get(ia)).set(ib, sec);
    (PL.xfer.get(ib) || PL.xfer.set(ib, new Map()).get(ib)).set(ia, sec);
  }
}

const cellOf = (lat, lon) => Math.floor(lat / 0.004) * 100000 + Math.floor(lon / 0.0045);

/** 點到站的直線距離;捷運站算到最近的出口 */
function distTo(s, lat, lon) {
  if (!PL.kind[s]) return distM(lat, lon, PL.lat[s], PL.lon[s]);
  let best = Infinity;
  for (const [x, y] of PL.exits[s]) best = Math.min(best, distM(lat, lon, y, x));
  return best;
}

/** 半徑 r 公尺內的站:[[站, 距離], ...] */
function nearby(lat, lon, r) {
  const out = [];
  const di = Math.ceil(r / 440), dj = Math.ceil(r / 450);
  const ci = Math.floor(lat / 0.004), cj = Math.floor(lon / 0.0045);
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540, r2 = r * r;
  for (let i = ci - di; i <= ci + di; i++) {
    for (let j = cj - dj; j <= cj + dj; j++) {
      const cell = PL.grid.get(i * 100000 + j);
      if (!cell) continue;
      for (const s of cell) {
        const dx = (PL.lon[s] - lon) * kx, dy = (PL.lat[s] - lat) * ky;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) out.push([s, Math.sqrt(d2)]);
      }
    }
  }
  const near = (r + 800) / 111000;   // 捷運站中心可能離出口較遠,先粗篩再算到出口的距離
  for (const s of PL.railIdx) {
    if (Math.abs(PL.lat[s] - lat) > near || Math.abs(PL.lon[s] - lon) > near) continue;
    const d = distTo(s, lat, lon);
    if (d <= r) out.push([s, d]);
  }
  return out;
}

/** 從某站走路轉乘可以到的站:[[站, 秒], ...](快取) */
function neighbors(s) {
  let nb = PL.nb.get(s);
  if (nb) return nb;
  nb = [];
  const special = PL.xfer.get(s);
  for (const [n, d] of nearby(PL.lat[s], PL.lon[s], XFER_M)) {
    if (n === s) continue;
    let sec;
    if (special?.has(n)) sec = special.get(n);
    else if (PL.kind[s] && PL.kind[n]) sec = walkSec(distM(PL.lat[s], PL.lon[s], PL.lat[n], PL.lon[n])) + RAIL_OUT + RAIL_IN;
    else if (PL.kind[s]) sec = walkSec(distTo(s, PL.lat[n], PL.lon[n])) + RAIL_OUT;
    else sec = walkSec(d) + (PL.kind[n] ? RAIL_IN : 0);
    nb.push([n, sec]);
  }
  if (special) for (const [n, sec] of special) if (!nb.some((x) => x[0] === n)) nb.push([n, sec]);
  PL.nb.set(s, nb);
  return nb;
}

// ---------- 公車:車速模型與即時位置 ----------

/** 第 i 站 → 第 i+1 站的車程 [中位數秒, 標準差秒] */
function linkStat(pat, i, t) {
  const row = PL.model?.L?.[pat.rk]?.[pat.d]?.[i];
  if (row) {
    const m = row[2 + binOf(t)] || row[0];
    return [m, row[1] || m * 0.25];
  }
  const a = pat.stops[i], b = pat.stops[i + 1];
  const m = Math.max(20, distM(PL.lat[a], PL.lon[a], PL.lat[b], PL.lon[b]) / (PL.model?.speed || 4));
  return [m, m * 0.35];
}

async function pollEvents() {
  const now = nowSec();
  const res = await Promise.allSettled(Object.keys(FEEDS).map((c) => fetchGz(FEEDS[c].base + 'GetBusEvent.gz', true).then((j) => [c, j.BusInfo])));
  for (const r of res) {
    if (r.status !== 'fulfilled') continue;
    const [city, rows] = r.value;
    for (const e of rows) {
      if (e.DutyStatus !== '1' || (e.GoBack !== '0' && e.GoBack !== '1')) continue;
      const rk = paIndex[city + ':' + e.RouteID];
      const pid = rk ? PL.busPat.get(rk + '|' + e.GoBack) : undefined;
      if (pid === undefined) continue;
      const positions = PL.pats[pid].pos.get(+e.StopID);
      if (!positions) continue;
      const id = city + ':' + e.CarID;
      const ts = parseTw(e.DataTime) / 1000;
      let v = PL.veh.get(id);
      if (!v || v.pid !== pid) {
        v = { id, city, car: e.CarID, plate: e.BusID, pid, pos: positions[0], ts, hist: [[positions[0], ts]] };
        PL.veh.set(id, v);
      } else {
        const p = positions.find((x) => x >= v.pos) ?? positions[0];
        if (p > v.pos) {
          v.pos = p; v.ts = ts;
          v.hist.push([p, ts]);
          if (v.hist.length > 12) v.hist.shift();
        } else if (p < v.pos) {   // 跑完一趟又從頭開始
          v.pos = p; v.ts = ts; v.hist = [[p, ts]];
        }
      }
      v.seen = now;
    }
  }
  PL.vehByPid = new Map();
  for (const [id, v] of PL.veh) {
    if (now - v.seen > 180) { PL.veh.delete(id); continue; }
    (PL.vehByPid.get(v.pid) || PL.vehByPid.set(v.pid, []).get(v.pid)).push(v);
  }
  PL.evAt = now;
}

/** 這台車最近幾站實際花的時間 ÷ 模型預估,> 1 表示比平常慢。網頁開著時才有紀錄。 */
function vehFactor(v) {
  const pat = PL.pats[v.pid];
  let act = 0, exp = 0, n = 0;
  for (let j = v.hist.length - 1; j > 0 && n < 8; j--) {
    const [p1, t1] = v.hist[j], [p0, t0] = v.hist[j - 1];
    if (p1 <= p0 || t1 - t0 > 1800) break;
    act += t1 - t0;
    for (let i = p0; i < p1; i++) exp += linkStat(pat, i, t0)[0];
    n += p1 - p0;
  }
  if (n < 2 || exp <= 0) return 1;
  return Math.min(1.4, Math.max(0.7, act / exp));
}

const hhmm = (s) => (s && /^\d{4}$/.test(s) ? +s.slice(0, 2) * 60 + +s.slice(2) : null);

/** 今天這個方向的首末班(epoch 秒);資料沒有就當 05:30~23:00 */
function serviceWindow(pat, t) {
  const r = routes[pat.rk];
  const day = serviceDay(t);
  const s = r?.s?.[day.wd >= 5 ? 1 : 0] || [];
  let first = hhmm(s[pat.d * 2]), last = hhmm(s[pat.d * 2 + 1]);
  if (first == null) first = 330;
  if (last == null) last = 1380;
  if (last < first) last += 1440;
  return [day.start + first * 60, day.start + last * 60 + 60];
}

/** 班距(秒):實際觀測 > GetRoute 的尖峰/離峰班距 > 20 分 */
function headway(pat, t) {
  const b = binOf(t);
  const obs = PL.model?.H?.[pat.rk]?.[pat.d]?.[b];
  if (obs) return obs;
  const r = routes[pat.rk];
  const h = r?.h?.[b >= 6 ? 1 : 0];
  const peak = b === 1 || b === 3;
  const v = h && (peak ? h[0] : h[1]);
  if (v && /^\d{4}$/.test(v)) return (+v.slice(0, 2) + +v.slice(2)) * 30 || 1200;
  return 1200;
}

/** 這個停靠模式接下來的班次:路上的車 + 依班距推估的班次。每次規劃算一次,存在 Q.trips */
function busTrips(Q, pid) {
  let list = Q.trips.get(pid);
  if (list) return list;
  list = [];
  const pat = PL.pats[pid];
  const L = pat.stops.length;
  const now = Q.t0;
  let lastStart = -Infinity;
  for (const v of PL.vehByPid.get(pid) || []) {
    const f = vehFactor(v);
    const t = new Float64Array(L).fill(NaN), va = new Float64Array(L).fill(NaN);
    t[v.pos] = v.ts;
    va[v.pos] = 900;
    for (let i = v.pos; i < L - 1; i++) {
      const [m, sd] = linkStat(pat, i, t[i]);
      t[i + 1] = t[i] + m * f;
      va[i + 1] = va[i] + (sd * f * 1.5) ** 2;
    }
    if (v.pos < L - 1 && t[v.pos + 1] < now + 15) {   // 已經比預估晚了:整班往後推
      const sh = now + 15 - t[v.pos + 1];
      for (let i = v.pos + 1; i < L; i++) t[i] += sh;
    }
    let back = 0;
    for (let i = 0; i < v.pos; i++) back += linkStat(pat, i, v.ts)[0];
    lastStart = Math.max(lastStart, v.ts - back);
    list.push({ t, va, v, f });
  }
  const [first, last] = serviceWindow(pat, now);
  const h = headway(pat, now);
  let s0 = lastStart > -Infinity ? Math.max(lastStart + h, now + 60) : Math.max(now + h / 2, first);
  for (; s0 <= now + HORIZON && s0 <= last; s0 += h) {
    const t = new Float64Array(L), va = new Float64Array(L);
    t[0] = s0;
    va[0] = (0.29 * h) ** 2;   // 不知道實際發車時間:班距內均勻分布
    for (let i = 0; i < L - 1; i++) {
      const [m, sd] = linkStat(pat, i, t[i]);
      t[i + 1] = t[i] + m;
      va[i + 1] = va[i] + (sd * 1.5) ** 2;
    }
    list.push({ t, va, v: null, f: 1, synth: h });
  }
  Q.trips.set(pid, list);
  return list;
}

// ---------- 軌道 ----------

function maskFor(obj, wd) {
  for (const m of Object.keys(obj)) if (m[wd] === '1') return m;
  return null;
}

/** 在第 pos 站、tau 之後最早的一班:{ dep, sd, h } */
function railNextDep(pat, pos, tau) {
  const p = pat.p;
  for (const day of [serviceDay(tau), serviceDay(tau + 86400)]) {
    if (p.dep) {
      const m = maskFor(p.dep, day.wd);
      const arr = m && p.dep[m][pos];
      if (!arr?.length) continue;
      const tm = (tau - day.start) / 60;
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < tm) lo = mid + 1; else hi = mid; }
      if (lo < arr.length) return { dep: day.start + arr[lo] * 60, sd: 20, h: 0 };
    } else if (p.fq) {
      const m = maskFor(p.fq, day.wd);
      if (!m) continue;
      const t0 = tau - p.off[pos];           // 換算成首站發車時間
      for (const [a, b, h] of p.fq[m]) {
        const sa = day.start + a * 60, sb = day.start + b * 60;
        if (t0 > sb) continue;
        const k = Math.max(0, Math.ceil((t0 - sa) / h));
        const d0 = sa + k * h;
        if (d0 <= sb) return { dep: d0 + p.off[pos], sd: 0.29 * h, h };
      }
    }
  }
  return null;
}

// ---------- RAPTOR ----------

const LB_MPS = 20;   // 剪枝用:任何交通工具的直線平均速度都不會超過 72 km/h

/** 這站到終點最快也要幾秒(直線距離 ÷ 72 km/h),用來提早放棄不可能更快的走法 */
function lowerBound(Q, s) {
  let v = Q.lb[s];
  if (v < 0) v = Q.lb[s] = distM(PL.lat[s], PL.lon[s], Q.to.lat, Q.to.lon) / LB_MPS;
  return v;
}

/** 每一輪的標記陣列只配置一次,重複使用(避免手機上大量回收記憶體變慢) */
function rounds() {
  const N = PL.N;
  if (!PL.R) {
    PL.R = [];
    for (let k = 0; k <= MAX_ROUNDS; k++) {
      PL.R.push({
        all: new Float64Array(N), ride: new Float64Array(N), pid: new Int32Array(N), trip: new Int32Array(N),
        bpos: new Int32Array(N), apos: new Int32Array(N), dep: new Float64Array(N), wfrom: new Int32Array(N),
      });
    }
  }
  for (const r of PL.R) { r.all.fill(Infinity); r.ride.fill(Infinity); r.pid.fill(-1); r.wfrom.fill(-1); }
  return PL.R;
}

function raptor(Q, banned) {
  const K = MAX_ROUNDS;
  const R = rounds();
  let marked = [];
  for (const [s, sec] of Q.access) {
    R[0].all[s] = Q.t0 + sec;
    R[0].wfrom[s] = -2;
    marked.push(s);
  }
  let bestT = Q.prune ?? Infinity;
  const best = [];
  for (let k = 1; k <= K && marked.length; k++) {
    const prev = R[k - 1], cur = R[k];
    const queue = new Map();
    for (const s of marked) {
      const sp = PL.stopPats[s];
      for (let i = 0; i < sp.length; i += 2) {
        if (banned?.has(sp[i])) continue;
        const e = queue.get(sp[i]);
        if (e === undefined || sp[i + 1] < e) queue.set(sp[i], sp[i + 1]);
      }
    }
    const improved = new Set();
    const relax = (s, ta, pid, trip, bpos, pos, dep) => {
      if (ta >= cur.ride[s] || ta + lowerBound(Q, s) >= bestT) return;
      cur.ride[s] = ta; cur.pid[s] = pid; cur.trip[s] = trip; cur.bpos[s] = bpos; cur.apos[s] = pos; cur.dep[s] = dep;
      if (ta < cur.all[s]) { cur.all[s] = ta; cur.wfrom[s] = -1; }
      improved.add(s);
    };
    for (const [pid, p0] of queue) {
      const pat = PL.pats[pid];
      const L = pat.stops.length;
      if (pat.kind === 0) {
        const trips = busTrips(Q, pid);
        if (!trips.length) continue;
        let ct = -1, bpos = -1;
        for (let pos = p0; pos < L; pos++) {
          const s = pat.stops[pos];
          if (ct >= 0) relax(s, trips[ct].t[pos], pid, ct, bpos, pos, 0);
          const tp = prev.all[s];
          if (tp < Infinity && pos < L - 1) {
            // 在這站能趕上、而且比目前搭的那班更早到的車
            const need = tp + SLACK;
            let bt = ct >= 0 ? trips[ct].t[pos] : Infinity;
            for (let i = 0; i < trips.length; i++) {
              const x = trips[i].t[pos];
              if (x >= need && x < bt) { bt = x; ct = i; bpos = pos; }
            }
          }
        }
      } else {
        const off = pat.p.off;
        let vs = Infinity, bpos = -1, dep = 0;   // vs = 換算成首站的發車時間
        for (let pos = p0; pos < L; pos++) {
          const s = pat.stops[pos];
          if (bpos >= 0 && pos > bpos) relax(s, vs + off[pos], pid, 0, bpos, pos, dep);
          const tp = prev.all[s];
          if (tp < Infinity && pos < L - 1) {
            const nd = railNextDep(pat, pos, tp + SLACK);
            if (nd && nd.dep - off[pos] < vs && nd.dep - tp < HORIZON) { vs = nd.dep - off[pos]; bpos = pos; dep = nd.dep; }
          }
        }
      }
    }
    // 下車後走路轉乘(只從搭車到達的站出發,不連續走兩段)
    const walked = [];
    for (const s of improved) {
      const t = cur.ride[s];
      for (const [n, sec] of neighbors(s)) {
        if (t + sec < cur.all[n] && t + sec + lowerBound(Q, n) < bestT) { cur.all[n] = t + sec; cur.wfrom[n] = s; walked.push(n); }
      }
    }
    for (const n of walked) improved.add(n);
    for (const s of improved) {
      const e = Q.egress.get(s);
      if (e !== undefined && cur.all[s] + e < bestT) { bestT = cur.all[s] + e; best[k] = { t: bestT, s }; }
    }
    marked = [...improved];
  }
  return { R, best };
}

/** 從 RAPTOR 的標記倒推出搭乘的各段 */
function extract(Q, res, k) {
  const legs = [];
  let s = res.best[k].s;
  legs.unshift({ type: 'walk', a: s, b: -2 });
  for (let r = k; r > 0; r--) {
    const L = res.R[r];
    if (L.wfrom[s] >= 0) { legs.unshift({ type: 'walk', a: L.wfrom[s], b: s }); s = L.wfrom[s]; }
    const pid = L.pid[s];
    const leg = { type: 'ride', pid, trip: L.trip[s], bpos: L.bpos[s], apos: L.apos[s], dep: L.dep[s] };
    legs.unshift(leg);
    s = PL.pats[pid].stops[leg.bpos];
  }
  legs.unshift({ type: 'walk', a: -1, b: s });
  // 下車走到另一站、再走到終點:合併成一段直接走過去
  const merged = [];
  for (const l of legs) {
    const last = merged[merged.length - 1];
    if (l.type === 'walk' && last?.type === 'walk') last.b = l.b;
    else merged.push(l);
  }
  return merged.filter((l) => !(l.type === 'walk' && l.a === l.b));
}

// ---------- 把搭乘的各段整理成時間表與接上機率 ----------

/** 走路這段:dist 直線距離、walk 走路秒數、inside 進出站或站內轉乘秒數 */
function walkLeg(Q, a, b) {
  const pa = a === -1 ? Q.from : a === -2 ? Q.to : null;
  const pb = b === -1 ? Q.from : b === -2 ? Q.to : null;
  const rail = (x) => x >= 0 && PL.kind[x] === 1;
  const sp = a >= 0 && b >= 0 ? PL.xfer.get(a)?.get(b) : undefined;
  if (sp) return { dist: 0, walk: 0, inside: sp, sec: sp, xfer: true };   // 捷運站內轉乘(官方轉乘時間)
  let dist;
  if (pa && pb) dist = distM(pa.lat, pa.lon, pb.lat, pb.lon);
  else if (pa) dist = distTo(b, pa.lat, pa.lon);
  else if (pb) dist = distTo(a, pb.lat, pb.lon);
  else if (rail(a) && rail(b)) dist = distM(PL.lat[a], PL.lon[a], PL.lat[b], PL.lon[b]);
  else dist = rail(a) ? distTo(a, PL.lat[b], PL.lon[b]) : distTo(b, PL.lat[a], PL.lon[a]);
  const inside = (rail(a) ? RAIL_OUT : 0) + (rail(b) ? RAIL_IN : 0);
  const walk = walkSec(dist);
  return { dist, walk, inside, sec: walk + inside };
}

function describe(Q, legs) {
  let t = Q.t0;
  let prob = 1;
  let prevArr = null;    // 前一段的 { t, sd }
  let nBus = 0;
  const out = [];
  for (const l of legs) {
    if (l.type === 'walk') {
      const w = walkLeg(Q, l.a, l.b);
      out.push({ type: 'walk', a: l.a, b: l.b, ...w, t0: t, t1: t + w.sec });
      t += w.sec;
      continue;
    }
    const pat = PL.pats[l.pid];
    const r = { type: pat.kind ? 'rail' : 'bus', pid: l.pid, pat, bpos: l.bpos, apos: l.apos, ready: t };
    r.color = pat.kind ? railColor(pat.line)
      : watch.find((w) => w.k === pat.rk)?.color || BUS_COLORS[nBus++ % BUS_COLORS.length];
    if (pat.kind === 0) {
      const tr = busTrips(Q, l.pid)[l.trip];
      r.trip = tr;
      r.t0 = tr.t[l.bpos]; r.t1 = tr.t[l.apos];
      r.sd0 = Math.sqrt(tr.va[l.bpos]); r.sd1 = Math.sqrt(tr.va[l.apos]);
      r.next = busTrips(Q, l.pid).map((x) => x.t[l.bpos]).filter((x) => x > r.t0 + 30).sort((a, b) => a - b)[0];
    } else {
      const off = pat.p.off;
      const nd = railNextDep(pat, l.bpos, l.dep - 1) || { dep: l.dep, sd: 20, h: 0 };
      r.t0 = l.dep; r.t1 = l.dep + off[l.apos] - off[l.bpos];
      r.sd0 = nd.sd; r.sd1 = nd.sd + 20; r.h = nd.h;
      r.next = railNextDep(pat, l.bpos, l.dep + 30)?.dep;
    }
    // 接上機率:前一段到站時間的不確定 + 這班車到站時間的不確定(常態分布近似)
    const sd = Math.max(20, Math.sqrt((prevArr ? prevArr.sd : 30) ** 2 + r.sd0 ** 2));
    r.p = phi((r.t0 - t) / sd);
    if (prevArr) prob *= r.p;      // 只算轉乘;第一班車用「最晚出發時間」處理
    r.wait = r.t0 - t;
    out.push(r);
    t = r.t1;
    prevArr = { t: r.t1, sd: r.sd1 };
  }
  const rides = out.filter((x) => x.type !== 'walk');
  // 最晚出發時間:照這個時間出門,約 85% 機率趕上第一班車(至少提早 1 分鐘到站)
  let leave = Q.t0;
  const first = rides[0];
  if (first) {
    const w0 = out[0].type === 'walk' ? out[0].sec : 0;
    const margin = Math.max(SLACK, 1.04 * Math.sqrt(30 ** 2 + first.sd0 ** 2));
    leave = Math.max(Q.t0, first.t0 - w0 - margin);
    if (out[0].type === 'walk') { out[0].t0 = leave; out[0].t1 = leave + w0; }
    first.wait = first.t0 - leave - w0;
  }
  return {
    legs: out, arrive: t, rides: rides.length, prob, leave,
    walk: out.filter((x) => x.type === 'walk').reduce((a, x) => a + x.sec, 0),
    sig: rides.map((x) => x.pid + '@' + x.pat.stops[x.bpos]).join('>'),
  };
}

function plan() {
  if (!PL.ready || !PL.from || !PL.to) return [];
  const t0 = nowSec();
  // 推算出來的公車班次只跟即時資料有關:同一份資料 1 分鐘內重複使用
  const tc = PL.tripCache;
  const trips = tc && tc.at === PL.evAt && t0 - tc.t0 < 60 ? tc.map : new Map();
  PL.tripCache = { at: PL.evAt, t0: tc && tc.map === trips ? tc.t0 : t0, map: trips };
  const Q = { t0, from: PL.from, to: PL.to, trips, lb: new Float32Array(PL.N).fill(-1) };
  Q.access = nearby(Q.from.lat, Q.from.lon, ACCESS_M).map(([s, d]) => [s, walkSec(d) + (PL.kind[s] ? RAIL_IN : 0)]);
  Q.egress = new Map(nearby(Q.to.lat, Q.to.lon, ACCESS_M).map(([s, d]) => [s, walkSec(d) + (PL.kind[s] ? RAIL_OUT : 0)]));
  const direct = distM(Q.from.lat, Q.from.lon, Q.to.lat, Q.to.lon);
  const out = [];
  if (direct <= WALK_ONLY_M) {
    out.push(describe(Q, [{ type: 'walk', a: -1, b: -2 }]));
    // 走路 15 分鐘內就到:比走路還慢的搭車方案不用列
    if (walkSec(direct) <= 900) Q.prune = Q.t0 + walkSec(direct);
  }
  // 先找最快的,再把用到的公車或捷運排除後重找,得到不同的走法
  const seen = new Set(out.map((j) => j.sig));
  const banned = new Set();
  for (let round = 0; round < 3; round++) {
    const res = raptor(Q, banned);
    let added = null;
    for (let k = 1; k < res.best.length; k++) {
      if (!res.best[k]) continue;
      const j = describe(Q, extract(Q, res, k));
      if (!seen.has(j.sig)) { seen.add(j.sig); out.push(j); added = added || j; }
    }
    const top = added || null;
    if (!top) break;
    for (const l of top.legs) if (l.type !== 'walk') { banned.add(l.pid); break; }
  }
  // 依抵達時間排序,拿掉重複或比較差的:
  // 同樣的路線組合只留最早到的;搭比較多段、路線又包含另一個方案的(例如「板南線→板南線」)也拿掉
  out.sort((a, b) => a.arrive - b.arrive);
  const names = (j) => j.legs.filter((l) => l.type !== 'walk').map(legLabel);
  const kept = [];
  for (const j of out) {
    const nj = names(j);
    const worse = kept.some((k) => {
      const nk = names(k);
      return nk.length && k.arrive <= j.arrive && k.rides <= j.rides && nk.every((x) => nj.includes(x));
    });
    if (!worse) kept.push(j);
  }
  const fastest = kept[0]?.arrive ?? Infinity;
  return kept.filter((j) => j.arrive <= fastest + 1800).slice(0, 5);   // 比最快的晚 30 分以上就不列
}

// ---------- 地點搜尋 ----------

function buildPlaces() {
  const byName = new Map();
  for (const [k, [n, lon, lat]] of Object.entries(stopData.stops)) {
    let groups = byName.get(n);
    if (!groups) byName.set(n, groups = []);
    const g = groups.find((x) => distM(x.lat, x.lon, lat, lon) < 300);
    if (g) { g.lat = (g.lat * g.n + lat) / (g.n + 1); g.lon = (g.lon * g.n + lon) / (g.n + 1); g.n++; }
    else groups.push({ name: n, lat, lon, n: 1, kind: 'bus' });
  }
  const list = [];
  for (const groups of byName.values()) list.push(...groups);
  const lineOf = new Map();
  for (const p of PL.rail.pats) for (const id of p.s) {
    (lineOf.get(id) || lineOf.set(id, new Set()).get(id)).add(PL.rail.lines[p.l]?.[0] || p.l);
  }
  for (const [id, [n, lon, lat]] of Object.entries(PL.rail.st)) {
    list.push({ name: n.endsWith('站') ? n : n + '站', lat, lon, kind: 'rail', sub: [...(lineOf.get(id) || [])].join('、') });
  }
  PL.places = list.map((p) => ({ ...p, norm: norm(p.name) }));
}

function searchPlaces(q) {
  if (!PL.places) return [];
  const nq = norm(q);
  if (!nq) return [];
  const res = [];
  for (const p of PL.places) {
    const i = p.norm.indexOf(nq);
    if (i < 0) continue;
    res.push([(p.norm === nq ? 0 : i === 0 ? 1 : 2) - (p.kind === 'rail' ? 0.5 : 0), p.norm.length, p]);
  }
  res.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return res.slice(0, 8).map((x) => x[2]);
}

let lastOsm = 0;
async function searchOsm(q) {
  // OpenStreetMap 的 Nominatim:免費,但每秒最多 1 次、不能邊打字邊查,所以只在按搜尋時呼叫
  const wait = lastOsm + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOsm = Date.now();
  const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=tw&accept-language=zh-TW'
    + '&viewbox=121.28,25.32,121.82,24.78&bounded=1&q=' + encodeURIComponent(q);
  const res = await fetch(u);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).map((x) => ({
    name: x.name || x.display_name.split(',')[0], lat: +x.lat, lon: +x.lon, kind: 'osm',
    sub: x.display_name.split(',').slice(1, 4).join(',').trim(),
  }));
}

// ---------- 畫面 ----------

const ICON = {
  walk: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="13" cy="4" r="2"/><path d="M10.5 8.5 8 20h2.2l1.6-7 2.2 2.2V20h2v-6l-2.3-2.3.7-3.2A6 6 0 0 0 19 11v-2a4 4 0 0 1-3.4-1.9l-1-1.6A2 2 0 0 0 12 4.6L7 6.8V11h2V8.1z"/></svg>',
  bus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 4a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v12a2 2 0 0 1-1 1.7V20a1 1 0 0 1-2 0v-2H8v2a1 1 0 0 1-2 0v-2.3A2 2 0 0 1 5 16zm2 2v5h10V6zm1.5 7.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4m7 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4"/></svg>',
  // 捷運:有集電弓和軌道,跟公車圖示區分
  rail: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6M12 2v3"/><rect x="5" y="5" width="14" height="12" rx="4"/><path d="M5 11h14"/><path d="M8 21l2-4M16 21l-2-4"/><circle cx="9" cy="14" r=".6" fill="currentColor"/><circle cx="15" cy="14" r=".6" fill="currentColor"/></svg>',
};
// 公車段的顏色:有加入查看列表就用列表的顏色,否則依序用這幾個(跟捷運各線的顏色錯開)
const BUS_COLORS = ['#c2185b', '#00838f', '#6d4c41'];
const railColor = (line) => PL.rail?.lines[line]?.[1] || '#555';

function legLabel(l) {
  if (l.type === 'bus') return routes[l.pat.rk]?.n || '公車';
  return PL.rail.lines[l.pat.line]?.[0] || l.pat.line;
}
function legColor(l) { return l.color || (l.type === 'bus' ? BUS_COLORS[0] : railColor(l.pat.line)); }
function towards(l) {
  if (l.type === 'bus') {
    const r = routes[l.pat.rk];
    return r ? '往 ' + (l.pat.d === 0 ? r.t : r.d) : '';
  }
  const id = l.pat.p.to;
  return '往 ' + (PL.rail.st[id]?.[0] || id);
}
const stopName = (s) => (s === -1 ? PL.from.name : s === -2 ? PL.to.name : PL.name[s] + (PL.kind[s] && !PL.name[s].endsWith('站') ? '站' : ''));
const probText = (p) => (p >= 0.995 ? '' : `轉乘接上 ${Math.round(p * 100)}%`);
function leaveText(j) {
  const first = j.legs.find((l) => l.type !== 'walk');
  if (j.leave - nowSec() >= 60) return `最晚 ${fmt(j.leave)} 出發`;
  return first && first.p < 0.6 ? '現在出發(可能趕不上這班)' : '現在出發';
}
const probClass = (p) => (p >= 0.8 ? 'ok' : p >= 0.5 ? 'warn' : 'bad');

function planMsg(msg) { $('#plan-msg').textContent = msg; $('#plan-msg').hidden = !msg; }

function renderPlans() {
  const box = $('#plans');
  if (PL.sel) return renderDetail();
  $('#plan-detail').hidden = true;
  box.hidden = false;
  if (!PL.results.length) { box.innerHTML = ''; return; }
  box.innerHTML = PL.results.map((j, i) => {
    const chips = j.legs.map((l) => (l.type === 'walk'
      ? (l.sec >= 60 ? `<span class="wk">${ICON.walk}${mins(l.sec)}</span>` : '')
      : `<span class="chip" style="--c:${legColor(l)}">${l.type === 'bus' ? ICON.bus : ICON.rail}${esc(legLabel(l))}</span>`))
      .filter(Boolean).join('<i class="sep">›</i>');
    const first = j.legs.find((l) => l.type !== 'walk');
    const sub = first
      ? `${esc(legLabel(first))} ${fmt(first.t0)} 到站${first.type === 'bus' && first.trip.synth ? '(依班距估計)' : ''}・${leaveText(j)}`
      : `走路 ${mins(j.walk)} 分`;
    const p = probText(j.prob);
    return `<li class="plan" data-i="${i}"><div class="pl-top"><b>${fmt(j.arrive)}</b> 抵達<span class="dur">${mins(j.arrive - nowSec())} 分鐘</span>`
      + `${j.rides > 1 ? `<span class="tag">轉乘 ${j.rides - 1} 次</span>` : ''}${p ? `<span class="prob ${probClass(j.prob)}">${p}</span>` : ''}</div>`
      + `<div class="pl-legs">${chips}</div><div class="pl-sub">${sub}</div></li>`;
  }).join('');
}

function renderDetail() {
  const j = PL.sel;
  $('#plans').hidden = true;
  const box = $('#plan-detail');
  box.hidden = false;
  const rows = [];
  const now = nowSec();
  j.legs.forEach((l, i) => {
    if (l.type === 'walk') {
      if (l.sec < 30 && i > 0 && i < j.legs.length - 1) return;
      const next = j.legs[i + 1];
      const what = l.xfer
        ? `站內轉乘約 ${mins(l.sec) || 1} 分,到 <b>${esc(next ? legLabel(next) : stopName(l.b))}</b> 月台`
        : `走路 ${mins(l.walk) || 1} 分(約 ${Math.round(l.dist * DETOUR / 10) * 10} 公尺)到 <b>${esc(stopName(l.b))}</b>`
          + (l.inside ? `<br><small>含進出站約 ${mins(l.inside)} 分</small>` : '');
      rows.push(`<li class="st walk"><span class="tm">${fmt(l.t0)}</span><span class="ic">${ICON.walk}</span><div>${what}</div></li>`);
      return;
    }
    const n = l.apos - l.bpos;
    let info = '';
    if (l.type === 'bus') {
      const v = l.trip.v;
      const r = routes[l.pat.rk];
      if (v) {
        const at = PL.name[l.pat.stops[v.pos]];
        info = `車牌 ${esc(v.plate)},目前在「${esc(at)}」`;
        if (l.trip.f !== 1) info += `,這台車最近比平常${l.trip.f > 1 ? '慢' : '快'} ${Math.round(Math.abs(l.trip.f - 1) * 100)}%`;
        const off = officialEta(r, l.pat, l.pat.stops[l.bpos]);
        if (off != null && i <= 1) info += `<br>官方預估 ${off < 60 ? '即將進站' : mins(off) + ' 分後到'}`;
      } else {
        info = '還沒發車,依班距估計';
      }
    } else if (l.h) {
      info = `約每 ${mins(l.h)} 分一班`;
    }
    const wait = l.wait > 90 ? `等 ${mins(l.wait)} 分・` : '';
    const p = i > 1 ? probText(l.p) : '';   // 第一班車不顯示機率(已經用最晚出發時間處理)
    rows.push(`<li class="st ride" style="--c:${legColor(l)}"><span class="tm">${fmt(l.t0)}</span><span class="ic">${l.type === 'bus' ? ICON.bus : ICON.rail}</span>`
      + `<div><span class="chip" style="--c:${legColor(l)}">${esc(legLabel(l))}</span> ${esc(towards(l))}<br>`
      + `在 <b>${esc(stopName(l.pat.stops[l.bpos]))}</b> 上車(${wait}${mins(l.t0 - now)} 分後)`
      + `${p ? `<span class="prob ${probClass(l.p)}">${p}</span>` : ''}`
      + `${info ? `<br><small>${info}</small>` : ''}`
      + `${l.next ? `<br><small>沒趕上的話,下一班約 ${fmt(l.next)}</small>` : ''}`
      + `<br>坐 ${n} 站,${fmt(l.t1)} 在 <b>${esc(stopName(l.pat.stops[l.apos]))}</b> 下車</div></li>`);
  });
  rows.push(`<li class="st end"><span class="tm">${fmt(j.arrive)}</span><span class="ic pin d"></span><div>抵達 <b>${esc(PL.to.name)}</b></div></li>`);
  box.innerHTML = `<button class="back" id="plan-back">‹ 所有方案</button>`
    + `<div class="pl-top"><b>${fmt(j.arrive)}</b> 抵達<span class="dur">${mins(j.arrive - now)} 分鐘</span>`
    + `${probText(j.prob) ? `<span class="prob ${probClass(j.prob)}">${probText(j.prob)}</span>` : ''}</div>`
    + `<p class="hint">${leaveText(j)}</p><ol class="steps">${rows.join('')}</ol>`;
  $('#plan-back').onclick = () => { PL.sel = null; drawJourney(null); renderPlans(); };
}

// ---------- 地圖 ----------

const planLayer = L.layerGroup().addTo(map);
const pinIcon = (cls) => L.divIcon({ className: 'bus-icon', html: `<div class="pin-mk ${cls}"></div>`, iconSize: [0, 0] });
let fromMk = null, toMk = null;
const vehMarkers = new Map();

function drawPins() {
  if (PL.from) { fromMk ??= L.marker([0, 0], { icon: pinIcon('o'), zIndexOffset: 900 }).addTo(map); fromMk.setLatLng([PL.from.lat, PL.from.lon]); }
  if (PL.to) { toMk ??= L.marker([0, 0], { icon: pinIcon('d'), zIndexOffset: 900 }).addTo(map); toMk.setLatLng([PL.to.lat, PL.to.lon]); }
}

const ptOf = (s) => (s === -1 ? [PL.from.lat, PL.from.lon] : s === -2 ? [PL.to.lat, PL.to.lon] : [PL.lat[s], PL.lon[s]]);

function drawJourney(j, fit = true) {
  planLayer.clearLayers();
  vehMarkers.clear();
  if (!j) return;
  const pts = [];
  for (const l of j.legs) {
    if (l.type === 'walk') {
      const line = [ptOf(l.a), ptOf(l.b)];
      L.polyline(line, { color: '#667085', weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(planLayer);
      pts.push(...line);
      continue;
    }
    const line = l.pat.stops.slice(l.bpos, l.apos + 1).map((s) => [PL.lat[s], PL.lon[s]]);
    const c = legColor(l);
    L.polyline(line, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(planLayer);
    L.polyline(line, { color: c, weight: 6 }).addTo(planLayer);
    for (const [k, s] of [['上車', l.pat.stops[l.bpos]], ['下車', l.pat.stops[l.apos]]]) {
      L.circleMarker([PL.lat[s], PL.lon[s]], { radius: 6, color: c, weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${k}:${stopName(s)}`).addTo(planLayer);
    }
    pts.push(...line);
  }
  if (fit) {
    const s = $('#sheet').getBoundingClientRect();
    const wide = window.innerWidth >= 768;
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [wide ? s.right + 30 : 30, 60],
      paddingBottomRight: [60, wide ? 30 : window.innerHeight - s.top + 30], maxZoom: 16,
    });
  }
  onBusData();
}

/** 選中的方案要搭的公車:在地圖上顯示它現在的位置(位置資料由 app.js 的 poll 抓) */
function planCities() {
  if (!PL.active || !PL.sel) return [];
  return [...new Set(PL.sel.legs.filter((l) => l.type === 'bus' && l.trip.v).map((l) => l.trip.v.city))];
}

function onBusData() {
  if (!PL.sel) return;
  for (const l of PL.sel.legs) {
    const v = l.type === 'bus' && l.trip.v;
    if (!v) continue;
    const row = lastData[v.city]?.rows.find((b) => String(b.CarID) === String(v.car));
    if (!row) continue;
    const ll = [+row.Latitude, +row.Longitude];
    let m = vehMarkers.get(v.id);
    const html = `<div class="bus go mine" style="--c:${legColor(l)}"><i class="dot"></i><b class="lbl">${esc(legLabel(l))} 要搭的車</b></div>`;
    if (!m) {
      m = L.marker(ll, { icon: L.divIcon({ className: 'bus-icon', html, iconSize: [0, 0] }), zIndexOffset: 800 }).addTo(planLayer);
      vehMarkers.set(v.id, m);
    } else m.setLatLng(ll);
  }
}

/** 地圖上點的位置:用最近的捷運站或站牌命名 */
function placeName(lat, lon) {
  if (!PL.ready) return '地圖上選的位置';
  const near = nearby(lat, lon, 400).sort((a, b) => (a[1] - (PL.kind[a[0]] ? 150 : 0)) - (b[1] - (PL.kind[b[0]] ? 150 : 0)))[0];
  return near ? `${stopName(near[0])}附近` : '地圖上選的位置';
}

// 點地圖設定起點或終點
map.on('click', (e) => {
  if (!PL.active) return;
  const { lat, lng } = e.latlng;
  L.popup({ closeButton: false, className: 'pick-pop' }).setLatLng(e.latlng)
    .setContent(`<div class="pick"><button data-pick="from">設為起點</button><button data-pick="to">設為終點</button></div>`)
    .openOn(map);
  map.getContainer().querySelector('.pick')?.addEventListener('click', (ev) => {
    const f = ev.target.closest('button')?.dataset.pick;
    if (!f) return;
    map.closePopup();
    setPoint(f, { name: placeName(lat, lng), lat, lon: lng });
  }, { once: true });
});

// ---------- 起點、終點輸入 ----------

function setPoint(field, p) {
  PL[field] = p;
  $('#' + field).value = p ? p.name : '';
  $('#places').hidden = true;
  PL.sel = null;
  PL.results = [];
  renderPlans();
  drawJourney(null);
  drawPins();
  runPlan();
}

function useGps(silent) {
  if (!navigator.geolocation) { if (!silent) planMsg('這個瀏覽器不支援定位,請輸入起點'); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    setPoint('from', { name: '目前位置', lat: p.coords.latitude, lon: p.coords.longitude, gps: true });
  }, () => { if (!silent) planMsg('無法取得目前位置(請允許定位),或直接輸入起點'); }, { enableHighAccuracy: true, timeout: 10000 });
}

function renderPlaces(field, list, q) {
  const box = $('#places');
  const items = [];
  if (field === 'from') items.push(`<li data-gps="1"><span class="ic">◎</span><div class="info"><b>目前位置</b></div></li>`);
  for (const [i, p] of list.entries()) {
    const sub = p.kind === 'rail' ? `捷運/輕軌・${p.sub}` : p.kind === 'bus' ? '公車站牌' : p.sub;
    items.push(`<li data-i="${i}"><span class="ic">${p.kind === 'rail' ? ICON.rail : p.kind === 'bus' ? ICON.bus : '⌕'}</span>`
      + `<div class="info"><b>${esc(p.name)}</b><small>${esc(sub)}</small></div></li>`);
  }
  if (q && q.trim()) items.push(`<li data-osm="1"><span class="ic">⌕</span><div class="info"><b>搜尋地址或地標「${esc(q.trim())}」</b><small>使用 OpenStreetMap</small></div></li>`);
  box.innerHTML = items.join('');
  box.hidden = !items.length;
  box.onclick = async (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (li.dataset.gps) return useGps(false);
    if (li.dataset.osm) return osmSearch(field, q.trim());
    setPoint(field, list[+li.dataset.i]);
  };
}

async function osmSearch(field, q) {
  planMsg('搜尋中…');
  try {
    const list = await searchOsm(q);
    planMsg(list.length ? '' : `找不到「${q}」,換個說法試試(例如加上路名或區名)`);
    renderPlaces(field, list, '');
  } catch {
    planMsg('地址搜尋暫時無法使用,請改用站名或點地圖');
  }
}

for (const field of ['from', 'to']) {
  const input = $('#' + field);
  input.addEventListener('focus', () => {
    PL.field = field;
    loadPlanData().then(() => { PL.places ??= (buildPlaces(), PL.places); renderPlaces(field, searchPlaces(input.value), input.value); }).catch(() => {});
    collapse(false);
  });
  input.addEventListener('input', () => {
    if (PL.places) renderPlaces(field, searchPlaces(input.value), input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); osmSearch(field, input.value.trim()); }
  });
}
$('#swap').addEventListener('click', () => {
  [PL.from, PL.to] = [PL.to, PL.from];
  $('#from').value = PL.from?.name || '';
  $('#to').value = PL.to?.name || '';
  PL.sel = null;
  drawJourney(null);
  drawPins();
  runPlan();
});
$('#plans').addEventListener('click', (e) => {
  const li = e.target.closest('li.plan');
  if (!li) return;
  PL.sel = PL.results[+li.dataset.i];
  renderPlans();
  if (window.innerWidth < 768) collapse(false);
  drawJourney(PL.sel);
  poll();   // 馬上抓要搭的公車位置
});

// ---------- 規劃與定時更新 ----------

let planning = false;
let replan = false;      // 計算途中改了起終點:算完再算一次
async function runPlan(force) {
  if (!PL.from || !PL.to) return;
  if (planning) { replan = true; return; }
  planning = true;
  replan = false;
  try {
    await loadPlanData();
    if (force || nowSec() - PL.evAt > 20) await pollEvents();
    if (!PL.results.length) planMsg('計算中…');
    await new Promise((r) => setTimeout(r, 30));   // 先讓畫面顯示「計算中」
    PL.results = plan();
    planMsg('');
    PL.lastPlan = Date.now();
    if (!PL.results.length) planMsg('3 小時內找不到可以到達的走法(可能已過末班車,或起終點離車站太遠)');
    if (PL.sel) {   // 正在看的方案:換成重新計算後同一個走法
      PL.sel = PL.results.find((j) => j.sig === PL.sel.sig) || PL.sel;
      drawJourney(PL.sel, false);
    }
    renderPlans();
  } catch (e) {
    planMsg('轉乘資料下載失敗,請檢查網路後重新整理');
    console.error(e);
  } finally {
    planning = false;
  }
  if (replan) runPlan();
}

function tick() {
  clearTimeout(PL.timer);
  if (!PL.active || document.hidden) return;
  PL.timer = setTimeout(tick, EV_MS);
  if (!PL.from || !PL.to || !PL.ready) return;
  pollEvents().then(() => { if (Date.now() - PL.lastPlan >= REPLAN_MS - 1000) runPlan(); });
}

function onPlanTab(on) {
  PL.active = on;
  planLayer.remove();
  if (on) {
    planLayer.addTo(map);
    loadPlanData().then(() => {
      PL.places ??= (buildPlaces(), PL.places);
      if (!PL.from) useGps(true);
      tick();
    }).catch(() => planMsg('轉乘資料下載失敗,請檢查網路後重新整理'));
  } else {
    clearTimeout(PL.timer);
  }
  if (fromMk) on ? fromMk.addTo(map) : fromMk.remove();
  if (toMk) on ? toMk.addTo(map) : toMk.remove();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && PL.active) tick(); });

// ---------- 官方預估到站時間(只用在第一段公車的參考) ----------

function officialEta(r, pat, s) {
  if (!r) return null;
  const tab = PL.est[r.c];
  if (!tab) { if (nowSec() - PL.estAt > 60) loadEst(); return null; }
  if (nowSec() - PL.estAt > 60) loadEst();
  const stopId = PL.key[s].split(':')[1];
  const v = tab.get(`${r.k.split(':')[1]}:${stopId}:${pat.d}`) ?? tab.get(`${r.k.split(':')[1]}:${stopId}:x`);
  return v != null && v >= 0 ? v : null;
}

let estLoading = false;
async function loadEst() {
  if (estLoading) return;
  estLoading = true;
  PL.estAt = nowSec();
  const res = await Promise.allSettled(Object.keys(FEEDS).map((c) => fetchGz(FEEDS[c].base + 'GetEstimateTime.gz', true).then((j) => [c, j.BusInfo])));
  for (const r of res) {
    if (r.status !== 'fulfilled') continue;
    const [c, rows] = r.value;
    const m = new Map();
    for (const e of rows) {
      const v = +e.EstimateTime;
      m.set(`${e.RouteID}:${e.StopID}:${e.GoBack}`, v);
      m.set(`${e.RouteID}:${e.StopID}:x`, v);
    }
    PL.est[c] = m;
  }
  estLoading = false;
  if (PL.sel) renderDetail();
}
