'use strict';
// Records analytics for the control panel. Reads /api/analytics (anonymous rows from the backup) and draws charts.
// Everything is built with DOM calls (no innerHTML) and styled by classes, so the page's strict CSP is respected.
(() => {
  const $ = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v !== undefined) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }
  function s(tag, props = {}, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
    return el;
  }
  const COURSES = ['CSE', 'IT', 'AI & DS', 'ECE', 'EEE', 'Mechanical', 'Civil'];
  const GENDERS = ['Female', 'Male', 'Other'];
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const r1 = (n) => Math.round(n * 10) / 10;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- tooltip (mouse + keyboard focus) ----
  const tip = h('div', { id: 'an-tip', class: 'hidden', role: 'tooltip' });
  document.body.append(tip);
  function showTip(text, x, y) {
    tip.textContent = text; tip.classList.remove('hidden');
    const w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(8, y - 38) + 'px';
  }
  const hideTip = () => tip.classList.add('hidden');
  function tipOn(el, text) {
    el.addEventListener('mousemove', (e) => showTip(text, e.clientX, e.clientY));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); showTip(text, b.left + b.width / 2, b.top); });
    el.addEventListener('blur', hideTip);
  }

  // ---- chart pieces ----
  function card(title, sub, body, wide) {
    return h('div', { class: 'card an-card' + (wide ? ' an-wide' : '') }, h('h3', {}, title), sub ? h('p', { class: 'sub' }, sub) : null, body);
  }
  // rows: [{label, value, tip, text?}]
  function hbars(rows, max) {
    if (!rows.length || rows.every((r) => !r.value)) return h('p', { class: 'an-empty' }, 'No data yet');
    const top = max || Math.max(...rows.map((r) => r.value), 1);
    return h('div', { class: 'hb' }, rows.map((r) => {
      const fill = h('i', { class: 'hb-fill' });
      fill.style.width = (r.value / top) * 100 + '%';
      const row = h('div', { class: 'hb-row', tabindex: '0' }, h('span', { class: 'l', title: r.label }, r.label), h('span', { class: 'hb-track' }, fill), h('span', { class: 'v' }, r.text ?? String(r.value)));
      tipOn(row, r.tip);
      return row;
    }));
  }
  function columns(items) { // [{label, value, tip}]
    if (items.every((i) => !i.value)) return h('p', { class: 'an-empty' }, 'No data yet');
    const top = Math.max(...items.map((i) => i.value), 1);
    const cols = h('div', { class: 'cols' }, items.map((i) => {
      const bar = h('i', { class: 'bar2' });
      bar.style.height = (i.value / top) * 82 + '%';
      const c = h('div', { class: 'col', tabindex: '0' }, h('span', { class: 'n' }, i.value ? String(i.value) : ''), bar);
      tipOn(c, i.tip);
      return c;
    }));
    return h('div', {}, cols, h('div', { class: 'col-labels' }, items.map((i) => h('span', {}, i.label))));
  }
  function genderLegend() {
    return h('div', { class: 'legend' }, [...GENDERS, 'Not set'].map((g) => h('span', {}, h('i', { class: g === 'Not set' ? 'g-none' : 'g-' + g }), g)));
  }
  function stacked(groups) { // [{label, rows}]
    const body = groups.map((g) => {
      const total = g.rows.length;
      const counts = { Female: 0, Male: 0, Other: 0, none: 0 };
      for (const r of g.rows) counts[GENDERS.includes(r.gender) ? r.gender : 'none']++;
      const track = h('div', { class: 'sb-track' }, Object.entries(counts).filter(([, n]) => n).map(([k, n]) => {
        const seg = h('i', { class: 'sb-seg g-' + k, tabindex: '0' });
        seg.style.width = (n / total) * 100 + '%';
        tipOn(seg, `${g.label}: ${k === 'none' ? 'gender not set' : k} ${n} of ${total} (${Math.round((n / total) * 100)}%)`);
        return seg;
      }));
      return h('div', { class: 'sb-row' }, h('span', { class: 'l' }, g.label), total ? track : h('span', { class: 'muted small' }, 'no records'), h('span', { class: 'v' }, String(total)));
    });
    return h('div', {}, ...body, genderLegend());
  }
  function scatter(rows) {
    const pts = rows.filter((r) => Number.isFinite(r.attendance) && Number.isFinite(r.marks));
    if (!pts.length) return h('p', { class: 'an-empty' }, 'No data yet');
    const W = 420, H = 330, L = 38, R = 14, T = 30, B = 36, X0 = 40; // attendance axis starts at 40 (nobody is plotted below it by design of the data); marks 0-100
    const lo = Math.min(X0, Math.floor(Math.min(...pts.map((p) => p.attendance)) / 10) * 10);
    const x = (v) => L + ((v - lo) / (100 - lo)) * (W - L - R), y = (v) => H - B - (v / 100) * (H - T - B);
    const svg = s('svg', { class: 'sc', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Scatter of attendance (x) against marks (y) for ${pts.length} students` });
    for (const t of [0, 25, 50, 75, 100]) {
      svg.append(s('line', { class: 'grid', x1: L, x2: W - R, y1: y(t), y2: y(t) }));
      const ty = s('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end' }); ty.textContent = String(t); svg.append(ty);
    }
    for (let t = lo; t <= 100; t += 10) { const tx = s('text', { x: x(t), y: H - B + 16, 'text-anchor': 'middle' }); tx.textContent = String(t); svg.append(tx); }
    svg.append(s('line', { class: 'rule', x1: x(75), x2: x(75), y1: T - 4, y2: H - B }));
    const rl = s('text', { x: x(75), y: T - 10, 'text-anchor': 'middle' }); rl.textContent = '75% rule'; svg.append(rl);
    const xl = s('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle' }); xl.textContent = 'Attendance %'; svg.append(xl);
    const yl = s('text', { x: 4, y: 12 }); yl.textContent = 'Marks %'; svg.append(yl);
    for (const p of pts) {
      const c = s('circle', { cx: x(Math.max(lo, p.attendance)), cy: y(p.marks), r: 5, tabindex: '0' });
      tipOn(c, `${p.course || 'course not set'} · attendance ${r1(p.attendance)}%, marks ${r1(p.marks)}%`);
      svg.append(c);
    }
    return svg;
  }

  // ---- state + render ----
  let data = null, pick = 'all', timer = null, sig = '';
  const podName = (r) => r;

  function render() {
    const rowsAll = data.rows;
    const pods = [...new Set([...data.shards, ...rowsAll.map((r) => r.route)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (pick !== 'all' && !pods.includes(pick)) pick = 'all';
    const rows = pick === 'all' ? rowsAll : rowsAll.filter((r) => r.route === pick);
    const scope = pick === 'all' ? 'all pods' : pick;

    $('an-filter').replaceChildren(...['all', ...pods].map((p) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(p === pick),
      onclick: () => { pick = p; render(); } }, p === 'all' ? 'All pods' : p)));

    const accts = pick === 'all' ? Object.values(data.accounts).reduce((a, b) => a + b, 0) : (data.accounts[pick] || 0);
    const kpi = (lab, num, unit) => h('div', { class: 'card' }, h('div', { class: 'lab' }, lab), h('div', { class: 'num' }, num, unit ? h('small', {}, unit) : null));
    $('an-kpis').replaceChildren(
      kpi('Records', String(rows.length)), kpi('Accounts', String(accts)),
      kpi('Avg marks', rows.length ? String(r1(avg(rows.map((r) => r.marks)))) : '-', rows.length ? '%' : ''),
      kpi('Avg attendance', rows.length ? String(r1(avg(rows.map((r) => r.attendance)))) : '-', rows.length ? '%' : ''));

    // records per pod: always all pods
    const perPod = pods.map((p) => ({ label: podName(p), value: rowsAll.filter((r) => r.route === p).length }));
    perPod.forEach((r) => { r.tip = `${r.label}: ${plural(r.value, 'record')}`; });

    const byCourse = [...COURSES, null].map((c) => ({ c, list: rows.filter((r) => (c ? r.course === c : !COURSES.includes(r.course))) })).filter((x) => x.c || x.list.length);
    const courseRows = byCourse.map(({ c, list }) => ({ label: c || 'Not set', value: list.length, tip: `${c || 'Course not set'} (${scope}): ${plural(list.length, 'student')}` }))
      .sort((a, b) => b.value - a.value);
    const avgRows = byCourse.filter((x) => x.c && x.list.length).map(({ c, list }) => {
      const m = r1(avg(list.map((r) => r.marks)));
      return { label: c, value: m, text: m + '%', tip: `${c} (${scope}): average marks ${m}% over ${plural(list.length, 'student')}` };
    }).sort((a, b) => b.value - a.value);

    const ageBins = [['16-17', 16, 17], ['18', 18, 18], ['19', 19, 19], ['20', 20, 20], ['21', 21, 21], ['22', 22, 22], ['23', 23, 23], ['24+', 24, 99]]
      .map(([label, lo, hi]) => { const n = rows.filter((r) => Number.isInteger(r.age) && r.age >= lo && r.age <= hi).length; return { label, value: n, tip: `Age ${label} (${scope}): ${plural(n, 'student')}` }; });
    const ageSet = rows.filter((r) => Number.isInteger(r.age)).length;
    const yearItems = [1, 2, 3, 4].map((y) => { const n = rows.filter((r) => r.year === y).length; return { label: ['1st', '2nd', '3rd', '4th'][y - 1], value: n, tip: `Year ${y} (${scope}): ${plural(n, 'student')}` }; });
    const resRows = ['Hostel', 'Day scholar'].map((k) => { const n = rows.filter((r) => r.residence === k).length; return { label: k, value: n, tip: `${k} (${scope}): ${plural(n, 'student')}` }; });

    $('an-grid').replaceChildren(
      card('Records per pod', 'Does each shard hold a similar amount of data?', hbars(perPod)),
      card('Gender mix per pod', 'Share of each pod\'s records, by gender', stacked([{ label: 'All pods', rows: rowsAll }, ...pods.map((p) => ({ label: p, rows: rowsAll.filter((r) => r.route === p) }))])),
      card('Students by course', `Showing ${scope}`, hbars(courseRows)),
      card('Average marks by course', `Showing ${scope}`, hbars(avgRows, 100)),
      card('Age', `${scope}: ${plural(ageSet, 'student')} with an age`, columns(ageBins)),
      card('Year of study', `Showing ${scope}`, columns(yearItems)),
      card('Residence', `Showing ${scope}`, hbars(resRows)),
      card('Marks against attendance', `Each dot is one student (${scope}). Students left of the dashed line are under 75% attendance.`, scatter(rows)));

    // accessible table view: pods x measures
    const th = (t) => h('th', {}, t);
    const body = pods.map((p) => {
      const l = rowsAll.filter((r) => r.route === p);
      const cnt = (f) => String(l.filter(f).length);
      return h('tr', {}, h('td', {}, p), h('td', {}, String(data.accounts[p] || 0)), h('td', {}, String(l.length)),
        h('td', {}, cnt((r) => r.gender === 'Female')), h('td', {}, cnt((r) => r.gender === 'Male')), h('td', {}, cnt((r) => r.gender === 'Other')),
        h('td', {}, cnt((r) => r.residence === 'Hostel')), h('td', {}, l.length ? String(r1(avg(l.map((r) => r.marks)))) : '-'), h('td', {}, l.length ? String(r1(avg(l.map((r) => r.attendance)))) : '-'));
    });
    $('an-table').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Pod', 'Accounts', 'Records', 'Female', 'Male', 'Other', 'Hostel', 'Avg marks', 'Avg attendance'].map(th))), h('tbody', {}, body)));
  }

  async function load() {
    if ($('panel').classList.contains('hidden')) return;
    try {
      const r = await fetch('/api/analytics');
      if (!r.ok) return;
      const next = await r.json();
      const nsig = JSON.stringify(next);
      if (nsig === sig) return; // nothing changed: keep hover state and scroll
      sig = nsig; data = next; render();
    } catch { /* control panel shows connection state elsewhere */ }
  }
  load(); timer = setInterval(load, 4000);
  window.addEventListener('pagehide', () => clearInterval(timer));
})();
