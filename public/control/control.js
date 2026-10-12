'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
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
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = {};
    try { json = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(json.error || 'Request failed'), { status: r.status, body: json });
    return json;
  }
  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    $('toasts').append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------------- sign in ----------------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/admin/login', { password: $('pw').value }); $('pw').value = ''; start(); }
    catch (err) { $('login-err').textContent = err.message; $('login-err').classList.remove('hidden'); }
  });
  $('logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); stop(); });

  let timer = null, last = null;
  function start() {
    $('login').classList.add('hidden'); $('panel').classList.remove('hidden');
    refresh(); clearInterval(timer); timer = setInterval(refresh, 2000);
  }
  function stop() {
    clearInterval(timer); timer = null;
    $('panel').classList.add('hidden'); $('login').classList.remove('hidden');
  }
  async function refresh() {
    try { last = await api('GET', '/api/overview'); render(last); }
    catch (err) { if (err.status === 401) stop(); }
  }

  // ---------------- actions ----------------
  async function act(path, body, okMsg) {
    try { await api('POST', path, body || {}); if (okMsg) toast(okMsg); }
    catch (err) { toast(err.message, true); }
    refresh();
  }

  // ---------------- rendering ----------------
  const podChips = (c) => {
    if (!c.exists && c.exists !== undefined) return [h('span', { class: 'badge bad' }, 'missing')];
    if (!c.pods || !c.pods.length) return [h('span', { class: 'badge ' + (c.desired === 0 ? '' : 'warn') }, c.desired === 0 ? 'Stopped (0 replicas)' : 'No pod yet')];
    return c.pods.flatMap((p) => [
      h('span', { class: 'badge ' + (p.ready ? 'ok' : 'warn') }, h('i', { class: 'dot' }), p.ready ? 'Ready' : p.phase),
      h('span', { class: 'badge mono' }, p.name),
      p.restarts ? h('span', { class: 'badge warn' }, `${p.restarts} restart${p.restarts > 1 ? 's' : ''}`) : null,
    ]);
  };
  function coreCard(label, key, o, extra) {
    const c = o[key];
    return h('div', { class: 'card comp' + (c.healthy ? '' : c.desired === 0 ? ' off' : ' down') },
      h('div', { class: 'row' }, h('span', { class: 'name' }, label), h('span', { class: 'spacer' }),
        h('span', { class: 'badge ' + (c.healthy ? 'ok' : 'bad') }, h('i', { class: 'dot' }), c.healthy ? 'Healthy' : 'Down')),
      h('div', { class: 'chips' }, podChips(c)),
      extra,
      h('div', { class: 'btns' },
        h('button', { class: 'btn small danger', onclick: () => act(`/api/core/${key}/kill`, {}, `Deleted the ${key} pod`) }, 'Kill pod'),
        c.desired === 0
          ? h('button', { class: 'btn small good', onclick: () => act(`/api/core/${key}/start`, {}, `Started ${key}`) }, 'Start')
          : h('button', { class: 'btn small warn', onclick: () => act(`/api/core/${key}/stop`, {}, `Stopped ${key}`) }, 'Stop')));
  }

  function shardCard(s) {
    const total = s.accounts.reduce((n, a) => n + a.records, 0);
    const missing = s.accounts.some((a) => a.records > 0 && (a.onShard === null || a.onShard < a.records));
    return h('div', { class: 'card comp' + (s.desired === 0 ? ' off' : '') },
      h('div', { class: 'row' }, h('span', { class: 'name' }, s.name), h('span', { class: 'spacer' }),
        h('span', { class: 'badge ' + (s.health === 'ok' ? 'ok' : s.health === 'failing' ? 'warn' : 'bad') }, h('i', { class: 'dot' }),
          s.health === 'ok' ? 'Serving' : s.health === 'failing' ? 'Health check failing' : 'Not serving')),
      h('div', { class: 'chips' }, podChips(s)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Accounts routed here'), h('dd', {}, String(s.accounts.length)),
        h('dt', {}, 'Records in the backup for them'), h('dd', {}, String(total)),
        h('dt', {}, 'Records held by this pod'), h('dd', {}, s.shardRecords === null ? 'unreachable' : String(s.shardRecords))),
      missing ? h('span', { class: 'badge warn' }, 'This pod is missing data. The backup is answering for it.') : null,
      h('ul', { class: 'accts' }, s.accounts.length
        ? s.accounts.map((a) => h('li', {}, h('b', {}, a.login), h('span', { class: 'spacer' }),
          h('span', { class: 'muted' }, `${a.onShard === null ? 0 : a.onShard} of ${a.records} on pod`)))
        : h('li', { class: 'none' }, 'No accounts routed to this pod')),
      h('div', { class: 'btns' },
        h('button', { class: 'btn small danger', title: 'Delete the pod. Kubernetes creates a new, empty one.', onclick: () => act(`/api/shards/${s.name}/kill`, {}, `Deleted the pod of ${s.name}`) }, 'Kill pod'),
        h('button', { class: 'btn small danger', title: 'Exit the process. The pod restarts the container; the emptyDir survives.', onclick: () => act(`/api/shards/${s.name}/crash`, {}, `Crashed ${s.name}`) }, 'Crash container'),
        h('button', { class: 'btn small danger', title: 'Wipe the data held by this pod. Kubernetes cannot see this.', onclick: () => act(`/api/shards/${s.name}/erase`, {}, `Erased the data on ${s.name}`) }, 'Erase data'),
        s.desired === 0
          ? h('button', { class: 'btn small good', onclick: () => act(`/api/shards/${s.name}/start`, {}, `Started ${s.name}`) }, 'Start')
          : h('button', { class: 'btn small warn', onclick: () => act(`/api/shards/${s.name}/stop`, {}, `Stopped ${s.name}`) }, 'Stop'),
        h('button', { class: 'btn small warn', title: 'Make the readiness probe fail so Kubernetes stops sending traffic.', onclick: () => act(`/api/shards/${s.name}/fail-health`, { on: !s.failHealth }, s.failHealth ? 'Health restored' : 'Health forced to fail') }, s.failHealth ? 'Restore health' : 'Fail health'),
        h('button', { class: 'btn small', title: 'Copy this pod\'s accounts from the backup into the pod now.', onclick: () => act(`/api/shards/${s.name}/resync`, {}, `Resynced ${s.name} from the backup`) }, 'Resync'),
        h('button', { class: 'btn small', onclick: () => removeFlow(s) }, 'Remove')));
  }

  function render(o) {
    $('orch').textContent = o.orchestrator === 'kubernetes' ? 'Kubernetes' : 'Local processes';
    $('orch').className = 'badge brand';
    if (document.activeElement !== $('autoheal') && o.settings) $('autoheal').checked = !!o.settings.autoheal;
    const bstats = o.backup.stats;
    $('core').replaceChildren(
      coreCard('Gateway', 'gateway', o, h('p', { class: 'muted small' }, 'The public entry point. Routes each login to its pod, writes to the backup, fails over to it.')),
      coreCard('Backup', 'backup', o, bstats
        ? h('dl', { class: 'kv' }, h('dt', {}, 'Accounts'), h('dd', {}, String(bstats.accounts)), h('dt', {}, 'Records (everyone)'), h('dd', {}, String(bstats.records)))
        : h('p', { class: 'muted small' }, 'Holds every account and every record on a persistent volume.')));
    $('shard-count').textContent = `(${o.shards.length})`;
    $('shards').replaceChildren(...o.shards.map(shardCard));
    $('parked-sec').classList.toggle('hidden', !o.parked.length);
    $('parked').replaceChildren(...o.parked.map((g) => h('div', { class: 'card comp' },
      h('div', { class: 'row' }, h('span', { class: 'name' }, `Parked from ${g.group}`), h('span', { class: 'spacer' }), h('span', { class: 'badge warn' }, 'Served by backup')),
      h('ul', { class: 'accts' }, g.accounts.map((a) => h('li', {}, h('b', {}, a.login), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${a.records} record${a.records === 1 ? '' : 's'}`)))),
      h('div', { class: 'btns' }, h('button', { class: 'btn small primary', onclick: () => openCreate(g.group) }, 'Recover into a new pod')))));
    $('log').replaceChildren(...(o.events.length ? o.events : [{ t: Date.now(), msg: 'No actions yet.' }]).map((e) =>
      h('li', {}, h('time', {}, new Date(e.t).toLocaleTimeString()), h('span', {}, e.msg))));
  }

  $('autoheal').addEventListener('change', (e) => act('/api/settings', { autoheal: e.target.checked }, `Auto-heal ${e.target.checked ? 'on' : 'off'}`));

  // ---------------- create pod ----------------
  const cdlg = $('dlg-create');
  function openCreate(group) {
    const groups = (last && last.parked) || [];
    $('group').replaceChildren(...groups.map((g) => h('option', { value: g.group }, `${g.group} (${g.accounts.length} account${g.accounts.length === 1 ? '' : 's'})`)));
    $('opt-recover').classList.toggle('disabled', !groups.length);
    cdlg.querySelector('input[value=recover]').disabled = !groups.length;
    const radio = cdlg.querySelector(`input[value=${group ? 'recover' : 'fresh'}]`);
    radio.checked = true;
    if (group) $('group').value = group;
    syncGroup();
    cdlg.showModal();
  }
  const syncGroup = () => $('group-field').classList.toggle('hidden', cdlg.querySelector('input[name=cmode]:checked').value !== 'recover');
  cdlg.querySelectorAll('input[name=cmode]').forEach((r) => r.addEventListener('change', syncGroup));
  $('create').addEventListener('click', () => openCreate(null));
  $('create-cancel').addEventListener('click', () => cdlg.close());
  $('create-form').addEventListener('submit', async () => {
    const mode = cdlg.querySelector('input[name=cmode]:checked').value;
    try {
      const r = await api('POST', '/api/shards', { mode, group: mode === 'recover' ? $('group').value : undefined });
      toast(mode === 'recover' ? `Created ${r.name}, recovering ${r.recovered} account(s)` : `Created ${r.name}`);
    } catch (err) { toast(err.message, true); }
    cdlg.close(); refresh();
  });

  // ---------------- remove pod ----------------
  const rdlg = $('dlg-remove');
  let removing = null;
  async function removeFlow(s) {
    removing = s.name;
    try {
      await api('POST', `/api/shards/${s.name}/remove`, {});
      toast(`Removed ${s.name}`); refresh();
    } catch (err) {
      if (err.status === 409 && err.body.needsStrategy) {
        $('rm-title').textContent = `Remove ${s.name}`;
        $('rm-sub').textContent = `${s.name} holds ${err.body.accounts.length} account(s): ${err.body.accounts.join(', ')}. What should happen to them?`;
        rdlg.querySelector('input[value=move]').disabled = (last.shards.length < 2);
        rdlg.showModal();
      } else toast(err.message, true);
    }
  }
  $('rm-cancel').addEventListener('click', () => rdlg.close());
  $('remove-form').addEventListener('submit', async () => {
    const strategy = rdlg.querySelector('input[name=strategy]:checked').value;
    try { const r = await api('POST', `/api/shards/${removing}/remove`, { strategy }); toast(r.summary); }
    catch (err) { toast(err.message, true); }
    rdlg.close(); refresh();
  });

  api('GET', '/api/admin/me').then(start).catch(() => {});
})();
