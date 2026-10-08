(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  // ?dev=1 測試模式:不經過 LINE 登入,用假身分(後端 DEV_MODE=true 才接受)。?dev=admin 會以老闆身分登入。
  var devUser = new URLSearchParams(location.search).get('dev');
  var state = { data: null, date: null, time: null, tab: 'book', busy: false };
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 工具 ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 2026-10-01 + 四 → 10/1(四) */
  function dateLabel(date, weekday) {
    var p = date.split('-');
    return Number(p[1]) + '/' + Number(p[2]) + '(' + weekday + ')';
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key) || '';
      localStorage.setItem(key, value);
    } catch (e) { /* 無痕模式等情況讀寫不到,不影響使用 */ }
    return '';
  }

  async function api(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    if (devUser) body.devUserId = devUser;
    else body.idToken = liff.getIDToken();

    var res;
    try {
      // 不設 Content-Type(預設 text/plain),避免瀏覽器先送 CORS preflight,Apps Script 不支援
      res = await fetch(cfg.API_URL, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      throw Object.assign(new Error('網路連線失敗,請確認網路後再試一次'), { code: 'NETWORK' });
    }
    if (!res.ok) throw Object.assign(new Error('伺服器沒有回應(' + res.status + '),請稍後再試'), { code: 'NETWORK' });
    var json = await res.json();
    if (!json.ok) throw Object.assign(new Error(json.error), { code: json.code });
    return json.data;
  }

  // ---------- 對話框 ----------

  function modal(html, buttons) {
    return new Promise(function (resolve) {
      $('modalBody').innerHTML = html;
      var actions = $('modalActions');
      actions.innerHTML = '';
      buttons.forEach(function (b) {
        var el = document.createElement('button');
        el.type = 'button';
        el.textContent = b.label;
        el.className = b.className || 'ghost';
        el.onclick = function () { $('modal').hidden = true; resolve(b.value); };
        actions.appendChild(el);
      });
      $('modal').hidden = false;
    });
  }

  function alertBox(title, message) {
    return modal('<h3>' + esc(title) + '</h3><p>' + esc(message) + '</p>',
      [{ label: '好', value: true, className: 'primary' }]);
  }

  function confirmBox(title, message, okLabel) {
    return modal('<h3>' + esc(title) + '</h3><p>' + esc(message) + '</p>', [
      { label: '返回', value: false },
      { label: okLabel, value: true, className: 'danger' }
    ]);
  }

  function setBusy(busy) {
    state.busy = busy;
    document.body.classList.toggle('busy', busy);
  }

  // ---------- 啟動 ----------

  function fatal(message) {
    $('loading').hidden = true;
    $('tabs').hidden = true;
    document.querySelectorAll('.tab').forEach(function (el) { el.hidden = true; });
    $('fatalMsg').textContent = message;
    $('fatal').hidden = false;
  }

  function handleError(e) {
    if (e.code === 'AUTH' || e.code === 'CONFIG' || e.code === 'INTERNAL') return fatal(e.message);
    return alertBox('無法完成', e.message);
  }

  async function start() {
    if (!/^https:\/\/script\.google\.com\//.test(cfg.API_URL || '')) {
      return fatal('尚未設定 API_URL(web/config.js)');
    }
    try {
      if (!devUser) {
        if (!window.liff) return fatal('LINE 元件載入失敗,請確認網路後重新開啟');
        if (!cfg.LIFF_ID) return fatal('尚未設定 LIFF_ID(web/config.js)');
        await liff.init({ liffId: cfg.LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return;
        }
      }
      apply(await api('init'));
      $('loading').hidden = true;
      $('tabs').hidden = false;
      $('footer').hidden = false;
      showTab('book');
    } catch (e) {
      fatal(e.message || String(e));
    }
  }

  $('fatalRetry').onclick = function () {
    // LINE 以外的瀏覽器登入過期時,登出再重新整理會重新登入
    if (!devUser && window.liff && liff.isLoggedIn && !liff.isInClient()) {
      try { liff.logout(); } catch (e) { /* 還沒 init 成功時會丟錯,忽略 */ }
    }
    location.reload();
  };

  /** 把後端回傳的資料(init / book / cancel 的結果)併入 state 並重畫 */
  function apply(data) {
    var d = state.data = Object.assign(state.data || {}, data);
    $('shopName').textContent = d.shopName;
    $('tagline').textContent = d.tagline || '';
    document.title = d.shopName + ' 線上預約';
    $('adminTabBtn').hidden = !d.isAdmin;
    $('proxyRow').hidden = !d.isAdmin;
    $('blockedNotice').hidden = !d.blocked;
    $('blockedNotice').textContent = d.blockedMessage || '';
    $('bookArea').hidden = !!d.blocked;

    var day = findDay(state.date);
    if (!day || day.closed) {
      day = d.days.filter(function (x) { return openCount(x) > 0; })[0] ||
        d.days.filter(function (x) { return !x.closed; })[0];
      state.date = day ? day.date : null;
    }
    var slot = day && day.slots.filter(function (s) { return s.time === state.time; })[0];
    if (!slot || slot.status !== 'open') state.time = null;

    renderDates();
    renderSlots();
    renderForm();
    renderMine();
  }

  function findDay(date) {
    return (state.data.days || []).filter(function (x) { return x.date === date; })[0];
  }

  function openCount(day) {
    return day.slots.filter(function (s) { return s.status === 'open'; }).length;
  }

  // ---------- 分頁 ----------

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.tab').forEach(function (el) { el.hidden = el.id !== 'tab-' + tab; });
    if (tab === 'admin') loadAdmin();
    window.scrollTo(0, 0);
  }

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (b && !state.busy) showTab(b.dataset.tab);
  });

  // ---------- 預約 ----------

  function renderDates() {
    var days = state.data.days;
    if (!days.some(function (d) { return !d.closed; })) {
      $('dates').innerHTML = '<p class="empty">近期沒有開放預約的日期</p>';
      return;
    }
    $('dates').innerHTML = days.map(function (d) {
      var p = d.date.split('-');
      var md = '<span class="wd">週' + d.weekday + '</span>' +
        '<span class="md">' + Number(p[1]) + '/' + Number(p[2]) + '</span>';
      if (d.closed) {
        // 休息日:保留選項但不能選,日期劃掉
        return '<button type="button" class="date closed" disabled' +
          (d.note ? ' title="' + esc(d.note) + '"' : '') + '>' + md +
          '<span class="left">' + esc(d.reason) + '</span></button>';
      }
      var n = openCount(d);
      return '<button type="button" class="date' + (d.date === state.date ? ' selected' : '') + (n ? '' : ' full') +
        '" data-date="' + d.date + '">' + md +
        '<span class="left">' + (n ? '剩 ' + n : '已滿') + '</span></button>';
    }).join('');
    var sel = $('dates').querySelector('.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  $('dates').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-date]');
    if (!b || b.disabled || state.busy) return;
    state.date = b.dataset.date;
    state.time = null;
    renderDates();
    renderSlots();
    renderForm();
  });

  function renderSlots() {
    var day = findDay(state.date);
    if (!day) {
      $('slots').innerHTML = '';
      return;
    }
    var label = { open: '可預約', taken: '已約滿', past: '已截止', full: '當日額滿' };
    $('slots').innerHTML = day.slots.map(function (s) {
      return '<button type="button" class="slot ' + s.status + (s.time === state.time ? ' selected' : '') +
        '" data-time="' + s.time + '"' + (s.status === 'open' ? '' : ' disabled') + '>' +
        '<span class="t">' + s.time + '</span><span class="s">' + label[s.status] + '</span></button>';
    }).join('');
  }

  $('slots').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-time]');
    if (!b || b.disabled || state.busy) return;
    state.time = b.dataset.time;
    renderSlots();
    renderForm();
    $('form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function renderForm() {
    var day = findDay(state.date);
    $('form').hidden = !(day && state.time);
    if ($('form').hidden) return;
    $('picked').textContent = dateLabel(day.date, day.weekday) + ' ' + state.time;
    if (!$('proxy').checked) {
      if (!$('name').value) $('name').value = store('name') || state.data.displayName || '';
      if (!$('phone').value) $('phone').value = store('phone');
    }
  }

  $('proxy').addEventListener('change', function () {
    $('name').value = '';
    $('phone').value = '';
    renderForm();
    $('name').focus();
  });

  $('form').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (state.busy) return;
    var name = $('name').value.trim();
    var phone = $('phone').value.replace(/[\s-]/g, '');
    var proxy = $('proxy').checked;
    if (!name) return alertBox('請填寫姓名', '');
    if (!/^0\d{8,9}$/.test(phone)) return alertBox('電話格式不正確', '請輸入手機(例:0912345678)或市話(例:0223456789)');

    setBusy(true);
    $('submitBtn').textContent = '預約中…';
    try {
      var r = await api('book', { date: state.date, time: state.time, name: name, phone: phone, proxy: proxy });
      if (!proxy) {
        store('name', name);
        store('phone', phone);
      } else {
        $('proxy').checked = false;
        $('name').value = '';
        $('phone').value = '';
      }
      state.time = null;
      apply(r);
      var b = r.booking;
      await modal(
        '<div class="ok-mark">✓</div><h3>預約成功</h3>' +
        '<p class="big">' + esc(dateLabel(b.date, b.weekday)) + ' ' + esc(b.time) + '</p>' +
        '<p>' + esc(b.name) + ' · ' + esc(b.phone) + '</p>' +
        (proxy ? '' : '<p class="muted">需要取消的話,到「我的預約」操作即可。</p>'),
        [{ label: '好', value: true, className: 'primary' }]);
      if (!proxy) showTab('mine');
    } catch (err) {
      await handleError(err);
      if (err.code === 'TAKEN' || err.code === 'UNAVAILABLE') await refresh();
    } finally {
      $('submitBtn').textContent = '確認預約';
      setBusy(false);
    }
  });

  async function refresh() {
    try { apply(await api('init')); } catch (e) { handleError(e); }
  }

  // ---------- 我的預約 ----------

  function renderMine() {
    var d = state.data;
    var mine = d.mine || [];
    $('mineCount').hidden = !mine.length;
    $('mineCount').textContent = mine.length;
    $('cancelHint').textContent = mine.length
      ? '距離預約時間 ' + d.cancelLimitMinutes + ' 分鐘內無法線上取消,請直接聯絡店家。'
      : '';
    if (!mine.length) {
      $('mineList').innerHTML = '<p class="empty">目前沒有預約</p>';
      return;
    }
    $('mineList').innerHTML = mine.map(function (b) {
      return '<div class="card booking">' +
        '<div><div class="when">' + esc(dateLabel(b.date, b.weekday)) + ' ' + esc(b.time) + '</div>' +
        '<div class="who">' + esc(b.name) + ' · ' + esc(b.phone) + '</div></div>' +
        '<button type="button" class="danger small" data-cancel="' + esc(b.id) + '">取消</button></div>';
    }).join('');
  }

  $('mineList').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-cancel]');
    if (!btn || state.busy) return;
    var b = state.data.mine.filter(function (x) { return x.id === btn.dataset.cancel; })[0];
    if (!b) return;
    var ok = await confirmBox('確定要取消嗎?', dateLabel(b.date, b.weekday) + ' ' + b.time, '取消預約');
    if (!ok) return;
    setBusy(true);
    try {
      apply(await api('cancel', { id: b.id }));
      await alertBox('已取消預約', dateLabel(b.date, b.weekday) + ' ' + b.time);
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  });

  // ---------- 老闆:預約總覽 ----------

  async function loadAdmin() {
    $('adminList').innerHTML = '<p class="empty">載入中…</p>';
    try {
      renderAdmin(await api('adminList'));
    } catch (e) {
      $('adminList').innerHTML = '';
      handleError(e);
    }
  }

  function renderAdmin(data) {
    var groups = data.groups;
    var total = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    $('adminSummary').textContent = '今天起共 ' + total + ' 筆預約';
    if (!groups.length) {
      $('adminList').innerHTML = '<p class="empty">目前沒有預約</p>';
      return;
    }
    $('adminList').innerHTML = groups.map(function (g) {
      return '<h3 class="group">' + esc(dateLabel(g.date, g.weekday)) + '<span>' + g.items.length + ' 位</span></h3>' +
        g.items.map(function (b) {
          var label = esc(dateLabel(g.date, g.weekday) + ' ' + b.time + ' ' + b.name);
          return '<div class="card booking">' +
            '<div class="time">' + esc(b.time) + '</div>' +
            '<div class="grow"><div class="who-name">' + esc(b.name) +
            (b.byShop ? ' <span class="tag">代訂</span>' : '') +
            (b.blocked ? ' <span class="tag bad">黑名單</span>' : '') + '</div>' +
            '<a class="tel" href="tel:' + esc(b.phone) + '">' + esc(b.phone) + '</a></div>' +
            '<div class="actions">' +
            '<button type="button" class="danger small" data-act="cancel" data-id="' + esc(b.id) + '" data-label="' +
            label + '">取消</button>' +
            '<button type="button" class="ghost small" data-act="' + (b.blocked ? 'unblock' : 'block') +
            '" data-id="' + esc(b.id) + '" data-label="' + label + '">' + (b.blocked ? '解除封鎖' : '黑名單') + '</button>' +
            '</div></div>';
        }).join('');
    }).join('');
  }

  $('adminRefresh').onclick = function () { if (!state.busy) loadAdmin(); };

  $('adminList').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || state.busy) return;
    var act = btn.dataset.act;
    var dialogs = {
      cancel: ['取消這筆預約?', btn.dataset.label + '\n客人會收到取消通知(若有開啟客人通知)。', '取消預約', 'adminCancel'],
      block: ['加入黑名單?', btn.dataset.label + '\n這位客人(LINE 帳號和電話)之後就不能線上預約。已經約好的預約不會自動取消。', '加入黑名單', 'adminBlock'],
      unblock: ['解除封鎖?', btn.dataset.label + '\n解除後這位客人又可以線上預約。', '解除封鎖', 'adminUnblock']
    };
    var d = dialogs[act];
    var ok = await confirmBox(d[0], d[1], d[2]);
    if (!ok) return;
    setBusy(true);
    try {
      renderAdmin(await api(d[3], { id: btn.dataset.id }));
      if (act === 'cancel') await refresh();
    } catch (err) {
      await handleError(err);
    } finally {
      setBusy(false);
    }
  });

  // ---------- 顯示 LINE ID(設定老闆帳號用) ----------

  $('showId').onclick = function () {
    $('myId').textContent = state.data ? state.data.userId : '';
    $('myId').hidden = !$('myId').hidden;
  };

  start();
})();
