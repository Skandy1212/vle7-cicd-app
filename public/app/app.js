'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  // Build DOM nodes without innerHTML so user-supplied text can never become markup.
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
    return el;
  }
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = {};
    try { json = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(json.error || 'Something went wrong'), { status: r.status });
    return json;
  }
  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    $('toasts').append(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ---------------- sign in / register ----------------
  let mode = 'login';
  function setMode(m) {
    mode = m;
    $('tab-login').classList.toggle('active', m === 'login');
    $('tab-register').classList.toggle('active', m === 'register');
    $('tab-login').setAttribute('aria-selected', m === 'login');
    $('tab-register').setAttribute('aria-selected', m === 'register');
    $('auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('a-pass').setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
    $('auth-hint').classList.toggle('hidden', m === 'login');
    $('auth-err').classList.add('hidden');
  }
  $('tab-login').addEventListener('click', () => setMode('login'));
  $('tab-register').addEventListener('click', () => setMode('register'));
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-err').classList.add('hidden');
    $('auth-submit').disabled = true;
    try {
      await api('POST', mode === 'login' ? '/api/login' : '/api/register', { login: $('a-login').value.trim(), password: $('a-pass').value });
      $('a-pass').value = '';
      await enter();
    } catch (err) {
      $('auth-err').textContent = err.message;
      $('auth-err').classList.remove('hidden');
    } finally { $('auth-submit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    leave();
  });

  // ---------------- dashboard ----------------
  let students = [], timer = null, loginName = '';
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  function leave() {
    clearInterval(timer); timer = null; students = [];
    $('dash').classList.add('hidden'); $('auth').classList.remove('hidden');
  }
  async function enter() {
    $('auth').classList.add('hidden'); $('dash').classList.remove('hidden');
    await refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!$('dlg').open) refresh(true); }, 3000);
  }
  async function refresh(quiet) {
    try {
      const r = await api('GET', '/api/students');
      loginName = r.login; students = r.students;
      renderStatus(r.meta); render();
    } catch (err) {
      if (err.status === 401) { leave(); return; }
      if (!quiet) toast(err.message, true);
      renderStatus(null, err.message);
    }
  }

  const REASONS = {
    'shard-unreachable': 'its pod is unreachable',
    'shard-empty': 'its pod has lost its copy of your data',
    'shard-stale': 'its pod held an out-of-date copy',
    parked: 'your account is parked in the backup',
    'no-shard': 'no pod is available for your account',
    'shard-error': 'its pod rejected the update',
  };
  function renderStatus(meta, error) {
    const srv = $('srv'), detail = $('srv-detail');
    $('who').textContent = loginName || '';
    if (!meta) {
      srv.className = 'badge bad'; srv.replaceChildren(h('i', { class: 'dot' }), 'Offline');
      detail.textContent = error || 'Cannot reach the server.'; return;
    }
    const onShard = meta.servedBy !== 'backup';
    srv.className = 'badge ' + (onShard ? 'ok' : 'warn');
    srv.replaceChildren(h('i', { class: 'dot' }), onShard ? `Served by ${meta.servedBy}` : 'Served by backup');
    const assigned = String(meta.assigned).startsWith('parked:') ? 'parked in the backup' : meta.assigned;
    detail.textContent = onShard
      ? `Your account lives on ${meta.assigned}. Pod ${meta.pod}.`
         : (assigned === 'parked in the backup' ? 'Your account is parked in the backup (it has no pod), so the backup is answering. Nothing is lost.' : `Your account is assigned to ${assigned}, but ${REASONS[meta.reason] || 'that pod cannot serve you'}, so the backup is answering. Nothing is lost.`);
  }

  function render() {
    // stats
    const n = students.length;
    const avg = (k) => (n ? students.reduce((s, x) => s + x[k], 0) / n : 0);
    const low = students.filter((s) => s.attendance < 75).length;
    $('stats').replaceChildren(
      ...[['Students', String(n), ''], ['Avg attendance', n ? fmt(Math.round(avg('attendance') * 10) / 10) : '-', '%'],
        ['Avg marks', n ? fmt(Math.round(avg('marks') * 10) / 10) : '-', '%'], ['Below 75% attendance', String(low), '']]
        .map(([label, num, unit]) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num, unit && n ? h('small', {}, unit) : null))));

    // chart
    const bands = [['80 - 100', 80, 101], ['60 - 79', 60, 80], ['40 - 59', 40, 60], ['0 - 39', 0, 40]];
    $('chart').replaceChildren(...bands.map(([label, lo, hi]) => {
      const c = students.filter((s) => s.marks >= lo && s.marks < hi).length;
      const fill = h('i');
      fill.style.width = (n ? (c / n) * 100 : 0) + '%';
      return h('div', { class: 'cbar' }, h('div', { class: 'top2' }, h('span', {}, label), h('span', {}, String(c))), h('div', { class: 'track' }, fill));
    }));

    // table
    const q = $('q').value.trim().toLowerCase();
    const sort = $('sort').value;
    let list = students.filter((s) => !q || s.name.toLowerCase().includes(q) || s.regno.toLowerCase().includes(q));
    list = list.slice().sort(sort === 'marks' ? (a, b) => b.marks - a.marks : sort === 'attendance' ? (a, b) => a.attendance - b.attendance : (a, b) => a.name.localeCompare(b.name));
    $('count').textContent = n ? `${list.length} of ${n}` : '';
    $('empty').classList.toggle('hidden', n > 0);
    $('tbl').classList.toggle('hidden', n === 0);
    $('rows').replaceChildren(...list.map((s) => {
      const fill = h('i');
      fill.style.width = s.attendance + '%';
      return h('tr', {},
        h('td', { class: 'name' }, s.name),
        h('td', { class: 'mono' }, s.regno),
        h('td', {}, h('span', { class: 'bar ' + (s.attendance < 75 ? 'low' : s.attendance < 85 ? 'mid' : '') }, fill), fmt(s.attendance) + '%'),
        h('td', {}, h('span', { class: 'badge ' + (s.marks >= 60 ? 'ok' : s.marks >= 40 ? 'warn' : 'bad') }, fmt(s.marks) + '%')),
        h('td', { class: 'actions' },
          h('button', { class: 'btn small', onclick: () => openDialog(s) }, 'Edit'),
          h('button', { class: 'btn small danger', onclick: () => remove(s) }, 'Delete')));
    }));
  }
  $('q').addEventListener('input', render);
  $('sort').addEventListener('change', render);

  // ---------------- add / edit ----------------
  let editing = null;
  function openDialog(s) {
    editing = s || null;
    $('dlg-title').textContent = s ? 'Edit student' : 'Add student';
    $('f-name').value = s ? s.name : ''; $('f-reg').value = s ? s.regno : '';
    $('f-att').value = s ? s.attendance : ''; $('f-marks').value = s ? s.marks : '';
    $('dlg-err').classList.add('hidden');
    $('dlg').showModal(); $('f-name').focus();
  }
  $('add').addEventListener('click', () => openDialog(null));
  $('dlg-cancel').addEventListener('click', () => $('dlg').close());
  $('dlg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('f-name').value, regno: $('f-reg').value, attendance: $('f-att').value, marks: $('f-marks').value };
    $('dlg-save').disabled = true;
    try {
      const r = editing ? await api('PUT', '/api/students/' + editing.id, body) : await api('POST', '/api/students', body);
      students = r.students; renderStatus(r.meta); render();
      $('dlg').close();
      toast(editing ? 'Student updated' : 'Student added');
    } catch (err) {
      $('dlg-err').textContent = err.message; $('dlg-err').classList.remove('hidden');
    } finally { $('dlg-save').disabled = false; }
  });
  async function remove(s) {
    try {
      const r = await api('DELETE', '/api/students/' + s.id);
      students = r.students; renderStatus(r.meta); render();
      toast('Deleted ' + s.name);
    } catch (err) { toast(err.message, true); }
  }

  // already signed in? (cookie still valid)
  api('GET', '/api/me').then(enter).catch(() => {});
})();
