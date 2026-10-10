/* Inspection AI Console - one page app for:
   - the platform team (clients, plans, library, platform AI keys, staff, audit)
   - client admins / managers / viewers (dashboard, inspections, actions, assets, schedules, templates, users, AI keys, settings)
   No framework, no build step. Uses the same sign-in token as the field app. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
  const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const num = (n) => (n === null || n === undefined ? '∞' : Number(n).toLocaleString());
  const splitCheck = (s) => { let t = String(s || '').trim(); const critical = t.startsWith('!'); if (critical) t = t.slice(1); const [n, ...r] = t.split('::'); return { name: n.trim(), rule: r.join('::').trim(), critical }; };
  const tag = (t) => (t && t !== 'NONE' ? `<span class="tag ${esc(t)}">${esc(t)}</span>` : '<span class="tag">–</span>');
  const pill = (v, label) => `<span class="pill ${esc(v)}">${esc(label ?? String(v || '').replace(/_/g, ' '))}</span>`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const S = { me: null, support: sessionStorage.getItem('ia_support') || '', supportName: sessionStorage.getItem('ia_support_name') || '', cache: {} };

  // ---------- toast / modal ----------
  let toastT;
  function toast(msg, err = false) {
    const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 6000 : 2800);
  }
  /** modal(title, bodyHtml, { submit: 'Save', onSubmit(form) -> true/undefined closes, danger, wide }) */
  function modal(title, body, opts = {}) {
    const dlg = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalErr').textContent = '';
    $('#modalFoot').innerHTML = (opts.extra || '') + `<button type="button" class="btn" id="mCancel">${opts.onSubmit ? 'Cancel' : 'Close'}</button>`
      + (opts.onSubmit ? `<button type="submit" class="btn ${opts.danger ? 'danger' : 'primary'}" id="mOk">${esc(opts.submit || 'Save')}</button>` : '');
    dlg.style.width = opts.wide ? 'min(980px, 96vw)' : '';
    $('#mCancel').onclick = () => dlg.close();
    $('#modalX').onclick = () => dlg.close();
    $('#modalForm').onsubmit = async (e) => {
      e.preventDefault();
      if (!opts.onSubmit) { dlg.close(); return; }
      const btn = $('#mOk'); btn.disabled = true;
      try { const keep = await opts.onSubmit($('#modalForm')); if (keep !== false) dlg.close(); }
      catch (err) { $('#modalErr').textContent = err.message; }
      finally { btn.disabled = false; }
    };
    if (!dlg.open) dlg.showModal();
    opts.onOpen?.($('#modalBody'));
    return dlg;
  }
  const formData = (form) => {
    const o = {};
    $$('[name]', form).forEach((el) => {
      if (el.type === 'checkbox') { if (el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else if (el.multiple) o[el.name] = [...el.selectedOptions].map((x) => x.value);
      else o[el.name] = el.value;
    });
    return o;
  };
  function zoom(src) {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${src}" alt="Photo" />`;
    lb.onclick = () => lb.remove(); document.body.appendChild(lb);
  }
  function credentials(title, rows) {
    modal(title, `<div class="cred">${rows.map(([k, v]) => `<div>${esc(k)}: <code>${esc(v)}</code></div>`).join('')}
      <p class="small">Copy this now and share it securely. The password is shown only once; the user must change it at first sign-in.</p></div>`);
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = LS.get('pc_token', '');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (S.support && !path.startsWith('/api/platform') && path !== '/api/auth/login') headers['X-Tenant-Id'] = S.support;
    let r;
    try { r = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
    catch { throw new Error('No connection to the server.'); }
    if (opts.raw) { if (!r.ok) throw new Error(`Request failed (${r.status})`); return r; }
    let data = {}; try { data = await r.json(); } catch {}
    if ((r.status === 401 || data.code === 'account_suspended') && path !== '/api/auth/login') { showLogin(data.error || 'Please sign in again.'); throw Object.assign(new Error(data.error || 'Please sign in.'), { status: r.status }); }
    if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, code: data.code });
    return data;
  }
  const get = (p) => api(p);
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });
  const put = (p, body) => api(p, { method: 'PUT', body: body || {} });
  const del = (p, body) => api(p, { method: 'DELETE', body: body || {} });
  const can = (perm) => Boolean(S.me?.permissions?.includes(perm));
  const isPlatform = () => Boolean(S.me?.platformRole);
  const isSuper = () => S.me?.platformRole === 'super_admin';
  const inTenant = () => Boolean(S.me?.tenant);

  // ---------- sign in ----------
  let pendingPw = '';
  function showLogin(msg) {
    $('#shell').hidden = true; $('#login').hidden = false;
    $('#loginFields').hidden = false; $('#pwFields').hidden = true;
    $('#loginTitle').textContent = 'Sign in'; $('#loginBtn').textContent = 'Sign in';
    if (msg) $('#loginHint').textContent = msg;
    $('#loginErr').textContent = '';
  }
  function showPwChange() {
    $('#shell').hidden = true; $('#login').hidden = false;
    $('#loginFields').hidden = true; $('#pwFields').hidden = false;
    $('#loginTitle').textContent = 'Set your password'; $('#loginBtn').textContent = 'Save password';
    $('#loginHint').textContent = 'Your password was set by an admin. Choose your own (8+ characters, letters and numbers).';
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    $('#loginErr').textContent = '';
    try {
      if (!$('#pwFields').hidden) {
        if (f.next !== f.next2) throw new Error('The two passwords are not the same.');
        const current = pendingPw || prompt('Current (temporary) password:') || '';
        const out = await post('/api/me/password', { current, next: f.next });
        LS.set('pc_token', out.token); LS.set('pc_token_exp', out.expiresAt);
        pendingPw = '';
      } else {
        const out = await post('/api/auth/login', { email: f.email, password: f.password });
        LS.set('pc_token', out.token); LS.set('pc_token_exp', out.expiresAt); LS.set('pc_login_user', f.email);
        if (out.user.mustChangePassword) { pendingPw = f.password; showPwChange(); return; }
      }
      await boot();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });
  $('#btnLogout').onclick = () => {
    if (!confirm('Sign out?')) return;
    localStorage.removeItem('pc_token'); localStorage.removeItem('pc_token_exp');
    sessionStorage.removeItem('ia_support'); S.support = ''; S.me = null;
    showLogin('You are signed out.');
  };
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  document.addEventListener('click', (e) => { const sd = $('#side'); if (sd.classList.contains('open') && !sd.contains(e.target) && !e.target.closest('#menuBtn,#mMore')) sd.classList.remove('open'); });

  // ---------- navigation ----------
  const TENANT_NAV = [
    ['Overview', [['dashboard', 'Dashboard', 'inspection.view'], ['inspections', 'Inspections', 'inspection.view'], ['actions', 'Corrective actions', 'action.view']]],
    ['Assets', [['assets', 'Asset register', 'asset.view'], ['schedules', 'Schedules', 'asset.view'], ['sites', 'Sites', 'site.view']]],
    ['Checklists', [['templates', 'Inspection types', 'template.manage'], ['library', 'Template library', 'template.manage']]],
    ['Administration', [['users', 'Users and roles', 'user.view'], ['ai', 'AI models', 'ai.manage'], ['settings', 'Company settings', 'settings.manage'], ['usage', 'Plan and usage', 'settings.manage'], ['audit', 'Audit log', 'audit.view']]],
  ];
  const PLATFORM_NAV = [
    ['Platform', [['p-overview', 'Overview'], ['p-clients', 'Clients'], ['p-plans', 'Plans'], ['p-library', 'Industries and library'], ['p-keys', 'Platform AI keys', 'super'], ['p-staff', 'Platform team'], ['p-audit', 'Audit log']]],
  ];
  function renderNav() {
    let html = '';
    if (isPlatform()) html += PLATFORM_NAV.map(([g, items]) => `<div class="grp">${g}</div>` + items.filter((i) => i[2] !== 'super' || isSuper()).map(([k, l]) => `<a href="#${k}" data-k="${k}">${l}</a>`).join('')).join('');
    if (inTenant()) html += (isPlatform() ? `<div class="grp">Client: ${esc(S.me.tenant.name)}</div>` : '') + TENANT_NAV.map(([g, items]) => {
      const vis = items.filter((i) => can(i[2]));
      return vis.length ? (isPlatform() ? '' : `<div class="grp">${g}</div>`) + vis.map(([k, l]) => `<a href="#${k}" data-k="${k}">${l}</a>`).join('') : '';
    }).join('');
    $('#nav').innerHTML = html;
    const t = S.me.tenant;
    $('#ctxBox').innerHTML = t ? `<b>${esc(t.name)}</b>${esc(S.me.roleLabel)}${t.status === 'trial' ? `, trial until ${fmtDate(t.trialEndsAt)}` : ''}` : `<b>Platform</b>${esc(S.me.roleLabel)}`;
    $('#who').textContent = `${S.me.user.name} (${S.me.user.email})`;
    const b = t?.branding || {};
    $('#brandName').textContent = b.app_name || 'Inspection AI';
    $('#brandLogo').hidden = !b.logo; if (b.logo) $('#brandLogo').src = b.logo;
    if (/^#[0-9a-f]{6}$/i.test(b.color || '')) document.documentElement.style.setProperty('--accent', b.color);
    // phone: bottom bar with the most used pages + back to the field app
    const ICON = {
      scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
      dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
      check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
      users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
      book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5"/>',
      menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    };
  const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
    const mb = [];
    if (inTenant() && can('inspect.run')) mb.push(['/', 'Inspect', 'scan']);
    if (inTenant()) {
      if (can('inspection.view')) mb.push(['#dashboard', 'Dashboard', 'dash'], ['#inspections', 'Inspections', 'list']);
      if (can('action.view')) mb.push(['#actions', 'Actions', 'check']);
    } else if (isPlatform()) mb.push(['#p-overview', 'Overview', 'dash'], ['#p-clients', 'Clients', 'users'], ['#p-library', 'Library', 'book']);
    $('#mbar').innerHTML = mb.slice(0, 4).map(([href, label, ic]) => `<a href="${href}" data-k="${href.slice(1)}">${icon(ic)}${label}</a>`).join('')
      + `<button type="button" id="mMore">${icon('menu')}More</button>`;
    $('#mbar').style.gridTemplateColumns = `repeat(${Math.min(mb.length, 4) + 1}, 1fr)`;
    $('#mMore').onclick = () => $('#side').classList.toggle('open');
    $('#supportBar').hidden = !S.me.support;
    $('#supportBar').innerHTML = `Support view: ${esc(t?.name || '')} ${isSuper() ? '' : '(read only)'} <button type="button" class="btn sm" id="exitSupport">Exit</button>`;
    $('#exitSupport')?.addEventListener('click', exitSupport);
  }
  async function enterSupport(id, name) {
    S.support = id; sessionStorage.setItem('ia_support', id); sessionStorage.setItem('ia_support_name', name || '');
    await boot('#dashboard');
  }
  async function exitSupport() {
    S.support = ''; sessionStorage.removeItem('ia_support');
    await boot('#p-clients');
  }

  const PAGES = {};
  async function route() {
    const [key, arg] = (location.hash.slice(1) || '').split('/');
    const def = isPlatform() && !inTenant() ? 'p-overview' : 'dashboard';
    const k = PAGES[key] ? key : def;
    $$('#mbar a').forEach((a) => a.classList.toggle('on', a.dataset.k === k));
    const navOn = $$('#nav a').find((a) => a.dataset.k === k || (k === 'inspection' && a.dataset.k === 'inspections') || (k === 'template' && a.dataset.k === 'templates') || (k === 'p-client' && a.dataset.k === 'p-clients'));
    $('#ptitle').textContent = navOn?.textContent || '';
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === k || (k === 'inspection' && a.dataset.k === 'inspections') || (k === 'template' && a.dataset.k === 'templates') || (k === 'p-client' && a.dataset.k === 'p-clients')));
    $('#side').classList.remove('open');
    const page = $('#page');
    page.innerHTML = '<p class="muted">Loading…</p>';
    try { await PAGES[k](page, arg ? decodeURIComponent(arg) : ''); }
    catch (e) { if (e.status !== 401) page.innerHTML = `<div class="card"><h2>Could not open this page</h2><p class="err">${esc(e.message)}</p></div>`; }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  async function boot(hash) {
    const token = LS.get('pc_token', '');
    if (!token) { showLogin(); return; }
    try { S.me = await get('/api/me'); } catch (e) { if (e.status === 401) return; showLogin(e.message); return; }
    if (S.me.user.mustChangePassword) { showPwChange(); return; }
    if (!isPlatform() && !can('console.open')) {
      $('#login').hidden = false; $('#shell').hidden = true;
      $('#loginHint').innerHTML = 'Inspectors use the field app. <a href="/">Open the field app</a>.';
      $('#loginFields').hidden = true; $('#loginBtn').hidden = true; return;
    }
    $('#login').hidden = true; $('#shell').hidden = false;
    renderNav();
    if (hash && location.hash !== hash) location.hash = hash; else route();
  }

  // ---------- helpers for pages ----------
  const head = (title, sub = '', actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="actions no-print">${actions}</div></div>`;
  const plain = (html) => String(html).replace(/<[^>]*>/g, '').trim();
  function labelCells(row, cols) {
    let i = 0;
    return row.replace(/<td(?=[\s>])/g, () => { const l = plain(cols[i++] ?? ''); return l ? `<td data-label="${esc(l)}"` : '<td data-label="" class="nolabel"'; });
  }
  const table = (cols, rows, empty = 'Nothing here yet.') => `<div class="tbl-wrap"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => labelCells(r, cols)).join('') : `<tr><td colspan="${cols.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(sel ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const fld = (label, inner, hint = '') => `<label class="field"><span>${esc(label)}</span>${inner}${hint ? `<small>${hint}</small>` : ''}</label>`;
  const inp = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs} />`;
  const chk = (name, checked, label) => `<label class="check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} /><span>${label}</span></label>`;
  async function cached(key, path) { if (!S.cache[key]) S.cache[key] = await get(path); return S.cache[key]; }
  const sites = async () => (await cached('sites', '/api/sites')).sites;
  const templatesAll = async () => (await cached('tpl', '/api/templates?all=1')).templates;
  const people = async () => (await cached('people', '/api/people')).people;
  const bust = (...k) => k.forEach((x) => delete S.cache[x]);
  function imageToDataUrl(file, side = 1024, q = 0.75) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { const s = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', q)); };
      img.onerror = () => reject(new Error('Could not read that image.')); img.src = url;
    });
  }
  async function downloadCsv(path, name) {
    const r = await api(path, { raw: true });
    const blob = await r.blob(); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function downloadJson(obj, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 500);
  }
  function parseCsv(text) {
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  function trendChart(trend) {
    const w = 700; const h = 170; const max = Math.max(1, ...trend.map((d) => d.GREEN + d.YELLOW + d.RED));
    const bw = w / trend.length;
    const bars = trend.map((d, i) => {
      let y = h; const parts = [];
      for (const [k, col] of [['GREEN', '#1F7A47'], ['YELLOW', '#E9B200'], ['RED', '#C33A22']]) {
        const bh = (d[k] / max) * (h - 10); y -= bh;
        if (bh > 0) parts.push(`<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"><title>${d.date}: ${d[k]} ${k.toLowerCase()}</title></rect>`);
      }
      return parts.join('');
    }).join('');
    return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Inspections per day">${bars}<line x1="0" y1="${h}" x2="${w}" y2="${h}" stroke="#D3D8D2"/></svg>
      <div class="legend"><span><i style="background:#1F7A47"></i>Green</span><span><i style="background:#E9B200"></i>Yellow</span><span><i style="background:#C33A22"></i>Red</span><span class="muted">${esc(trend[0]?.date || '')} to ${esc(trend[trend.length - 1]?.date || '')}</span></div></div>`;
  }

  // ======================= CLIENT PAGES =======================
  PAGES.dashboard = async (el) => {
    const days = Number(sessionStorage.getItem('ia_days')) || 30;
    const site = sessionStorage.getItem('ia_dsite') || '';
    const [d, ss] = await Promise.all([get(`/api/dashboard?days=${days}${site ? '&site=' + site : ''}`), sites()]);
    const t = d.totals;
    const ai = S.me.ai || {};
    el.innerHTML = head('Dashboard', `${esc(S.me.tenant.name)}, last ${days} days`, `
        <select id="dSite" aria-label="Site">${opt('', 'All sites', site)}${ss.map((x) => opt(x.id, x.name, site)).join('')}</select>
        <select id="dDays" aria-label="Period">${[7, 30, 90, 365].map((n) => opt(n, `Last ${n} days`, days)).join('')}</select>`)
      + (!ai.ready ? `<div class="card" style="border-color:var(--red)"><b>AI is not set up.</b><p>${esc(ai.message || '')} ${can('ai.manage') ? '<a href="#ai">Add an AI key</a>' : ''}</p></div>` : '')
      + `<div class="kpis">
        <a class="kpi" href="#inspections"><b>${t.inspections}</b><span>Inspections</span></a>
        <a class="kpi GREEN" href="#inspections" data-tag="GREEN"><b>${t.passRate}%</b><span>Passed (green)</span></a>
        <a class="kpi YELLOW" href="#inspections" data-tag="YELLOW"><b>${t.YELLOW}</b><span>Needs review (yellow)</span></a>
        <a class="kpi RED" href="#inspections" data-tag="RED"><b>${t.RED}</b><span>Failed (red)</span></a>
        <a class="kpi ${t.pendingReview ? 'warn' : ''}" href="#inspections" data-review="pending"><b>${t.pendingReview}</b><span>Awaiting review</span></a>
        <a class="kpi ${t.overdueActions ? 'warn' : ''}" href="#actions"><b>${t.openActions}</b><span>Open actions, ${t.overdueActions} overdue</span></a>
        <a class="kpi ${t.overdueInspections ? 'warn' : ''}" href="#schedules"><b>${t.overdueInspections}</b><span>Overdue inspections</span></a>
      </div>
      <div class="card"><div class="head"><h2>Results per day</h2></div>${trendChart(d.trend)}</div>
      <div class="grid g2">
        <div class="card"><h2>By inspection type</h2>${table(['Type', 'Total', 'Red', 'Pass rate'], d.byTemplate.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.total}</td><td>${g.RED}</td><td><div class="bar"><i style="width:${g.passRate}%"></i></div>${g.passRate}%</td></tr>`))}</div>
        <div class="card"><h2>Most failed checks</h2>${table(['Check', 'Type', 'Times'], d.topFailing.map((f) => `<tr><td>${esc(f.check)}</td><td>${esc(f.template)}</td><td>${f.count}</td></tr>`), 'No failed checks in this period.')}</div>
        <div class="card"><h2>By site</h2>${table(['Site', 'Total', 'Red', 'Pass rate'], d.bySite.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.total}</td><td>${g.RED}</td><td>${g.passRate}%</td></tr>`))}</div>
        <div class="card"><h2>Recent red results</h2>${table(['Date', 'Type', 'Asset', 'Inspector'], d.recentRed.map((x) => `<tr class="click" data-href="#inspection/${x.id}"><td>${fmtDate(x.createdAt)}</td><td>${esc(x.template)}</td><td>${esc(x.asset)}</td><td>${esc(x.inspector)}</td></tr>`), 'No red results. 👍')}</div>
      </div>`;
    $('#dDays').onchange = (e) => { sessionStorage.setItem('ia_days', e.target.value); route(); };
    $('#dSite').onchange = (e) => { sessionStorage.setItem('ia_dsite', e.target.value); route(); };
    $$('[data-tag],[data-review]', el).forEach((a) => a.addEventListener('click', () => { sessionStorage.setItem('ia_if', JSON.stringify({ tag: a.dataset.tag || '', review: a.dataset.review || '' })); }));
    wireClicks(el);
  };
  function wireClicks(el) { $$('tr[data-href]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; })); }

  // ---------- inspections ----------
  PAGES.inspections = async (el) => {
    const f = { q: '', tag: '', template: '', site: '', review: '', from: '', to: '', ...JSON.parse(sessionStorage.getItem('ia_if') || '{}') };
    const [tp, ss] = await Promise.all([templatesAll(), sites()]);
    const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    el.innerHTML = head('Inspections', 'Every inspection saved by your team, with photos and AI evidence.', can('report.view') ? '<button class="btn" id="csv">Export CSV</button>' : '')
      + `<div class="card no-print"><form class="filters" id="ff">
        ${fld('Search', inp('q', f.q, 'placeholder="Asset, type, location, inspector"'))}
        ${fld('Result', `<select name="tag">${opt('', 'Any', f.tag)}${['GREEN', 'YELLOW', 'RED'].map((x) => opt(x, x, f.tag)).join('')}</select>`)}
        ${fld('Type', `<select name="template">${opt('', 'Any', f.template)}${tp.map((x) => opt(x.id, x.name, f.template)).join('')}</select>`)}
        ${fld('Site', `<select name="site">${opt('', 'Any', f.site)}${ss.map((x) => opt(x.id, x.name, f.site)).join('')}</select>`)}
        ${fld('Review', `<select name="review">${opt('', 'Any', f.review)}${[['pending', 'Awaiting review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['not_required', 'Not required']].map(([v, l]) => opt(v, l, f.review)).join('')}</select>`)}
        ${fld('From', inp('from', f.from, 'type="date"'))}${fld('To', inp('to', f.to, 'type="date"'))}
        <button class="btn primary">Apply</button><button type="button" class="btn" id="fr">Clear</button></form></div>
      <div id="list"></div>`;
    let offset = 0;
    const load = async () => {
      const out = await get(`/api/inspections?limit=50&offset=${offset}&${qs()}`);
      $('#list', el).innerHTML = table(['Date', 'Result', 'Type', 'Asset', 'Site / location', 'Inspector', 'Done', 'Review'], out.inspections.map((x) => `<tr class="click" data-href="#inspection/${x.id}">
          <td>${fmtDT(x.createdAt)}</td><td>${tag(x.finalTag)}</td><td>${esc(x.templateName)}</td><td><b>${esc(x.assetCode)}</b></td>
          <td>${esc([x.siteName, x.location].filter(Boolean).join(', '))}</td><td>${esc(x.inspectorName)}</td><td>${x.completion}%</td>
          <td>${x.reviewStatus === 'not_required' ? '' : pill(x.reviewStatus)}</td></tr>`), 'No inspections match.')
        + `<div class="actions" style="margin-top:.6rem"><span class="muted">${out.total ? `${offset + 1} to ${offset + out.inspections.length} of ${out.total}` : ''}</span>
           ${offset > 0 ? '<button class="btn sm" id="prev">Previous</button>' : ''}${offset + 50 < out.total ? '<button class="btn sm" id="next">Next</button>' : ''}</div>`;
      wireClicks(el);
      $('#prev', el)?.addEventListener('click', () => { offset -= 50; load(); });
      $('#next', el)?.addEventListener('click', () => { offset += 50; load(); });
    };
    $('#ff', el).onsubmit = (e) => { e.preventDefault(); Object.assign(f, formData(e.target)); sessionStorage.setItem('ia_if', JSON.stringify(f)); offset = 0; load(); };
    $('#fr', el).onclick = () => { sessionStorage.removeItem('ia_if'); route(); };
    $('#csv', el)?.addEventListener('click', () => downloadCsv('/api/export/inspections.csv?' + qs(), `inspections-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => toast(e.message, true)));
    await load();
  };

  PAGES.inspection = async (el, id) => {
    const x = (await get('/api/inspections/' + encodeURIComponent(id))).inspection;
    const r = x.result || {}; const m = x.meta || {};
    const rows = (r.checklist || []).map((c) => { const sc = splitCheck(c.part); return `<tr><td>${esc(c.group)}</td><td>${sc.critical || c.critical ? '<b>⚠</b> ' : ''}${esc(sc.name)}${sc.rule ? `<div class="muted small">Must be: ${esc(sc.rule)}</div>` : ''}</td>
      <td class="st-${esc(c.status)}">${{ present: 'OK', missing: 'Not OK', unclear: 'Unclear' }[c.status] || esc(c.status)}</td><td>${Math.round((c.confidence || 0) * 100)}%</td><td class="small">${esc(c.note)}</td></tr>`; });
    const custom = Object.values(m.custom || {}).map((c) => `${esc(c.label)}: ${esc(c.value === true ? 'yes' : c.value)}`).join(', ');
    el.innerHTML = head(`${x.templateName} ${x.assetCode || ''}`, `${fmtDT(x.createdAt)}, by ${esc(x.inspectorName)}`, `
        <a class="btn" href="#inspections">Back</a>
        <a class="btn" href="/report?id=${encodeURIComponent(x.id)}" target="_blank" rel="noopener">PDF report</a>
        ${can('action.manage') ? '<button class="btn" id="newAct">Add action</button>' : ''}
        ${can('inspection.review') ? '<button class="btn primary" id="approve">Approve</button><button class="btn danger" id="reject">Reject</button>' : ''}
        ${can('inspection.delete') ? '<button class="btn danger" id="delIns">Delete</button>' : ''}`)
      + `<div class="grid g3">
        <div class="card"><h2>Result</h2><div>${tag(x.finalTag)} ${x.override?.status ? '<span class="muted small">set by inspector</span>' : ''}</div>
          <p>AI: ${esc(x.aiStatus)}, ${x.completion}% of checks OK (${x.counts.present || 0} OK, ${x.counts.missing || 0} not OK, ${x.counts.unclear || 0} unclear)</p>
          <p class="muted small">AI ${esc(x.provider || '')} ${esc(x.model || '')}${r.secondCheck ? ', every OK double-checked' : ''}. Mode: ${esc(x.mode)}</p></div>
        <div class="card"><h2>Details</h2><p>Site: ${esc(x.siteName || '–')}<br>Location: ${esc(x.location || '–')}<br>${custom ? custom + '<br>' : ''}${m.reason ? 'Reason: ' + esc(m.reason) + '<br>' : ''}${m.notes ? 'Notes: ' + esc(m.notes) + '<br>' : ''}${m.gps ? `GPS: <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${m.gps.lat},${m.gps.lng}">${m.gps.lat}, ${m.gps.lng}</a>` : ''}</p></div>
        <div class="card"><h2>Sign-off and review</h2><p>${x.signoff?.done ? `Signed off by ${esc(x.signoff.by)}, ${fmtDT(x.signoff.at)}` : 'Not signed off'}</p>
          ${x.override?.remarks ? `<p>Remarks: ${esc(x.override.remarks)}</p>` : ''}
          <p>Review: ${x.reviewStatus === 'not_required' ? 'not required' : pill(x.reviewStatus)} ${x.review ? `by ${esc(x.review.by)} ${fmtDT(x.review.at)}${x.review.comment ? ': ' + esc(x.review.comment) : ''}` : ''}</p></div>
      </div>
      ${(r.reasons || []).length ? `<div class="card"><h2>Why this result</h2><ul>${r.reasons.map((z) => `<li>${esc(z)}</li>`).join('')}</ul>${r.ai?.summary ? `<p class="muted">${esc(r.ai.summary)}</p>` : ''}</div>` : ''}
      <div class="card"><h2>Photos</h2><div class="photos">${x.photos.map((p) => `<figure><img src="${p.dataUrl}" alt="${esc(p.view)}" data-z /><figcaption>${esc(p.view)}</figcaption></figure>`).join('') || '<p class="muted">No photos saved.</p>'}</div></div>
      <div class="card"><h2>Checks</h2>${table(['View', 'Check', 'Status', 'Conf.', 'AI evidence'], rows)}</div>
      ${(r.ai?.defects || []).length ? `<div class="card"><h2>Damage spotted</h2><ul>${r.ai.defects.map((d) => `<li>${pill(d.severity)} ${esc(d.description)} <span class="muted">${esc(d.angle || '')}</span></li>`).join('')}</ul></div>` : ''}
      <div class="card"><h2>Corrective actions</h2>${table(['Action', 'Severity', 'Status', 'Due', 'Assigned'], x.actions.map((a) => `<tr><td>${esc(a.title)}</td><td>${pill(a.severity)}</td><td>${pill(a.status)}</td><td>${fmtDate(a.dueAt)}</td><td>${esc(a.assigneeName)}</td></tr>`), 'No actions.')}</div>`;
    $$('[data-z]', el).forEach((img) => img.addEventListener('click', () => zoom(img.src)));
    const review = (decision) => modal(decision === 'approved' ? 'Approve inspection' : 'Reject inspection', fld('Comment', `<textarea name="comment" rows="3" ${decision === 'rejected' ? 'required' : ''} placeholder="${decision === 'rejected' ? 'Say what must be redone' : 'Optional'}"></textarea>`), {
      submit: decision === 'approved' ? 'Approve' : 'Reject', danger: decision === 'rejected',
      onSubmit: async (f) => { await post(`/api/inspections/${x.id}/review`, { decision, comment: formData(f).comment }); toast('Saved'); route(); },
    });
    $('#approve', el)?.addEventListener('click', () => review('approved'));
    $('#reject', el)?.addEventListener('click', () => review('rejected'));
    $('#newAct', el)?.addEventListener('click', () => actionModal({ inspectionId: x.id }));
    $('#delIns', el)?.addEventListener('click', async () => { if (!confirm('Delete this inspection and its photos? This cannot be undone.')) return; await del('/api/inspections/' + x.id); toast('Deleted'); location.hash = '#inspections'; });
  };

  // ---------- corrective actions ----------
  async function actionModal(a = {}) {
    const ppl = await people();
    const isNew = !a.id;
    const mgr = can('action.manage');
    modal(isNew ? 'New corrective action' : 'Corrective action', `
      ${mgr ? fld('What needs to be done', inp('title', a.title || '', 'required maxlength="200"')) : `<h3>${esc(a.title)}</h3>`}
      ${mgr ? fld('Details', `<textarea name="description" rows="2">${esc(a.description || '')}</textarea>`) : `<p>${esc(a.description || '')}</p>`}
      <div class="fgrid">
        ${mgr ? fld('Severity', `<select name="severity">${['low', 'medium', 'high', 'critical'].map((s) => opt(s, s, a.severity || 'medium')).join('')}</select>`) : ''}
        ${mgr ? fld('Assigned to', `<select name="assigneeId">${opt('', 'Nobody yet', a.assigneeId)}${ppl.map((p) => opt(p.id, p.name, a.assigneeId)).join('')}</select>`) : ''}
        ${mgr ? fld('Due date', inp('dueAt', a.dueAt ? a.dueAt.slice(0, 10) : '', 'type="date"')) : ''}
        ${!isNew ? fld('Status', `<select name="status">${(mgr ? ['open', 'in_progress', 'done', 'verified', 'cancelled'] : ['open', 'in_progress', 'done']).map((s) => opt(s, s.replace('_', ' '), a.status)).join('')}</select>`) : ''}
      </div>
      ${!isNew ? fld('Closure note', `<textarea name="closureNote" rows="2">${esc(a.closureNote || '')}</textarea>`) : ''}
      ${!isNew && a.hasClosurePhoto ? '<button type="button" class="link" id="seePhoto">See closure photo</button>' : ''}`, {
      onSubmit: async (f) => {
        const d = formData(f);
        if (isNew) await post('/api/actions', { ...d, inspectionId: a.inspectionId });
        else await put('/api/actions/' + a.id, d);
        toast('Saved'); route();
      },
      onOpen: (b) => $('#seePhoto', b)?.addEventListener('click', async () => { const p = await get(`/api/actions/${a.id}/photo`); if (p.dataUrl) zoom(p.dataUrl); }),
    });
  }
  PAGES.actions = async (el) => {
    const st = sessionStorage.getItem('ia_as') || 'open';
    const out = await get('/api/actions?status=' + st);
    el.innerHTML = head('Corrective actions', 'Created automatically from failed checks, or added by managers. Assignees close them from the field app with a note and photo.',
      `<select id="as">${[['open', 'Open'], ['done', 'Done (to verify)'], ['verified', 'Verified'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) => opt(v, l, st)).join('')}</select>${can('action.manage') ? '<button class="btn primary" id="na">New action</button>' : ''}`)
      + table(['Severity', 'Action', 'Asset', 'Site', 'Assigned', 'Due', 'Status'], out.actions.map((a, i) => `<tr class="click" data-i="${i}">
          <td>${pill(a.severity)}</td><td>${esc(a.title)}</td><td>${esc(a.assetCode)}</td><td>${esc(a.siteName)}</td><td>${esc(a.assigneeName) || '<span class="muted">–</span>'}</td>
          <td>${fmtDate(a.dueAt)} ${a.overdue ? pill('overdue') : ''}</td><td>${pill(a.status)}</td></tr>`), 'No actions here.');
    $('#as', el).onchange = (e) => { sessionStorage.setItem('ia_as', e.target.value); route(); };
    $('#na', el)?.addEventListener('click', () => actionModal());
    $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => actionModal(out.actions[+tr.dataset.i])));
  };

  // ---------- assets ----------
  async function assetModal(a = {}) {
    const [ss, tp] = await Promise.all([sites(), templatesAll()]);
    modal(a.id ? `Asset ${a.code}` : 'New asset', `<div class="fgrid">
      ${fld('Asset ID / code', inp('code', a.code || '', 'required maxlength="80"'), 'Printed on the QR label')}
      ${fld('Name', inp('name', a.name || '', 'placeholder="e.g. CO2 extinguisher 4.5 kg"'))}
      ${fld('Inspection type', `<select name="templateId">${opt('', 'Not set', a.templateId)}${tp.map((t) => opt(t.id, t.name, a.templateId)).join('')}</select>`)}
      ${fld('Site', `<select name="siteId">${opt('', 'No site', a.siteId)}${ss.map((s) => opt(s.id, s.name, a.siteId)).join('')}</select>`)}
      ${fld('Location', inp('location', a.location || ''))}
      ${fld('Next due', inp('nextDueAt', a.nextDueAt ? a.nextDueAt.slice(0, 10) : '', 'type="date"'))}
      ${a.id ? fld('Status', `<select name="status">${[['active', 'Active'], ['out_of_service', 'Out of service'], ['retired', 'Retired']].map(([v, l]) => opt(v, l, a.status)).join('')}</select>`) : ''}
      </div><div id="hist"></div>`, {
      extra: a.id && can('asset.manage') ? '<button type="button" class="btn danger" id="delA">Delete</button>' : '',
      onSubmit: can('asset.manage') ? async (f) => {
        const d = formData(f); if (d.nextDueAt) d.nextDueAt = new Date(d.nextDueAt).toISOString();
        if (a.id) await put('/api/assets/' + a.id, d); else await post('/api/assets', d);
        toast('Saved'); route();
      } : null,
      onOpen: async (b) => {
        $('#delA')?.addEventListener('click', async () => { if (!confirm(`Delete asset ${a.code}? Its inspections are kept.`)) return; await del('/api/assets/' + a.id); $('#modal').close(); toast('Deleted'); route(); });
        if (!a.id) return;
        const d = await get('/api/assets/' + a.id);
        $('#hist', b).innerHTML = '<h3>History</h3>' + table(['Date', 'Result', 'Type', 'Inspector'], d.history.map((h) => `<tr class="click" data-href="#inspection/${h.id}"><td>${fmtDate(h.created_at)}</td><td>${tag(h.final_tag)}</td><td>${esc(h.template_name)}</td><td>${esc(h.inspector_name)}</td></tr>`), 'Not inspected yet.')
          + (d.actions.length ? '<h3>Open actions</h3><ul>' + d.actions.map((x) => `<li>${pill(x.severity)} ${esc(x.title)}</li>`).join('') + '</ul>' : '');
        $$('tr[data-href]', b).forEach((tr) => tr.addEventListener('click', () => { $('#modal').close(); location.hash = tr.dataset.href; }));
      },
    });
  }
  PAGES.assets = async (el) => {
    const f = JSON.parse(sessionStorage.getItem('ia_af') || '{}');
    const [ss, tp] = await Promise.all([sites(), templatesAll()]);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const out = await get('/api/assets?' + qs);
    el.innerHTML = head('Asset register', 'Every inspected item with its last result and next due date. Assets are also added automatically the first time they are inspected.', `
        ${can('asset.manage') ? '<button class="btn" id="imp">Import CSV</button><button class="btn primary" id="na">New asset</button>' : ''}
        <button class="btn" id="qr">Print QR labels</button>`)
      + `<div class="card no-print"><form class="filters" id="ff">
          ${fld('Search', inp('q', f.q || '', 'placeholder="Code, name, location"'))}
          ${fld('Site', `<select name="site">${opt('', 'Any', f.site)}${ss.map((x) => opt(x.id, x.name, f.site)).join('')}</select>`)}
          ${fld('Type', `<select name="template">${opt('', 'Any', f.template)}${tp.map((x) => opt(x.id, x.name, f.template)).join('')}</select>`)}
          ${fld('Due', `<select name="due">${opt('', 'Any', f.due)}${opt('overdue', 'Overdue only', f.due)}</select>`)}
          <button class="btn primary">Apply</button></form></div>`
      + table(['<input type="checkbox" id="all" aria-label="Select all" />', 'Code', 'Name', 'Type', 'Site / location', 'Last result', 'Next due', 'Status'], out.assets.map((a, i) => `<tr class="click" data-i="${i}">
          <td><input type="checkbox" class="sel" value="${i}" aria-label="Select" /></td><td><b>${esc(a.code)}</b></td><td>${esc(a.name)}</td><td>${esc(a.templateName)}</td>
          <td>${esc([a.siteName, a.location].filter(Boolean).join(', '))}</td><td>${tag(a.lastTag)} <span class="muted small">${a.lastInspectedAt ? fmtDate(a.lastInspectedAt) : ''}</span></td>
          <td>${fmtDate(a.nextDueAt)} ${a.overdue ? pill('overdue') : ''}</td><td>${a.status === 'active' ? '' : pill(a.status)}</td></tr>`), 'No assets yet.');
    $('#ff', el).onsubmit = (e) => { e.preventDefault(); sessionStorage.setItem('ia_af', JSON.stringify(formData(e.target))); route(); };
    $('#na', el)?.addEventListener('click', () => assetModal());
    $('#all', el)?.addEventListener('change', (e) => $$('.sel', el).forEach((c) => { c.checked = e.target.checked; }));
    $$('.sel', el).forEach((c) => c.addEventListener('click', (e) => e.stopPropagation()));
    $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => assetModal(out.assets[+tr.dataset.i])));
    $('#imp', el)?.addEventListener('click', () => modal('Import assets from CSV', `<p>Columns (first row = headers): <code>code, name, location, site, type</code>. Site and type are matched by name. Existing codes are updated.</p>
        ${fld('CSV file', '<input type="file" name="file" accept=".csv,text/csv" required />')}`, {
      submit: 'Import',
      onSubmit: async (form) => {
        const file = $('input[type=file]', form).files[0]; if (!file) throw new Error('Choose a file.');
        const rows = parseCsv(await file.text());
        const h = rows.shift().map((x) => x.trim().toLowerCase());
        const data = rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] || ''])));
        const res = await post('/api/assets/import', { rows: data });
        toast(`${res.created} added, ${res.updated} updated${res.errors.length ? ', ' + res.errors.length + ' skipped' : ''}`); route();
      },
    }));
    $('#qr', el).onclick = () => {
      const chosen = $$('.sel:checked', el).map((c) => out.assets[+c.value]);
      const list = chosen.length ? chosen : out.assets;
      if (!list.length) { toast('No assets to print.', true); return; }
      printQr(list);
    };
  };
  async function printQr(list) {
    if (!window.QRCode) {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the QR library (needs internet).')); document.head.appendChild(s); }).catch((e) => { toast(e.message, true); throw e; });
    }
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print labels.', true); return; }
    const base = location.origin + '/?asset=';
    const holder = document.createElement('div');
    const imgs = list.map((a) => { holder.innerHTML = ''; new window.QRCode(holder, { text: base + encodeURIComponent(a.code), width: 160, height: 160 }); const c = holder.querySelector('canvas'); return { a, src: c ? c.toDataURL() : holder.querySelector('img')?.src }; });
    w.document.write(`<html><head><title>QR labels</title><style>body{font-family:Arial;margin:12px}.g{display:grid;grid-template-columns:repeat(auto-fill,200px);gap:12px}.l{border:1px dashed #888;padding:8px;text-align:center;font-weight:700}.l small{display:block;font-weight:400;font-size:11px}</style></head><body>
      <div class="g">${imgs.map(({ a, src }) => `<div class="l"><img src="${src}" width="160" height="160"/><div>${esc(a.code)}</div><small>${esc([a.name, a.location].filter(Boolean).join(', '))}</small></div>`).join('')}</div>
      <script>setTimeout(()=>print(),400)<\/script></body></html>`);
    w.document.close();
  }

  // ---------- schedules ----------
  PAGES.schedules = async (el) => {
    const out = await get('/api/schedules');
    el.innerHTML = head('Schedules', 'Recurring inspections. They show as due on the inspectors\' home screen, and move forward each time the inspection is saved.', can('schedule.manage') ? '<button class="btn primary" id="ns">New schedule</button>' : '')
      + table(['Title', 'Type', 'Asset', 'Site', 'Every', 'Next due', 'Assigned', 'Active'], out.schedules.map((s, i) => `<tr class="click" data-i="${i}">
        <td>${esc(s.title || s.template_name)}</td><td>${esc(s.template_name)}</td><td>${esc(s.asset_code || 'Any')}</td><td>${esc(s.site_name || 'Any')}</td>
        <td>${s.frequency_days} days</td><td>${fmtDate(s.next_due_at)} ${s.overdue ? pill('overdue') : ''}</td><td>${esc(s.assignee_name || '')}</td><td>${s.active ? 'Yes' : 'No'}</td></tr>`), 'No schedules yet.');
    const edit = async (s = {}) => {
      const [tp, ss, ppl, as] = await Promise.all([templatesAll(), sites(), people(), get('/api/assets')]);
      modal(s.id ? 'Edit schedule' : 'New schedule', `<div class="fgrid">
        ${fld('Title', inp('title', s.title || '', 'placeholder="e.g. Monthly extinguisher round"'))}
        ${fld('Inspection type', `<select name="templateId" required>${opt('', 'Choose', s.template_id)}${tp.map((t) => opt(t.id, t.name, s.template_id)).join('')}</select>`)}
        ${fld('Asset (optional)', `<select name="assetId">${opt('', 'Any asset of this type', s.asset_id)}${as.assets.map((a) => opt(a.id, a.code + (a.name ? ' - ' + a.name : ''), s.asset_id)).join('')}</select>`)}
        ${fld('Site', `<select name="siteId">${opt('', 'Any site', s.site_id)}${ss.map((x) => opt(x.id, x.name, s.site_id)).join('')}</select>`)}
        ${fld('Every (days)', inp('frequencyDays', s.frequency_days || 30, 'type="number" min="1" max="3650" required'), '1 = daily, 7 = weekly, 30 = monthly')}
        ${fld('Next due', inp('nextDueAt', (s.next_due_at || new Date().toISOString()).slice(0, 10), 'type="date"'))}
        ${fld('Assigned to', `<select name="assigneeId">${opt('', 'Anyone', s.assignee_id)}${ppl.map((p) => opt(p.id, p.name, s.assignee_id)).join('')}</select>`)}
        </div>${chk('active', s.id ? s.active : true, 'Active')}`, {
        extra: s.id ? '<button type="button" class="btn danger" id="dels">Delete</button>' : '',
        onSubmit: async (f) => { const d = formData(f); if (s.id) await put('/api/schedules/' + s.id, d); else await post('/api/schedules', d); toast('Saved'); route(); },
        onOpen: () => $('#dels')?.addEventListener('click', async () => { if (!confirm('Delete this schedule?')) return; await del('/api/schedules/' + s.id); $('#modal').close(); route(); }),
      });
    };
    $('#ns', el)?.addEventListener('click', () => edit());
    if (can('schedule.manage')) $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => edit(out.schedules[+tr.dataset.i])));
  };

  // ---------- sites ----------
  PAGES.sites = async (el) => {
    bust('sites');
    const ss = await sites();
    el.innerHTML = head('Sites', 'Plants, buildings, warehouses or projects. Users can be limited to certain sites.', can('site.manage') ? '<button class="btn primary" id="ns">New site</button>' : '')
      + table(['Name', 'Code', 'Address', 'Assets'], ss.map((s, i) => `<tr class="click" data-i="${i}"><td><b>${esc(s.name)}</b></td><td>${esc(s.code)}</td><td>${esc(s.address)}</td><td>${s.asset_count}</td></tr>`), 'No sites yet.');
    const edit = (s = {}) => modal(s.id ? 'Edit site' : 'New site', `${fld('Name', inp('name', s.name || '', 'required'))}${fld('Code', inp('code', s.code || ''))}${fld('Address', `<textarea name="address" rows="2">${esc(s.address || '')}</textarea>`)}${fld('Notes', `<textarea name="notes" rows="2">${esc(s.notes || '')}</textarea>`)}`, {
      extra: s.id ? '<button type="button" class="btn danger" id="dels">Delete</button>' : '',
      onSubmit: async (f) => { if (s.id) await put('/api/sites/' + s.id, formData(f)); else await post('/api/sites', formData(f)); bust('sites'); toast('Saved'); route(); },
      onOpen: () => $('#dels')?.addEventListener('click', async () => { if (!confirm('Delete this site?')) return; try { await del('/api/sites/' + s.id); $('#modal').close(); bust('sites'); route(); } catch (e) { $('#modalErr').textContent = e.message; } }),
    });
    $('#ns', el)?.addEventListener('click', () => edit());
    if (can('site.manage')) $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => edit(ss[+tr.dataset.i])));
  };

  // ---------- users ----------
  PAGES.users = async (el) => {
    const [out, ss] = await Promise.all([get('/api/users'), sites()]);
    el.innerHTML = head('Users and roles', out.roles.map((r) => `<b>${esc(r.label)}</b>: ${esc(r.description)}`).join('<br>'), can('user.manage') ? '<button class="btn primary" id="nu">Add user</button>' : '')
      + table(['Name', 'Email', 'Role', 'Sites', 'Status', 'Last sign-in'], out.users.map((u, i) => `<tr class="click" data-i="${i}"><td><b>${esc(u.name)}</b>${u.title ? `<div class="muted small">${esc(u.title)}</div>` : ''}</td><td>${esc(u.email)}</td><td>${esc(u.roleLabel)}</td>
        <td>${u.siteIds.length ? esc(u.siteIds.map((id) => ss.find((s) => s.id === id)?.name).filter(Boolean).join(', ')) : 'All'}</td><td>${pill(u.status)}</td><td>${fmtDT(u.lastLoginAt)}</td></tr>`));
    const edit = (u = {}) => modal(u.id ? `Edit ${u.name}` : 'Add user', `<div class="fgrid">
      ${fld('Email (sign-in)', inp('email', u.email || '', `type="email" required ${u.id ? 'readonly' : ''}`))}
      ${fld('Name', inp('name', u.name || '', 'required'))}
      ${fld('Role', `<select name="role">${out.roles.map((r) => opt(r.id, r.label, u.role || 'inspector')).join('')}</select>`)}
      ${fld('Job title', inp('title', u.title || ''))}
      ${fld('Phone', inp('phone', u.phone || ''))}${fld('Employee ID', inp('empId', u.empId || ''))}
      ${u.id ? fld('Status', `<select name="status">${opt('active', 'Active', u.status)}${opt('disabled', 'Disabled', u.status)}</select>`) : fld('Password', inp('password', '', 'type="text" autocomplete="off" placeholder="Leave empty to generate"'))}
      </div>
      ${ss.length ? fld('Limit to sites (none ticked = all sites)', `<div>${ss.map((s) => `<label class="check"><input type="checkbox" name="siteIds" data-multi="1" value="${esc(s.id)}" ${(u.siteIds || []).includes(s.id) ? 'checked' : ''}/><span>${esc(s.name)}</span></label>`).join('')}</div>`) : ''}`, {
      extra: u.id ? '<button type="button" class="btn" id="rp">Reset password</button>' : '',
      onSubmit: async (f) => {
        const d = formData(f);
        if (u.id) { await put('/api/users/' + u.id, d); toast('Saved'); route(); }
        else { const r = await post('/api/users', d); route(); await sleep(50); credentials('User created', [['Email', r.user.email], ['Temporary password', r.tempPassword], ['Sign-in link', location.origin + '/']]); return false; }
      },
      onOpen: () => $('#rp')?.addEventListener('click', async () => { if (!confirm(`Reset the password for ${u.name}? They will be signed out.`)) return; const r = await post(`/api/users/${u.id}/reset-password`); credentials('New temporary password', [['Email', u.email], ['Password', r.tempPassword]]); }),
    });
    $('#nu', el)?.addEventListener('click', () => edit());
    if (can('user.manage')) $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => edit(out.users[+tr.dataset.i])));
  };

  // ---------- AI keys (shared by client and platform) ----------
  async function keysPage(el, base, platform) {
    const out = await get(base);
    const prov = out.providers;
    const plabel = (id) => prov.find((p) => p.id === id)?.label || id;
    let settingsHtml = '';
    if (!platform) {
      const s = out.settings; const st = out.status;
      settingsHtml = `<div class="card"><h2>How AI is used</h2>
        <p>Now active: ${st.ready ? `<b>${esc(plabel(st.provider))}</b> (${esc(st.model)}), ${st.source === 'own' ? 'your own key' : st.source === 'mock' ? 'demo AI' : 'platform key included in your plan'}${st.verifyProvider ? `. Second check: <b>${esc(plabel(st.verifyProvider))}</b> (${esc(st.verifyModel)})` : ''}` : `<span class="err">${esc(st.message)}</span>`}</p>
        <form id="aiSet"><div class="fgrid">
          ${fld('Main AI key', `<select name="main_key_id">${opt('', 'Default key', s.main_key_id)}${out.keys.map((k) => opt(k.id, `${k.label} (${k.model})`, s.main_key_id)).join('')}</select>`)}
          ${fld('Second check with', `<select name="verify_key_id">${opt('', 'Same as main', s.verify_key_id)}${out.keys.map((k) => opt(k.id, `${k.label} (${k.model})`, s.verify_key_id)).join('')}</select>`, 'Using a different provider for the double-check catches more AI mistakes.')}
          ${fld('Minimum confidence for OK', `<select name="min_confidence">${[0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((v) => opt(v, Math.round(v * 100) + '%', s.min_confidence)).join('')}</select>`, 'Higher = stricter, more "unclear" results')}
          ${fld('Language of AI notes', inp('language', s.language, 'placeholder="English" list="langs"') + '<datalist id="langs"><option>English</option><option>Hindi</option><option>Marathi</option><option>Kannada</option><option>Tamil</option><option>Telugu</option><option>Gujarati</option><option>Bengali</option><option>Arabic</option></datalist>')}
        </div>${chk('strict_verify', s.strict_verify, 'Double-check every OK result (recommended, about one extra AI call per inspection)')}
        <button class="btn primary">Save AI settings</button></form>
        ${out.platformAi ? '<p class="muted small">Your plan includes platform AI: if you have no key, the platform\'s key is used.</p>' : ''}</div>`;
    } else {
      settingsHtml = `<div class="card"><h2>Fallback order</h2><p>Clients use their own key first. If they have none and their plan includes platform AI, the default key below is used, then keys from server environment variables${out.envKeys.length ? ` (now set: ${out.envKeys.map((k) => esc(k.label)).join(', ')})` : ' (none set)'}.${out.demoAi ? ' <b>Demo AI is ON</b> (AI_MOCK=1) and answers with fake results when no key exists.' : ''}</p></div>`;
    }
    el.innerHTML = head(platform ? 'Platform AI keys' : 'AI models', platform ? 'Your own keys, used for clients whose plan includes platform AI.' : 'Bring your own API key. Keys are encrypted and never shown again after saving.', '<button class="btn primary" id="nk">Add API key</button>')
      + settingsHtml
      + table(['Provider', 'Label', 'Model', 'Key', 'Status', 'Default', ''], out.keys.map((k, i) => `<tr>
        <td>${esc(k.providerLabel)}</td><td>${esc(k.label)}</td><td>${esc(k.model)}</td><td><code>${esc(k.hint)}</code></td>
        <td>${pill(k.status === 'ok' ? 'ok' : k.status, k.status)}${k.lastError ? `<div class="err small">${esc(k.lastError.slice(0, 160))}</div>` : ''}</td>
        <td>${k.isDefault ? '✓' : `<button class="btn sm" data-def="${i}">Make default</button>`}</td>
        <td class="actions"><button class="btn sm" data-test="${i}">Test</button><button class="btn sm" data-edit="${i}">Edit</button><button class="btn sm danger" data-del="${i}">Delete</button></td></tr>`), 'No keys yet. Add a Gemini, OpenAI or Anthropic key.');
    $('#aiSet', el)?.addEventListener('submit', async (e) => { e.preventDefault(); const d = formData(e.target); d.min_confidence = Number(d.min_confidence); try { await put('/api/settings', { ai: d }); toast('AI settings saved'); route(); } catch (err) { toast(err.message, true); } });
    const edit = (k) => {
      const isNew = !k;
      modal(isNew ? 'Add API key' : `Edit ${k.label}`, `<div class="fgrid">
        ${fld('Provider', `<select name="provider" id="kp" ${isNew ? '' : 'disabled'}>${prov.map((p) => opt(p.id, p.label, k?.provider || 'gemini')).join('')}</select>`, '<span id="kurl"></span>')}
        ${fld('Label', inp('label', k?.label || '', 'placeholder="e.g. Gemini - production"'))}
        ${fld(isNew ? 'API key' : 'New API key (leave empty to keep)', inp('apiKey', '', `type="password" autocomplete="off" ${isNew ? 'required' : ''}`))}
        ${fld('Model', inp('model', k?.model || '', 'list="kmodels" id="km"') + '<datalist id="kmodels"></datalist>', 'Must support images. Azure: the deployment name.')}
        <div id="az">${fld('Endpoint', inp('endpoint', k?.endpoint || '', 'placeholder="https://your-resource.openai.azure.com"'))}${fld('API version', inp('apiVersion', k?.apiVersion || '2024-10-21'))}</div>
        </div>${isNew ? chk('isDefault', !out.keys.length, 'Make this the default key') : ''}${!isNew ? chk('disabled', k.status === 'disabled', 'Switch this key off') : ''}`, {
        submit: isNew ? 'Save and test' : 'Save',
        onSubmit: async (f) => {
          const d = formData(f); if (!isNew) d.provider = k.provider;
          if (isNew) { const r = await post(base, d); toast(r.test?.ok ? 'Key works ✓' : `Saved, but the test failed: ${r.test?.error || ''}`, !r.test?.ok); }
          else await put(`${base}/${k.id}`, d);
          route();
        },
        onOpen: (b) => {
          const sync = () => {
            const p = prov.find((x) => x.id === $('#kp', b).value);
            $('#kmodels', b).innerHTML = p.models.map((m) => `<option value="${esc(m)}">`).join('');
            if (isNew) $('#km', b).value = p.defaultModel;
            $('#az', b).hidden = !p.needsEndpoint;
            $('#kurl', b).innerHTML = `Get a key: <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${esc(p.keyUrl)}</a>`;
          };
          $('#kp', b).onchange = sync; sync(); if (!isNew) $('#km', b).value = k.model;
        },
      });
    };
    $('#nk', el).onclick = () => edit();
    $$('[data-edit]', el).forEach((b) => b.onclick = () => edit(out.keys[+b.dataset.edit]));
    $$('[data-test]', el).forEach((b) => b.onclick = async () => { b.disabled = true; b.textContent = 'Testing…'; try { const r = await post(`${base}/${out.keys[+b.dataset.test].id}/test`); toast(r.ok ? `Works ✓ (${r.ms} ms)` : 'Failed: ' + r.error, !r.ok); } catch (e) { toast(e.message, true); } route(); });
    $$('[data-def]', el).forEach((b) => b.onclick = async () => { const k = out.keys[+b.dataset.def]; await put(`${base}/${k.id}`, { ...k, isDefault: true }); route(); });
    $$('[data-del]', el).forEach((b) => b.onclick = async () => { const k = out.keys[+b.dataset.del]; if (!confirm(`Delete the key "${k.label}"?`)) return; await del(`${base}/${k.id}`); route(); });
  }
  PAGES.ai = (el) => keysPage(el, '/api/ai-keys', false);

  // ---------- company settings ----------
  PAGES.settings = async (el) => {
    const { tenant: t, settings: s } = await get('/api/settings');
    el.innerHTML = head('Company settings', 'Branding, workflow and integrations for your account.')
      + `<form id="sf" class="grid g2">
        <div class="card"><h2>Company</h2>
          ${fld('Company name', inp('t.name', t.name, 'required'))}${fld('Contact person', inp('t.contactName', t.contactName))}
          ${fld('Contact email', inp('t.contactEmail', t.contactEmail, 'type="email"'))}${fld('Phone', inp('t.contactPhone', t.contactPhone))}
          ${fld('GSTIN / tax ID', inp('t.gstin', t.gstin))}${fld('Address', `<textarea name="t.address" rows="2">${esc(t.address)}</textarea>`)}
          <p class="muted small">Client code: <code>${esc(t.slug)}</code></p></div>
        <div class="card"><h2>Branding</h2>
          ${fld('App name shown to your team', inp('b.app_name', s.branding.app_name, 'placeholder="Inspection AI" maxlength="40"'))}
          ${fld('Brand colour (buttons, highlights)', `<input type="color" name="b.color" value="${esc(s.branding.color)}" />`)}
          ${fld('Logo (PNG, JPG or SVG, under 200 KB)', `<input type="file" id="logoF" accept="image/png,image/jpeg,image/svg+xml,image/webp" /><div class="ref" style="margin-top:.4rem">${s.branding.logo ? `<img src="${s.branding.logo}" alt="Logo" id="logoP" /><button type="button" class="link" id="logoX">Remove</button>` : '<span class="muted" id="logoP">No logo</span>'}</div>`)}
          ${fld('Report footer', `<textarea name="b.report_footer" rows="2" placeholder="e.g. Acme Steel Ltd, Safety department, ISO 45001">${esc(s.branding.report_footer)}</textarea>`)}</div>
        <div class="card"><h2>Workflow</h2>
          ${chk('w.require_review', s.workflow.require_review, '<b>Manager review</b>: every saved inspection waits for a manager to approve or reject it')}
          ${chk('w.auto_actions', s.workflow.auto_actions, '<b>Automatic corrective actions</b> for failed and unconfirmed critical checks')}
          ${chk('w.auto_create_assets', s.workflow.auto_create_assets, '<b>Add new asset IDs</b> to the asset register automatically')}
          ${chk('w.inspectors_see_all', s.workflow.inspectors_see_all, 'Inspectors can see inspections by others (otherwise only their own)')}
          ${fld('Default days to close an action', inp('w.action_due_days', s.workflow.action_due_days, 'type="number" min="1" max="90"'))}</div>
        <div class="card"><h2>Webhook (integrations)</h2>
          <p class="muted small">We POST JSON to this URL on each event, signed with <code>X-Signature: sha256=HMAC(secret, body)</code>. Use it for ERP, CMMS, Teams / Slack bots or Zapier.</p>
          ${fld('Webhook URL', inp('h.url', s.webhook.url, 'type="url" placeholder="https://..."'))}${fld('Signing secret', inp('h.secret', s.webhook.secret, 'autocomplete="off"'))}
          ${['inspection.created', 'inspection.reviewed', 'action.created'].map((ev) => `<label class="check"><input type="checkbox" name="h.events" data-multi="1" value="${ev}" ${s.webhook.events.includes(ev) ? 'checked' : ''}/><span>${ev}</span></label>`).join('')}</div>
        <div class="actions"><button class="btn primary">Save settings</button></div></form>`;
    let logo = s.branding.logo;
    $('#logoF', el).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; logo = f.type === 'image/svg+xml' ? await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) : await imageToDataUrl(f, 400, 0.9); if (logo.length > 290000) { toast('Logo is too large. Use a smaller image.', true); logo = s.branding.logo; return; } $('#logoP', el).outerHTML = `<img src="${logo}" id="logoP" alt="Logo" />`; };
    $('#logoX', el)?.addEventListener('click', () => { logo = ''; $('#logoP', el).outerHTML = '<span class="muted" id="logoP">No logo</span>'; });
    $('#sf', el).onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(e.target); const pick = (p) => Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v]));
      try { await put('/api/settings', { tenant: pick('t.'), branding: { ...pick('b.'), logo }, workflow: pick('w.'), webhook: { ...pick('h.'), events: d['h.events'] || [] } }); toast('Settings saved'); S.me = await get('/api/me'); renderNav(); }
      catch (err) { toast(err.message, true); }
    };
  };

  PAGES.usage = async (el) => {
    const u = await get('/api/usage');
    const lim = u.limits || {}; const t = u.thisMonth;
    const meter = (label, used, max) => `<div><div class="actions" style="justify-content:space-between"><b>${label}</b><span>${num(used)} / ${num(max)}</span></div><div class="bar ${max && used / max > 0.85 ? 'hot' : ''}"><i style="width:${max ? Math.min(100, (used / max) * 100) : 4}%"></i></div></div>`;
    el.innerHTML = head('Plan and usage', `Plan: <b>${esc(u.plan?.name || 'Custom')}</b>. Contact your provider to change plan or limits.`)
      + `<div class="card grid g2">${meter('AI checks this month', t.aiCalls, lim.max_ai_calls_month)}${meter('Inspections this month', t.inspections, lim.max_inspections_month)}${meter('Active users', t.users, lim.max_users)}${meter('Sites', t.sites, lim.max_sites)}</div>
      <div class="grid g2"><div class="card"><h2>AI by model this month</h2>${table(['Provider', 'Model', 'Key', 'Calls', 'Tokens in', 'Tokens out'], u.byProvider.map((p) => `<tr><td>${esc(p.provider)}</td><td>${esc(p.model)}</td><td>${esc(p.source)}</td><td>${num(p.calls)}</td><td>${num(p.tokensIn)}</td><td>${num(p.tokensOut)}</td></tr>`))}</div>
      <div class="card"><h2>By month</h2>${table(['Month', 'AI calls', 'Failed', 'Tokens in', 'Tokens out'], u.byMonth.map((m) => `<tr><td>${m.month}</td><td>${num(m.calls)}</td><td>${num(m.failed)}</td><td>${num(m.tokensIn)}</td><td>${num(m.tokensOut)}</td></tr>`))}</div></div>
      <p class="muted small">A photo inspection uses 2 AI calls (check + double-check). Live scan uses one call per analysed frame.</p>`;
  };

  function auditTable(entries, withTenant) {
    return table(['When', ...(withTenant ? ['Client'] : []), 'Who', 'Action', 'Details', 'IP'], entries.map((e) => `<tr><td>${fmtDT(e.created_at)}</td>${withTenant ? `<td>${esc(e.tenant_name || 'Platform')}</td>` : ''}<td>${esc(e.user_name)}</td><td><code>${esc(e.action)}</code></td><td class="small">${esc(e.details ? JSON.stringify(e.details).slice(0, 160) : '')}</td><td class="small">${esc(e.ip)}</td></tr>`));
  }
  PAGES.audit = async (el) => { const out = await get('/api/audit'); el.innerHTML = head('Audit log', 'Who did what and when (last 200 events).') + auditTable(out.entries, false); };

  // ---------- templates ----------
  PAGES.templates = async (el) => {
    bust('tpl');
    const tp = await templatesAll();
    el.innerHTML = head('Inspection types', 'What your team inspects: views (photo angles), checks, custom fields, AI instructions and reference photos.', `
        <a class="btn" href="#library">Add from library</a><button class="btn" id="ij">Import JSON</button><a class="btn primary" href="#template/new">Create new</a>`)
      + table(['Name', 'Industry', 'Views', 'Checks', 'Every', 'Status', ''], tp.map((t) => `<tr class="click" data-href="#template/${t.id}">
        <td><b>${esc(t.name)}</b>${t.safety ? ' ' + pill('high', 'safety') : ''}<div class="muted small">${esc(t.description)}</div></td><td>${esc(t.industry || t.category)}</td><td>${t.angles.length}</td>
        <td>${t.angles.reduce((n, a) => n + a.parts.length, 0) + t.general_parts.length}</td><td>${t.frequencyDays ? t.frequencyDays + ' d' : ''}</td><td>${t.active ? pill('active') : pill('cancelled', 'archived')}</td><td>v${t.version}</td></tr>`), 'No inspection types yet. Add some from the library.');
    wireClicks(el);
    $('#ij', el).onclick = () => modal('Import an inspection type', fld('Template file (.json, exported from Inspection AI)', '<input type="file" accept=".json,application/json" required />'), {
      submit: 'Import', onSubmit: async (f) => { const file = $('input[type=file]', f).files[0]; if (!file) throw new Error('Choose a file.'); let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('Not a valid JSON file.'); } const r = await post('/api/templates/import-json', data); toast('Imported'); location.hash = '#template/' + r.id; },
    });
  };

  PAGES.template = async (el, id) => {
    const isNew = id === 'new';
    const t = isNew ? { name: '', description: '', industry: S.me.tenant.industries?.[0] || '', category: '', idLabel: '', safety: false, aiContext: '', angles: [{ name: 'Front', guidance: '', parts: [] }], general_parts: [], customFields: [], frequencyDays: null, active: true }
      : (await get('/api/templates/' + encodeURIComponent(id))).template;
    const lib = await cached('lib', '/api/library');
    el.innerHTML = head(isNew ? 'New inspection type' : t.name, isNew ? '' : `Version ${t.version}${t.libraryKey ? ', from the library' : ''}`, `
        <a class="btn" href="#templates">Back</a>
        ${!isNew ? '<button class="btn" id="dup">Duplicate</button><button class="btn" id="exp">Export JSON</button><button class="btn" id="sug">Suggest for library</button><button class="btn danger" id="delT">Delete</button>' : ''}`)
      + `<form id="tf" class="grid">
      <div class="card"><h2>Basics</h2><div class="fgrid">
        ${fld('Name', inp('name', t.name, 'required maxlength="80" placeholder="e.g. Forklift pre-use"'))}
        ${fld('Industry', inp('industry', t.industry, 'list="inds" placeholder="e.g. warehouse"') + `<datalist id="inds">${lib.industries.map((i) => `<option value="${esc(i.key)}">${esc(i.name)}</option>`).join('')}</datalist>`, 'Pick one or type your own')}
        ${fld('Category / department', inp('category', t.category, 'placeholder="e.g. Safety, Quality, Housekeeping"'))}
        ${fld('Name of the ID field', inp('idLabel', t.idLabel, 'placeholder="Asset ID / serial no."'))}
        ${fld('Inspect every (days)', inp('frequencyDays', t.frequencyDays ?? '', 'type="number" min="1" placeholder="Not recurring"'), 'Sets the asset\'s next due date after each inspection')}
        </div>
        ${fld('Description (also sent to the AI)', `<textarea name="description" rows="2">${esc(t.description)}</textarea>`)}
        ${chk('safety', t.safety, '<b>Safety wording</b>: results read "Safe to use / Use with caution / Do not use"')}
        ${chk('active', t.active, 'Active (shown to inspectors)')}</div>
      <div class="card"><div class="head"><h2>Views and checks</h2><button type="button" class="btn" id="aiSug">✨ Suggest with AI</button></div>
        <p class="muted small">One view = one photo angle. One check per line. <code>!</code> at the start = critical. After <code>::</code> write what must be visibly true, e.g. <code>! Earthing wire :: connected and tightened</code>. A reference photo shows the AI what a correct item looks like.</p>
        <div id="views" class="grid"></div><button type="button" class="btn" id="addV">Add a view</button>
        ${fld('Checks that can be seen in any view', `<textarea name="general_parts" rows="2">${esc(t.general_parts.join('\n'))}</textarea>`)}</div>
      <div class="card"><div class="head"><h2>Custom fields</h2><button type="button" class="btn" id="addF">Add field</button></div>
        <p class="muted small">Extra details the inspector fills in (e.g. Height, Odometer, Batch no.). They appear on the report and are given to the AI.</p><div id="cfs"></div></div>
      <div class="card"><h2>AI instructions</h2>
        <p class="muted small">Domain knowledge and rules for the AI for this inspection type: terms, what counts as a failure, standards to follow.</p>
        <textarea name="aiContext" rows="6" placeholder="e.g. Fire extinguisher gauge: green zone = OK. A missing tamper seal is always a failure. Follow IS 2190.">${esc(t.aiContext)}</textarea></div>
      <div class="actions"><button class="btn primary">Save inspection type</button></div></form>`;
    const views = t.angles.map((a) => ({ ...a }));
    const drawViews = () => {
      $('#views', el).innerHTML = views.map((a, i) => `<div class="view-ed" data-v="${i}">
        <div class="row"><b>${i + 1}.</b><input class="vn" value="${esc(a.name)}" placeholder="View name, e.g. Front" aria-label="View name" />
          <button type="button" class="btn sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button type="button" class="btn sm danger" data-rm="${i}">Remove</button></div>
        <input class="vg" value="${esc(a.guidance)}" placeholder="How to frame the photo" aria-label="Guidance" />
        <textarea class="vp" rows="${Math.max(3, a.parts.length + 1)}" placeholder="One check per line" aria-label="Checks">${esc(a.parts.join('\n'))}</textarea>
        <div class="ref">${a.reference ? `<img src="${a.reference}" alt="Reference" /><button type="button" class="link" data-rx="${i}">Remove reference photo</button>` : (a.hasReference && a.reference === undefined ? 'Reference photo saved' : '')}
          <label class="btn sm">Reference photo<input type="file" accept="image/*" data-rf="${i}" hidden /></label></div></div>`).join('');
      $$('[data-rm]', el).forEach((b) => b.onclick = () => { readViews(); views.splice(+b.dataset.rm, 1); drawViews(); });
      $$('[data-up]', el).forEach((b) => b.onclick = () => { readViews(); const i = +b.dataset.up; [views[i - 1], views[i]] = [views[i], views[i - 1]]; drawViews(); });
      $$('[data-rx]', el).forEach((b) => b.onclick = () => { readViews(); views[+b.dataset.rx].reference = ''; views[+b.dataset.rx].hasReference = false; drawViews(); });
      $$('[data-rf]', el).forEach((inpEl) => inpEl.onchange = async () => { readViews(); views[+inpEl.dataset.rf].reference = await imageToDataUrl(inpEl.files[0], 640, 0.75); drawViews(); });
    };
    const readViews = () => $$('[data-v]', el).forEach((d) => { const v = views[+d.dataset.v]; v.name = $('.vn', d).value.trim(); v.guidance = $('.vg', d).value.trim(); v.parts = $('.vp', d).value.split('\n').map((x) => x.trim()).filter(Boolean); });
    const fields = t.customFields.map((f) => ({ ...f }));
    const drawFields = () => {
      $('#cfs', el).innerHTML = fields.map((f, i) => `<div class="cf-row" data-f="${i}">
        <input class="fl" value="${esc(f.label)}" placeholder="Label, e.g. Height (m)" aria-label="Field label" />
        <select class="ft" aria-label="Type">${['text', 'number', 'date', 'select', 'checkbox'].map((x) => opt(x, x, f.type)).join('')}</select>
        <input class="fo" value="${esc((f.options || []).join(', '))}" placeholder="Choices, comma separated" ${f.type === 'select' ? '' : 'hidden'} aria-label="Options" />
        <label class="check" style="margin:0"><input type="checkbox" class="fr" ${f.required ? 'checked' : ''} /><span>Required</span></label>
        <button type="button" class="btn sm danger" data-rf2="${i}">Remove</button></div>`).join('') || '<p class="muted">No custom fields.</p>';
      $$('.ft', el).forEach((s) => s.onchange = () => { s.parentElement.querySelector('.fo').hidden = s.value !== 'select'; });
      $$('[data-rf2]', el).forEach((b) => b.onclick = () => { readFields(); fields.splice(+b.dataset.rf2, 1); drawFields(); });
    };
    const readFields = () => $$('[data-f]', el).forEach((d) => { const f = fields[+d.dataset.f]; f.label = $('.fl', d).value.trim(); f.type = $('.ft', d).value; f.options = $('.fo', d).value.split(',').map((x) => x.trim()).filter(Boolean); f.required = $('.fr', d).checked; if (!f.key) f.key = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30); });
    drawViews(); drawFields();
    $('#addV', el).onclick = () => { readViews(); views.push({ name: '', guidance: '', parts: [] }); drawViews(); };
    $('#addF', el).onclick = () => { readFields(); fields.push({ label: '', type: 'text', required: false }); drawFields(); };
    $('#aiSug', el).onclick = async (e) => {
      const name = $('[name=name]', el).value.trim(); if (!name) { toast('Type the name first.', true); return; }
      readViews(); if (views.some((v) => v.parts.length) && !confirm('Replace the current views and checks with AI suggestions?')) return;
      e.target.disabled = true; e.target.textContent = 'Thinking…';
      try { const out = await post('/api/ai/suggest', { item: name, description: $('[name=description]', el).value, industry: $('[name=industry]', el).value }); views.splice(0, views.length, ...out.angles); $('[name=general_parts]', el).value = out.general_parts.join('\n'); drawViews(); toast('Suggested. Review before saving.'); }
      catch (err) { toast(err.message, true); } finally { e.target.disabled = false; e.target.textContent = '✨ Suggest with AI'; }
    };
    $('#tf', el).onsubmit = async (e) => {
      e.preventDefault(); readViews(); readFields();
      const d = formData(e.target);
      const body = { ...d, general_parts: d.general_parts.split('\n').map((x) => x.trim()).filter(Boolean), frequencyDays: d.frequencyDays || null,
        angles: views.map((v) => ({ name: v.name, guidance: v.guidance, parts: v.parts, ...(v.reference !== undefined ? { reference: v.reference } : {}) })), customFields: fields.filter((f) => f.label) };
      try { const out = isNew ? await post('/api/templates', body) : await put('/api/templates/' + t.id, body); bust('tpl'); toast('Saved'); if (isNew) location.hash = '#template/' + out.template.id; else route(); }
      catch (err) { toast(err.message, true); }
    };
    if (!isNew) {
      $('#dup', el).onclick = async () => { const r = await post(`/api/templates/${t.id}/duplicate`); bust('tpl'); location.hash = '#template/' + r.id; };
      $('#exp', el).onclick = async () => downloadJson(await get(`/api/templates/${t.id}/export`), `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);
      $('#sug', el).onclick = () => modal('Suggest for the shared library', fld('Note for the platform team (optional)', '<textarea name="note" rows="2"></textarea>'), { submit: 'Send', onSubmit: async (f) => { await post(`/api/templates/${t.id}/suggest-library`, formData(f)); toast('Sent. Thank you!'); } });
      $('#delT', el).onclick = async () => { if (!confirm(`Delete "${t.name}"? If it has inspections it will be archived instead.`)) return; const r = await del('/api/templates/' + t.id); bust('tpl'); toast(r.message || 'Deleted'); location.hash = '#templates'; };
    }
  };

  PAGES.library = async (el) => {
    bust('lib');
    const lib = await cached('lib', '/api/library');
    el.innerHTML = head('Template library', 'Ready-made inspection types by industry. Tick the ones you want and add them to your account; you can edit your copies freely.', '<button class="btn primary" id="imp">Add selected</button>')
      + `<div class="grid g2">${lib.industries.map((i) => `<div class="lib-ind"><h3>${esc(i.name)} <button type="button" class="link small" data-all="${esc(i.key)}">Select all</button></h3>
        ${i.description ? `<p class="muted small">${esc(i.description)}</p>` : ''}
        ${i.templates.map((t) => `<label class="lib-t"><input type="checkbox" value="${esc(t.id)}" data-ind="${esc(i.key)}" ${t.imported ? 'disabled' : ''} />
          <span><b>${esc(t.name)}</b> ${t.imported ? pill('ok', 'added') : ''}<br><span class="muted small">${esc(t.description)} (${t.views} views, ${t.checks} checks)</span></span></label>`).join('') || '<p class="muted">No templates yet.</p>'}</div>`).join('')}</div>
      <p class="muted">Missing an industry or template? Create your own in Inspection types, or use "Suggest for library" on a template you built.</p>`;
    $$('[data-all]', el).forEach((b) => b.onclick = () => $$(`input[data-ind="${b.dataset.all}"]:not(:disabled)`, el).forEach((c) => { c.checked = true; }));
    $('#imp', el).onclick = async () => {
      const ids = $$('input[data-ind]:checked', el).map((c) => c.value);
      if (!ids.length) { toast('Tick at least one template.', true); return; }
      try { const r = await post('/api/library/import', { ids }); bust('tpl'); toast(`${r.imported} added to your inspection types`); route(); } catch (e) { toast(e.message, true); }
    };
  };

  // ======================= PLATFORM PAGES =======================
  PAGES['p-overview'] = async (el) => {
    const o = await get('/api/platform/overview');
    el.innerHTML = head('Platform overview', 'All clients, this month.', isSuper() ? '<button class="btn" id="demo">Create demo client</button><a class="btn primary" href="#p-clients" id="nc">New client</a>' : '')
      + `<div class="kpis">
        <a class="kpi" href="#p-clients"><b>${o.tenants.total}</b><span>Clients (${o.tenants.byStatus.active} active, ${o.tenants.byStatus.trial} trial, ${o.tenants.byStatus.suspended} suspended)</span></a>
        <div class="kpi"><b>₹${num(o.mrr)}</b><span>Monthly revenue (active clients, list price)</span></div>
        <div class="kpi"><b>${num(o.users)}</b><span>Active client users</span></div>
        <div class="kpi"><b>${num(o.inspectionsThisMonth)}</b><span>Inspections this month</span></div>
        <div class="kpi ${o.aiFailuresThisMonth ? 'warn' : ''}"><b>${num(o.aiCallsThisMonth)}</b><span>AI calls, ${o.aiFailuresThisMonth} failed</span></div>
        <div class="kpi"><b>${o.tenants.newThisMonth}</b><span>New clients this month</span></div></div>
      <div class="grid g2"><div class="card"><h2>Last 6 months</h2>${table(['Month', 'Inspections', 'AI calls'], o.monthly.map((m) => `<tr><td>${m.month}</td><td>${num(m.inspections)}</td><td>${num(m.aiCalls)}</td></tr>`))}</div>
      <div class="card"><h2>AI calls by provider (this month)</h2>${table(['Provider (key)', 'Calls'], Object.entries(o.aiByProvider).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${num(v)}</td></tr>`), 'No AI calls yet.')}
        <p class="muted small">Server env keys: ${o.envKeys.length ? o.envKeys.map((k) => esc(k.provider + ' ' + k.model)).join(', ') : 'none'}${o.demoAi ? '. <b>Demo AI is ON.</b>' : ''}</p></div></div>`;
    $('#demo', el)?.addEventListener('click', async () => { const r = await post('/api/platform/demo'); credentials('Demo client created', [['Admin email', r.adminEmail], ['Admin password', r.adminPassword], ['Inspector email', r.inspectorEmail], ['Inspector password', r.inspectorPassword]]); });
    $('#nc', el)?.addEventListener('click', (e) => { e.preventDefault(); newClient(); });
  };

  async function newClient() {
    const [plans, lib] = await Promise.all([get('/api/platform/plans'), get('/api/platform/library')]);
    modal('New client', `<div class="fgrid">
      ${fld('Company name', inp('name', '', 'required'))}${fld('Client code (optional)', inp('slug', '', 'placeholder="auto from name"'))}
      ${fld('Admin name', inp('adminName', ''))}${fld('Admin email (sign-in)', inp('adminEmail', '', 'type="email" required'))}
      ${fld('Admin password', inp('adminPassword', '', 'placeholder="Leave empty to generate"'))}
      ${fld('Plan', `<select name="planId">${plans.plans.filter((p) => p.active).map((p) => opt(p.id, `${p.name}${p.price_month ? ' (₹' + num(p.price_month) + '/mo)' : ''}`, 'trial')).join('')}</select>`)}
      ${fld('Status', `<select name="status">${opt('trial', 'Trial', 'trial')}${opt('active', 'Active')}</select>`)}
      ${fld('Trial length (days)', inp('trialDays', 14, 'type="number" min="1"'))}
      ${fld('First site name', inp('siteName', '', 'placeholder="e.g. Pune plant"'))}
      ${fld('Contact phone', inp('contactPhone', ''))}${fld('GSTIN', inp('gstin', ''))}</div>
      ${fld('Industries (their templates are added automatically)', `<div class="fgrid">${lib.industries.filter((i) => i.active).map((i) => `<label class="check"><input type="checkbox" name="industries" data-multi="1" value="${esc(i.key)}" /><span>${esc(i.name)} <span class="muted small">(${i.templates.filter((t) => t.active).length})</span></span></label>`).join('')}</div>`)}
      ${fld('Notes (internal)', '<textarea name="notes" rows="2"></textarea>')}`, {
      submit: 'Create client', wide: true,
      onSubmit: async (f) => {
        const r = await post('/api/platform/tenants', formData(f));
        location.hash = '#p-client/' + r.tenantId; await sleep(150);
        credentials('Client created', [['Admin email', r.adminEmail], ['Admin password', r.adminPassword || '(the one you set)'], ['Console', location.origin + '/console'], ['Field app', location.origin + '/']]);
        return false;
      },
    });
  }

  PAGES['p-clients'] = async (el) => {
    const out = await get('/api/platform/tenants');
    el.innerHTML = head('Clients', 'Companies using the platform.', isSuper() ? '<button class="btn primary" id="nc">New client</button>' : '')
      + `<div class="card no-print"><div class="filters"><label class="field"><span>Search</span><input id="cs" placeholder="Name, email, code" /></label>
          <label class="field"><span>Status</span><select id="cst">${opt('', 'Any')}${['trial', 'active', 'suspended', 'cancelled'].map((s) => opt(s, s)).join('')}</select></label></div></div><div id="cl"></div>`;
    const draw = () => {
      const q = $('#cs', el).value.toLowerCase(); const st = $('#cst', el).value;
      const list = out.tenants.filter((t) => (!st || t.status === st) && (!q || [t.name, t.slug, t.contactEmail, t.contactName].join(' ').toLowerCase().includes(q)));
      $('#cl', el).innerHTML = table(['Client', 'Status', 'Plan', 'Industries', 'Users', 'Inspections (month)', 'AI calls (month)', 'Own keys', 'Last activity'], list.map((t) => `<tr class="click" data-href="#p-client/${t.id}">
        <td><b>${esc(t.name)}</b><div class="muted small">${esc(t.slug)}, ${esc(t.contactEmail)}</div></td><td>${pill(t.status)}${t.status === 'trial' ? `<div class="small muted">until ${fmtDate(t.trialEndsAt)}</div>` : ''}</td>
        <td>${esc(t.planName)}</td><td class="small">${esc(t.industries.map((k) => out.industries.find((i) => i.key === k)?.name || k).join(', '))}</td>
        <td>${t.users}</td><td>${t.inspectionsMonth}</td><td>${t.aiCallsMonth}</td><td>${t.ownKeys}</td><td>${fmtDate(t.lastInspectionAt)}</td></tr>`), 'No clients yet.');
      wireClicks(el);
    };
    $('#cs', el).oninput = draw; $('#cst', el).onchange = draw; draw();
    $('#nc', el)?.addEventListener('click', newClient);
  };

  PAGES['p-client'] = async (el, id) => {
    const [d, plans, lib] = await Promise.all([get('/api/platform/tenants/' + id), get('/api/platform/plans'), get('/api/platform/library')]);
    const t = d.tenant; const L = t.limits || {}; const E = d.effectiveLimits;
    el.innerHTML = head(t.name, `Client code ${esc(t.slug)}, created ${fmtDate(t.createdAt)}`, `<a class="btn" href="#p-clients">Back</a><button class="btn dark" id="sup">Open as support</button>${isSuper() ? '<button class="btn" id="ra">Reset admin password</button><button class="btn danger" id="delC">Delete client</button>' : ''}`)
      + `<div class="kpis"><div class="kpi"><b>${d.users.filter((u) => u.status === 'active').length}</b><span>Active users (max ${num(E.max_users)})</span></div>
        <div class="kpi"><b>${d.counts.inspections}</b><span>Inspections total</span></div><div class="kpi"><b>${d.counts.templates}</b><span>Inspection types</span></div>
        <div class="kpi"><b>${d.counts.assets}</b><span>Assets</span></div><div class="kpi"><b>${d.counts.sites}</b><span>Sites</span></div><div class="kpi"><b>${d.keys.length}</b><span>Own AI keys</span></div></div>
      <form id="cf" class="grid g2">
        <div class="card"><h2>Subscription</h2><div class="fgrid">
          ${fld('Status', `<select name="status">${['trial', 'active', 'suspended', 'cancelled'].map((s) => opt(s, s, t.status)).join('')}</select>`, 'Suspended / cancelled clients cannot sign in')}
          ${fld('Plan', `<select name="planId">${opt('', 'No plan', t.planId)}${plans.plans.map((p) => opt(p.id, p.name, t.planId)).join('')}</select>`)}
          ${fld('Trial ends', inp('trialEndsAt', t.trialEndsAt ? t.trialEndsAt.slice(0, 10) : '', 'type="date"'))}</div>
          <h3>Limit overrides <span class="muted small">(empty = plan value)</span></h3><div class="fgrid">
          ${fld('Max users', inp('l.max_users', L.max_users ?? '', `type="number" min="0" placeholder="${num(d.plan?.max_users)}"`))}
          ${fld('Max sites', inp('l.max_sites', L.max_sites ?? '', `type="number" min="0" placeholder="${num(d.plan?.max_sites)}"`))}
          ${fld('Inspections / month', inp('l.max_inspections_month', L.max_inspections_month ?? '', `type="number" min="0" placeholder="${num(d.plan?.max_inspections_month)}"`))}
          ${fld('AI calls / month', inp('l.max_ai_calls_month', L.max_ai_calls_month ?? '', `type="number" min="0" placeholder="${num(d.plan?.max_ai_calls_month)}"`))}
          ${fld('Platform AI', `<select name="l.platform_ai">${opt('', `Plan default (${d.plan?.platform_ai ? 'yes' : 'no'})`, L.platform_ai === undefined ? '' : String(L.platform_ai))}${opt('true', 'Yes, may use our keys', String(L.platform_ai))}${opt('false', 'No, own key only', String(L.platform_ai))}</select>`)}</div></div>
        <div class="card"><h2>Contact and notes</h2><div class="fgrid">
          ${fld('Company name', inp('name', t.name))}${fld('Contact person', inp('contactName', t.contactName))}${fld('Contact email', inp('contactEmail', t.contactEmail))}
          ${fld('Phone', inp('contactPhone', t.contactPhone))}${fld('GSTIN', inp('gstin', t.gstin))}</div>
          ${fld('Address', `<textarea name="address" rows="2">${esc(t.address)}</textarea>`)}${fld('Internal notes', `<textarea name="notes" rows="3">${esc(t.notes)}</textarea>`)}
          ${fld('Industries', `<div class="fgrid">${lib.industries.map((i) => `<label class="check"><input type="checkbox" name="industries" data-multi="1" value="${esc(i.key)}" ${t.industries.includes(i.key) ? 'checked' : ''}/><span>${esc(i.name)}</span></label>`).join('')}</div>`, 'Changing industries here does not add templates; the client adds them from their library.')}</div>
        ${isSuper() ? '<div class="actions"><button class="btn primary">Save client</button></div>' : ''}</form>
      <div class="grid g2"><div class="card"><h2>Users</h2>${table(['Name', 'Email', 'Role', 'Status', 'Last sign-in'], d.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${pill(u.status)}</td><td>${fmtDate(u.last_login_at)}</td></tr>`))}</div>
      <div class="card"><h2>Usage by month</h2>${table(['Month', 'Inspections', 'AI calls'], d.monthly.map((m) => `<tr><td>${m.month}</td><td>${m.inspections}</td><td>${m.aiCalls}</td></tr>`))}
        <h3>Own AI keys</h3>${d.keys.map((k) => `<p>${esc(k.providerLabel)} ${esc(k.model)} ${pill(k.status)}</p>`).join('') || '<p class="muted">None</p>'}</div></div>`;
    $('#cf', el).onsubmit = async (e) => {
      e.preventDefault(); const f = formData(e.target);
      const limits = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('l.')).map(([k, v]) => [k.slice(2), v]));
      if (limits.platform_ai === '') delete limits.platform_ai;
      try { await put('/api/platform/tenants/' + t.id, { ...Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('l.'))), limits }); toast('Saved'); route(); } catch (err) { toast(err.message, true); }
    };
    $('#sup', el).onclick = () => enterSupport(t.id, t.name);
    $('#ra', el)?.addEventListener('click', async () => { if (!confirm('Reset the main admin password? They will be signed out.')) return; const r = await post(`/api/platform/tenants/${t.id}/reset-admin`); credentials('New admin password', [['Email', r.email], ['Password', r.tempPassword]]); });
    $('#delC', el)?.addEventListener('click', () => modal(`Delete ${t.name}`, `<p class="err">This permanently deletes the client and ALL its users, inspections, photos and settings.</p>${fld(`Type the client code "${t.slug}" to confirm`, inp('confirm', '', 'required'))}`, {
      submit: 'Delete permanently', danger: true, onSubmit: async (f) => { await del('/api/platform/tenants/' + t.id, formData(f)); toast('Client deleted'); location.hash = '#p-clients'; },
    }));
  };

  PAGES['p-plans'] = async (el) => {
    const out = await get('/api/platform/plans');
    el.innerHTML = head('Plans', 'Price and limits per plan. Empty limit = unlimited. Per-client overrides are on the client page.', isSuper() ? '<button class="btn primary" id="np">New plan</button>' : '')
      + table(['Plan', 'Price / month', 'Users', 'Sites', 'Inspections / mo', 'AI calls / mo', 'Platform AI', 'Clients', 'Active'], out.plans.map((p, i) => `<tr class="click" data-i="${i}">
        <td><b>${esc(p.name)}</b> <span class="muted small">${esc(p.id)}</span><div class="muted small">${esc(p.description)}</div></td><td>${p.price_month ? '₹' + num(p.price_month) : 'Free / custom'}</td>
        <td>${num(p.max_users)}</td><td>${num(p.max_sites)}</td><td>${num(p.max_inspections_month)}</td><td>${num(p.max_ai_calls_month)}</td><td>${p.platform_ai ? 'Yes' : 'Own key'}</td><td>${p.tenants}</td><td>${p.active ? 'Yes' : 'No'}</td></tr>`));
    const edit = (p = {}) => modal(p.id ? `Plan ${p.name}` : 'New plan', `<div class="fgrid">
      ${p.id ? '' : fld('Code', inp('id', '', 'placeholder="e.g. growth"'))}${fld('Name', inp('name', p.name || '', 'required'))}
      ${fld('Price per month (₹)', inp('price_month', p.price_month ?? 0, 'type="number" min="0"'))}${fld('Max users', inp('max_users', p.max_users ?? '', 'type="number" min="0" placeholder="unlimited"'))}
      ${fld('Max sites', inp('max_sites', p.max_sites ?? '', 'type="number" min="0" placeholder="unlimited"'))}${fld('Inspections / month', inp('max_inspections_month', p.max_inspections_month ?? '', 'type="number" min="0" placeholder="unlimited"'))}
      ${fld('AI calls / month', inp('max_ai_calls_month', p.max_ai_calls_month ?? '', 'type="number" min="0" placeholder="unlimited"'))}${fld('Sort order', inp('sort', p.sort ?? 0, 'type="number"'))}</div>
      ${fld('Description', inp('description', p.description || ''))}
      ${chk('platform_ai', p.platform_ai, 'Includes platform AI (client may use your keys)')}${chk('active', p.id ? p.active : true, 'Active (can be chosen for new clients)')}`, {
      extra: p.id ? '<button type="button" class="btn danger" id="dp">Delete</button>' : '',
      onSubmit: async (f) => { const d = formData(f); if (p.id) await put('/api/platform/plans/' + p.id, d); else await post('/api/platform/plans', d); toast('Saved'); route(); },
      onOpen: () => $('#dp')?.addEventListener('click', async () => { try { await del('/api/platform/plans/' + p.id); $('#modal').close(); route(); } catch (e) { $('#modalErr').textContent = e.message; } }),
    });
    $('#np', el)?.addEventListener('click', () => edit());
    if (isSuper()) $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => edit(out.plans[+tr.dataset.i])));
  };

  // ---------- platform library: add industries and templates without code ----------
  PAGES['p-library'] = async (el) => {
    const [lib, sug] = await Promise.all([get('/api/platform/library'), get('/api/platform/library-suggestions')]);
    el.innerHTML = head('Industries and template library', 'Add new industries and ready-made templates. Clients see them in their Template library and new clients get them when you tick the industry.', isSuper() ? '<button class="btn" id="ni">New industry</button><button class="btn primary" id="nt">New library template</button>' : '')
      + (sug.suggestions.length ? `<div class="card"><h2>Templates suggested by clients</h2>${table(['When', 'Client', 'Template', 'By', 'Note', ''], sug.suggestions.map((s, i) => `<tr><td>${fmtDate(s.at)}</td><td>${esc(s.tenantName)}</td><td>${esc(s.details?.name)}</td><td>${esc(s.by)}</td><td>${esc(s.details?.note || '')}</td><td>${isSuper() ? `<button class="btn sm" data-prom="${i}">Add to library</button>` : ''}</td></tr>`))}</div>` : '')
      + `<div class="grid g2">${lib.industries.map((i) => `<div class="lib-ind"><h3>${esc(i.name)} ${i.active ? '' : pill('cancelled', 'off')} ${isSuper() ? `<button type="button" class="link small" data-ei="${esc(i.key)}">Edit</button>` : ''}</h3>
        <p class="muted small">Code <code>${esc(i.key)}</code>${i.builtin ? ', built-in' : ''}</p>
        ${i.templates.map((t) => `<div class="lib-t"><span style="flex:1"><b>${esc(t.name)}</b> ${t.active ? '' : pill('cancelled', 'off')}<br><span class="muted small">${t.views} views, ${t.checks} checks</span></span>${isSuper() ? `<button class="btn sm" data-et="${esc(t.id)}">Edit</button>` : ''}</div>`).join('') || '<p class="muted">No templates yet.</p>'}</div>`).join('')}</div>`;
    const indModal = (i = {}) => modal(i.key ? `Industry: ${i.name}` : 'New industry', `${fld('Name', inp('name', i.name || '', 'required placeholder="e.g. Solar energy"'))}${i.key ? '' : fld('Code (optional)', inp('key', '', 'placeholder="auto from name"'))}
      ${fld('Description', inp('description', i.description || ''))}${i.key ? chk('active', i.active, 'Active (visible to clients)') : ''}`, {
      extra: i.key ? '<button type="button" class="btn danger" id="di">Delete</button>' : '',
      onSubmit: async (f) => { const d = formData(f); if (i.key) await put('/api/platform/library/industries/' + i.key, d); else await post('/api/platform/library/industries', d); toast('Saved'); route(); },
      onOpen: () => $('#di')?.addEventListener('click', async () => { try { await del('/api/platform/library/industries/' + i.key); $('#modal').close(); route(); } catch (e) { $('#modalErr').textContent = e.message; } }),
    });
    const tplModal = async (tid, preset = {}) => {
      const t = tid ? (await get('/api/platform/library/templates/' + tid)).template : { industry: preset.industry || lib.industries[0]?.key, name: '', description: '', idLabel: '', safety: false, frequencyDays: '', aiContext: '', angles: [], general_parts: [] };
      const viewsText = t.angles.map((a) => `# ${a.name}${a.guidance ? ' | ' + a.guidance : ''}\n${a.parts.join('\n')}`).join('\n\n');
      modal(tid ? `Library template: ${t.name}` : 'New library template', `<div class="fgrid">
        ${fld('Industry', `<select name="industry">${lib.industries.map((i) => opt(i.key, i.name, t.industry)).join('')}</select>`)}${fld('Name', inp('name', t.name, 'required'))}
        ${fld('ID field name', inp('idLabel', t.idLabel, 'placeholder="Asset ID"'))}${fld('Every (days)', inp('frequencyDays', t.frequencyDays ?? '', 'type="number" min="1"'))}</div>
        ${fld('Description', inp('description', t.description))}
        ${fld('Views and checks', `<textarea name="views" rows="12" style="font-family:monospace">${esc(viewsText)}</textarea>`, 'Start each view with <code># View name | how to frame the photo</code>, then one check per line. <code>!</code> = critical, <code>::</code> = what must be true.')}
        ${fld('Checks for any view (one per line)', `<textarea name="general" rows="2">${esc(t.general_parts.join('\n'))}</textarea>`)}
        ${fld('AI instructions', `<textarea name="aiContext" rows="4">${esc(t.aiContext)}</textarea>`)}
        ${chk('safety', t.safety, 'Safety wording')}${tid ? chk('active', t.active, 'Active') : ''}`, {
        wide: true, extra: tid ? '<button type="button" class="btn danger" id="dt">Delete</button>' : '',
        onSubmit: async (f) => {
          const d = formData(f);
          const angles = []; let cur = null;
          d.views.split('\n').forEach((line) => { const l = line.trim(); if (!l) return; if (l.startsWith('#')) { const [n, g] = l.slice(1).split('|'); cur = { name: n.trim(), guidance: (g || '').trim(), parts: [] }; angles.push(cur); } else { if (!cur) { cur = { name: 'Main view', guidance: '', parts: [] }; angles.push(cur); } cur.parts.push(l); } });
          const body = { ...d, angles, general_parts: d.general.split('\n').map((x) => x.trim()).filter(Boolean), customFields: t.customFields || [], frequencyDays: d.frequencyDays || null };
          if (tid) await put('/api/platform/library/templates/' + tid, body); else await post('/api/platform/library/templates', body);
          toast('Saved'); route();
        },
        onOpen: () => $('#dt')?.addEventListener('click', async () => { if (!confirm('Delete this library template? Copies in client accounts are not affected.')) return; await del('/api/platform/library/templates/' + tid); $('#modal').close(); route(); }),
      });
    };
    $('#ni', el)?.addEventListener('click', () => indModal());
    $('#nt', el)?.addEventListener('click', () => tplModal());
    $$('[data-ei]', el).forEach((b) => b.onclick = () => indModal(lib.industries.find((i) => i.key === b.dataset.ei)));
    $$('[data-et]', el).forEach((b) => b.onclick = () => tplModal(b.dataset.et));
    $$('[data-prom]', el).forEach((b) => b.onclick = () => { const s = sug.suggestions[+b.dataset.prom]; modal('Add to library', fld('Industry', `<select name="industry">${lib.industries.map((i) => opt(i.key, i.name)).join('')}</select>`), { submit: 'Add', onSubmit: async (f) => { await post('/api/platform/library/promote', { templateId: s.templateId, industry: formData(f).industry }); toast('Added to library'); route(); } }); });
  };

  PAGES['p-keys'] = (el) => keysPage(el, '/api/platform/ai-keys', true);

  PAGES['p-staff'] = async (el) => {
    const out = await get('/api/platform/users');
    el.innerHTML = head('Platform team', out.roles.map((r) => `<b>${esc(r.label)}</b>: ${esc(r.description)}`).join('<br>'), isSuper() ? '<button class="btn primary" id="nu">Add team member</button>' : '')
      + table(['Name', 'Email', 'Role', 'Status', 'Last sign-in'], out.users.map((u, i) => `<tr class="click" data-i="${i}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${pill(u.status)}</td><td>${fmtDT(u.last_login_at)}</td></tr>`));
    const edit = (u = {}) => modal(u.id ? u.name : 'Add team member', `${fld('Email', inp('email', u.email || '', `type="email" required ${u.id ? 'readonly' : ''}`))}${fld('Name', inp('name', u.name || ''))}
      ${fld('Role', `<select name="role">${out.roles.map((r) => opt(r.id, r.label, u.role || 'platform_support')).join('')}</select>`)}
      ${u.id ? fld('Status', `<select name="status">${opt('active', 'Active', u.status)}${opt('disabled', 'Disabled', u.status)}</select>`) + chk('resetPassword', false, 'Reset password') : ''}`, {
      onSubmit: async (f) => {
        const d = formData(f);
        const r = u.id ? await put('/api/platform/users/' + u.id, d) : await post('/api/platform/users', d);
        route(); if (r.tempPassword) { await sleep(50); credentials('Temporary password', [['Email', d.email || u.email], ['Password', r.tempPassword]]); return false; }
      },
    });
    $('#nu', el)?.addEventListener('click', () => edit());
    if (isSuper()) $$('tr[data-i]', el).forEach((tr) => tr.addEventListener('click', () => edit(out.users[+tr.dataset.i])));
  };

  PAGES['p-audit'] = async (el) => { const out = await get('/api/platform/audit'); el.innerHTML = head('Audit log', 'All clients and platform actions (last 300).') + auditTable(out.entries, true); };

  boot();
})();
