/* Inspection AI v5 – visual inspections for any equipment or structure (no framework, no build step) */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const splitLines = (s) => String(s || '').split(/\n/).map((x) => x.trim()).filter(Boolean);
  const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  }
  // "! Guardrail :: fitted on all sides" -> { name, rule, critical }
  const splitCheck = (s) => {
    let t = String(s || '').trim();
    const critical = t.startsWith('!');
    if (critical) t = t.slice(1);
    const [n, ...r] = t.split('::');
    return { name: n.trim(), rule: r.join('::').trim(), critical };
  };
  const cap = (s) => String(s || '').replace(/^\s*([a-z])/, (m, c) => m.replace(c, c.toUpperCase()));
  const checkLabel = (s) => { const c = splitCheck(s); return (c.critical ? '⚠ ' : '') + (c.rule ? `${c.name} – ${c.rule}` : c.name); };

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };

  const APP_VERSION = '5.0.0';
  const MAX_SIDE = 1024;
  const JPEG_Q = 0.72;
  const THUMB_SIDE = 480;
  const ANY = 'Any view';

  // ---------- inspection types: loaded from the company account (cached for offline display) ----------
  function initTypes() { return LS.get('pc_types_cache', []); }
  async function loadTemplates() {
    try {
      const out = await api('/api/templates');
      state.types = out.templates;
      LS.set('pc_types_cache', state.types);
    } catch (e) { if (e.status !== 401) toast('Could not load inspection types: ' + e.message, true); }
    if (['setup', 'home', 'settings', 'details'].includes(state.view)) show(state.view, { push: false, keepScroll: true });
  }
  async function loadSites() {
    try { state.sites = (await api('/api/sites')).sites; } catch { state.sites = state.sites || []; }
    const opts = (sel, first) => `<option value="">${first}</option>` + state.sites.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    $('#sfSite').innerHTML = opts('sfSite', 'No site');
    $('#pfSite').innerHTML = opts('pfSite', 'No default');
    $('#sfSiteWrap').hidden = !state.sites.length;
    $('#pfSite').value = LS.get('pc_default_site', '');
    if (!$('#sfSite').value) $('#sfSite').value = LS.get('pc_default_site', '');
  }
  const can = (perm) => Boolean(state.me?.permissions?.includes(perm));

  // ---------- state ----------
  const state = {
    profile: LS.get('pc_profile', {}),
    types: initTypes(),
    selTypeId: LS.get('pc_last_type', ''),
    editor: null,          // { id, returnTo, fromPicker }
    server: {},
    cur: null,
    angleIdx: 0,
    stream: null,
    liveTimer: null,
    view: 'home',
    histFilter: 'all',
    histQuery: '',
    typeQuery: '',
    installEvt: null,
    me: null,
    sites: [],
  };
  if (!state.profile.name && LS.get('pc_inspector', '')) state.profile.name = LS.get('pc_inspector', '');
  const getType = (id) => state.types.find((t) => t.id === id);
  const saveTypes = () => LS.set('pc_types_cache', state.types);
  const countChecks = (t) => t.angles.reduce((n, a) => n + a.parts.length, 0) + (t.general_parts || []).length;
  function typeIcon(t, cls = 'type-icon') {
    if (/scaffold/i.test(t?.libraryKey || t?.name || '')) return `<span class="${cls}"><svg><use href="#i-scaffold"/></svg></span>`;
    const name = t?.name || '?';
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const tone = h % 5 ? ` t${h % 5}` : '';
    return `<span class="${cls}${tone}">${esc(name.trim()[0]?.toUpperCase() || '?')}</span>`;
  }

  // ---------- toast + loading ----------
  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 5000 : 2600);
  }
  function loading(on, text = 'Working…') {
    $('#loading').hidden = !on;
    $('#loadingText').textContent = text;
  }

  // ---------- navigation ----------
  const CAM_VIEWS = ['capture', 'live'];
  const TAB_OF = { home: 'home', setup: 'setup', details: 'setup', editor: 'settings', capture: 'setup', live: 'setup', result: 'history', history: 'history', settings: 'settings' };

  function show(view, opts = {}) {
    state.view = view;
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    document.body.classList.toggle('cam', CAM_VIEWS.includes(view));
    const tab = view === 'editor' && state.editor && state.editor.returnTo !== 'settings' ? 'setup' : TAB_OF[view];
    $$('[data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === tab && !b.classList.contains('brand') && !b.classList.contains('avatar-btn') && !b.classList.contains('cta-start') && !b.classList.contains('link-btn')));
    $('#btnBack').hidden = !['result', 'details', 'editor'].includes(view) || window.matchMedia('(min-width: 900px)').matches;
    if (view !== 'capture') stopCamera();
    if (view === 'home') renderHome();
    if (view === 'setup') renderTypePicker();
    if (view === 'details') renderDetails();
    if (view === 'history') renderHistory();
    if (view === 'settings') renderSettings();
    window.dispatchEvent(new CustomEvent('pc:view', { detail: view }));
    if (opts.push !== false && location.hash !== '#' + view) history.pushState({ view }, '', '#' + view);
    if (!opts.keepScroll) window.scrollTo({ top: 0 });
  }
  // camera / result screens need a record – if there is none, go home
  function safeView(v) {
    if (!['home', 'setup', 'details', 'editor', 'capture', 'live', 'result', 'history', 'settings'].includes(v)) return 'home';
    if (['capture', 'live'].includes(v) && !state.cur) return getType(state.selTypeId) ? 'details' : 'setup';
    if (v === 'details' && !getType(state.selTypeId)) return 'setup';
    if (v === 'editor' && !state.editor) return 'settings';
    if (v === 'result' && !state.cur?.result) return 'history';
    return v;
  }
  window.addEventListener('popstate', (e) => {
    if (document.body.classList.contains('locked')) return;
    const v = safeView(e.state?.view || location.hash.slice(1));
    if (CAM_VIEWS.includes(state.view) && state.cur && !state.cur.result && Object.keys(state.cur.shots || {}).length && !confirm('Leave this inspection? Photos not checked yet will be lost.')) {
      history.pushState({ view: state.view }, '', '#' + state.view);
      return;
    }
    show(v, { push: false });
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    e.preventDefault();
    show(go.dataset.go);
    if (go.dataset.scroll) setTimeout(() => $('#' + go.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }), 60);
  });
  $('#btnBack').addEventListener('click', () => history.back());

  // ---------- API ----------
  async function api(path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = LS.get('pc_token', '');
    if (token) headers.Authorization = `Bearer ${token}`;
    let r;
    try {
      r = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined, signal: opts.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('No internet connection. Check your network and try again.');
    }
    let data;
    try { data = await r.json(); } catch { data = {}; }
    if ((r.status === 401 || (r.status === 403 && data.code === 'account_suspended')) && path !== '/api/auth/login') {
      // session ended or not signed in: lock the app, keep the current work on screen behind the login
      signOutLocal();
      showLogin(r.status === 403 ? data.error : 'Your sign-in has ended. Please sign in again.');
      const err = new Error('Please sign in again.'); err.status = 401; throw err;
    }
    if (r.status === 413) throw new Error('Photos are too large to send. Use fewer extra photos.');
    if (r.status === 504) throw new Error('The AI took too long. Try again.');
    if (!r.ok) { const err = new Error(data.error || `Request failed (${r.status}).`); err.status = r.status; throw err; }
    return data;
  }

  async function loadServerInfo() {
    try { state.me = await api('/api/me'); applyMe(); } catch { /* keep what we have */ }
    if (state.view === 'settings') renderServerInfo();
    return state.me;
  }
  // company branding, profile and permissions from the server
  function applyMe() {
    const me = state.me; if (!me) return;
    const u = me.user;
    const site = (state.sites || []).find((x) => x.id === LS.get('pc_default_site', ''));
    state.profile = { name: u.name || '', role: u.title || me.roleLabel || '', company: me.tenant?.name || '', empId: u.empId || '', phone: u.phone || '', email: u.email, site: site?.name || '' };
    const b = me.tenant?.branding || {};
    const appName = b.app_name || 'Inspection AI';
    $('#brandName').textContent = appName;
    document.title = appName + (me.tenant ? ' - ' + me.tenant.name : '');
    $('#brandLogo').hidden = !b.logo; if (b.logo) $('#brandLogo').src = b.logo;
    $('.brand-mark').style.display = b.logo ? 'none' : '';
    if (/^#[0-9a-f]{6}$/i.test(b.color || '')) {
      const h = b.color.slice(1); const [r, g, bl] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      const dark = (0.299 * r + 0.587 * g + 0.114 * bl) < 150;
      document.documentElement.style.setProperty('--hivis', b.color);
      document.documentElement.style.setProperty('--hivis-ink', dark ? '#FFFFFF' : '#2B2300');
    }
    paintProfileBits();
    // admins, managers, auditors and the platform team get the full Console as the Admin tab
    const admin = can('console.open') || Boolean(me.platformRole);
    $$('[data-admin]').forEach((b) => { b.hidden = !admin; });
    document.body.classList.toggle('has-admin', admin);
  }
  // open the Console inside the app (same window, so the installed app stays full screen)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-admin]')) return;
    if (state.cur && !state.cur.saved && (Object.keys(state.cur.shots || {}).length || state.cur.result)
      && !confirm('Open Admin? The current inspection has not been saved and will be lost.')) return;
    location.href = '/console';
  });

  // ---------- SIGN IN ----------
  // The app stays locked until the server accepts the password. The server then gives a signed
  // login token (valid for 30 days) that every AI request must carry.
  function tokenExpired() {
    const exp = LS.get('pc_token_exp', '');
    return !exp || Date.now() > new Date(exp).getTime();
  }
  function signOutLocal() {
    localStorage.removeItem('pc_token');
    localStorage.removeItem('pc_token_exp');
  }
  function showLogin(message) {
    stopCamera();
    window.dispatchEvent(new CustomEvent('pc:view', { detail: 'login' })); // stops live scan camera too
    document.body.classList.add('locked');
    $('#splash').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginForm').hidden = false; $('#pwForm').hidden = true;
    $('.login-title').textContent = 'Sign in';
    $('#loginUser').value = LS.get('pc_login_user', '');
    $('#loginHint').textContent = message || 'Sign in with the email and password your company admin gave you.';
    $('#loginPass').value = '';
    $('#loginErr').textContent = '';
    setTimeout(() => (!$('#loginUser').value ? $('#loginUser') : $('#loginPass')).focus(), 60);
  }
  // first sign-in: the temporary password must be replaced
  function showPwChange(current) {
    document.body.classList.add('locked');
    $('#loginScreen').hidden = false; $('#splash').hidden = true;
    $('#loginForm').hidden = true; $('#pwForm').hidden = false;
    $('.login-title').textContent = 'Set your password';
    $('#loginHint').textContent = 'Choose a new password (at least 8 characters, letters and numbers).';
    state.pwCurrent = current || '';
    setTimeout(() => $('#pwNew').focus(), 60);
  }
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('#pwNew').value; const b = $('#pwNew2').value;
    if (a !== b) { $('#pwErr').textContent = 'The two passwords are not the same.'; return; }
    let current = state.pwCurrent;
    if (!current) { current = prompt('Enter your current (temporary) password:') || ''; }
    try {
      const out = await api('/api/me/password', { current, next: a });
      LS.set('pc_token', out.token); LS.set('pc_token_exp', out.expiresAt);
      state.pwCurrent = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
      toast('Password saved');
      await afterSignIn();
    } catch (e2) { $('#pwErr').textContent = e2.message; }
  });
  async function afterSignIn() {
    await loadServerInfo();
    if (state.me?.platformRole && !state.me.support) { location.href = '/console'; return; }
    await loadSites(); applyMe();
    unlock();
    loadTemplates().then(handleDeepLink);
  }
  function unlock() {
    $('#loginScreen').hidden = true;
    $('#splash').hidden = true;
    document.body.classList.remove('locked');
    paintProfileBits();
    if (!state.started) {
      state.started = true;
      const startView = safeView(location.hash.slice(1) || 'home');
      history.replaceState({ view: startView }, '', location.pathname + location.search + '#' + startView);
      show(startView, { push: false });
    } else {
      show(state.view, { push: false, keepScroll: true });
      // signed in again in the middle of an inspection: bring the camera back
      if (state.view === 'capture' && state.cur) { renderCapture(); startCamera(); }
      if (state.view === 'live' && state.cur) window.dispatchEvent(new CustomEvent('pc:resume-live'));
    }
  }
  $('#pwToggle').addEventListener('click', () => {
    const inp = $('#loginPass');
    const showIt = inp.type === 'password';
    inp.type = showIt ? 'text' : 'password';
    $('#pwToggle').textContent = showIt ? 'Hide' : 'Show';
    $('#pwToggle').setAttribute('aria-label', showIt ? 'Hide password' : 'Show password');
    inp.focus();
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginUser').value.trim();
    const password = $('#loginPass').value;
    const err = (m) => {
      $('#loginErr').textContent = m;
      const card = $('.login-card'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    };
    if (!email) { err('Enter your email.'); $('#loginUser').focus(); return; }
    if (!password) { err('Enter the password.'); $('#loginPass').focus(); return; }
    const btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const out = await api('/api/auth/login', { email, password });
      LS.set('pc_token', out.token); LS.set('pc_token_exp', out.expiresAt);
      LS.set('pc_login_user', email);
      if (out.platform) { location.href = '/console'; return; }
      if (out.user.mustChangePassword) { showPwChange(password); return; }
      await afterSignIn();
      toast(`Signed in as ${out.user.name}`);
    } catch (e2) {
      err(e2.message || 'Could not sign in.');
      $('#loginPass').select();
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
  function signOut() {
    const work = state.cur && !state.cur.saved && (Object.keys(state.cur.shots || {}).length || state.cur.result);
    if (!confirm(work ? 'Sign out? The current inspection has not been saved and will be lost.' : 'Sign out on this device?')) return;
    signOutLocal();
    state.cur = null; state.me = null;
    LS.set('pc_types_cache', []);
    showLogin('You are signed out.');
  }

  // ---------- profile ----------
  const initials = (n) => (String(n || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  function paintProfileBits() {
    const p = state.profile;
    $('#topAvatar').textContent = initials(p.name);
    $('#profAvatar').textContent = initials(p.name);
    $('#profName').textContent = p.name || 'Your name';
    $('#profSub').textContent = [p.role, p.company].filter(Boolean).join(', ') || 'Add your details below';
  }

  // ---------- result tag ----------
  const TAG_WORDS = {
    safety: {
      GREEN: { word: 'SAFE TO USE', sub: 'All checks passed' },
      YELLOW: { word: 'USE WITH CAUTION', sub: 'Some points need checking' },
      RED: { word: 'DO NOT USE', sub: 'Fix or verify the flagged points' },
    },
    standard: {
      GREEN: { word: 'PASSED', sub: 'All checks passed' },
      YELLOW: { word: 'NEEDS REVIEW', sub: 'Some points could not be confirmed' },
      RED: { word: 'FAILED', sub: 'One or more checks failed' },
    },
  };
  const isSafety = (rec) => rec?.safety ?? rec?.module === 'scaffold';
  const tagWords = (rec, tag) => (isSafety(rec) ? TAG_WORDS.safety : TAG_WORDS.standard)[tag] || TAG_WORDS.standard.YELLOW;
  const assetOf = (rec) => rec.asset || rec.scaffold || {};
  function finalStatus(rec) { return rec.override?.status || rec.result?.status; }
  function resultTag(rec) {
    if (!rec?.result) return 'NONE';
    const ov = rec.override?.status;
    if (ov === 'PASS') return 'GREEN';
    if (ov === 'REVIEW') return 'YELLOW';
    if (ov === 'FAIL') return 'RED';
    const st = rec.result.status;
    const critBad = (rec.result.checklist || []).some((c) => (c.critical ?? splitCheck(c.part).critical) && c.status !== 'present');
    if (st === 'FAIL' || (st === 'REVIEW' && critBad)) return 'RED';
    if (st === 'REVIEW') return 'YELLOW';
    return 'GREEN';
  }

  // ---------- HOME ----------
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  // one saved inspection in a list (rows come from the server)
  function rowHtml(h) {
    const tag = h.finalTag || 'NONE';
    const sub = [h.templateName, h.siteName || h.location, ago(h.createdAt), h.inspectorName, h.reviewStatus === 'pending' ? 'awaiting review' : h.reviewStatus === 'rejected' ? 'rejected' : ''].filter(Boolean).join(', ');
    return `<button type="button" class="row" data-open="${esc(h.id)}">
      <span class="minitag ${tag}" aria-label="${tag === 'NONE' ? 'No tag' : tag + ' tag'}">${tag === 'NONE' ? '–' : tag[0]}</span>
      <span class="row-main"><span class="row-title">${esc(h.assetCode || h.templateName || 'Inspection')}</span><span class="row-sub">${esc(sub)}</span></span>
      <svg class="row-chev" aria-hidden="true"><use href="#i-chev"/></svg>
    </button>`;
  }
  function wireRows(box) {
    $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => openHistory(b.dataset.open)));
  }
  function renderHome() {
    const p = state.profile;
    $('#greet').textContent = `${greeting()}${p.name ? ', ' + p.name.split(' ')[0] : ''}`;
    $('#homeSite').textContent = state.me?.tenant?.name || p.site || 'Inspections';
    const recentIds = LS.get('pc_recent_types', []).filter((id) => getType(id)).slice(0, 4);
    $('#quickTypes').hidden = !recentIds.length;
    $('#quickRow').innerHTML = recentIds.map((id) => { const t = getType(id); return `<button type="button" data-type="${esc(id)}">${typeIcon(t)}${esc(t.name)}</button>`; }).join('');
    $$('#quickRow [data-type]').forEach((b) => b.addEventListener('click', () => selectType(b.dataset.type)));
    $('#homeInstall').hidden = !canOfferInstall() || LS.get('pc_hide_install', false);
    loadHomeData();
  }
  async function loadHomeData() {
    if (!state.me) return;
    const [dash, recent, due, tasks] = await Promise.allSettled([
      api('/api/dashboard?days=7'), api('/api/inspections?limit=4'), api('/api/due?days=7'), api('/api/actions?status=open&mine=1'),
    ]);
    if (state.view !== 'home') return;
    const t = dash.value?.totals || { GREEN: 0, YELLOW: 0, RED: 0 };
    $('#tagStats').innerHTML = [['GREEN', 'Passed'], ['YELLOW', 'Review'], ['RED', 'Failed']]
      .map(([k, l]) => `<button type="button" class="tag-stat ${k}" data-filter="${k}"><b>${t[k] || 0}</b><span>${l}</span></button>`).join('');
    $$('#tagStats [data-filter]').forEach((b) => b.addEventListener('click', () => { state.histFilter = b.dataset.filter; show('history'); }));
    const rows = recent.value?.inspections || [];
    $('#homeRecent').innerHTML = rows.length ? rows.map(rowHtml).join('')
      : '<div class="empty"><b>No inspections yet</b><span>Your first inspection will show here.</span></div>';
    wireRows($('#homeRecent'));
    // due inspections (schedules + assets)
    const items = (due.value?.items || []).slice(0, 6);
    $('#homeDueWrap').hidden = !items.length;
    $('#homeDueCount').textContent = due.value?.items?.length ? `${due.value.items.length} in the next 7 days` : '';
    $('#homeDue').innerHTML = items.map((d, i) => `<button type="button" class="row due-row" data-due="${i}">
      <span class="minitag ${d.overdue ? 'OVER' : 'SOON'}">${d.overdue ? '!' : '•'}</span>
      <span class="row-main"><span class="row-title">${esc(d.title)}</span><span class="row-sub">${esc([d.overdue ? 'Overdue since ' + new Date(d.dueAt).toLocaleDateString() : 'Due ' + new Date(d.dueAt).toLocaleDateString(), d.siteName, d.location].filter(Boolean).join(', '))}</span></span>
      <svg class="row-chev" aria-hidden="true"><use href="#i-chev"/></svg></button>`).join('');
    $$('#homeDue [data-due]').forEach((b) => b.addEventListener('click', () => startDue(items[+b.dataset.due])));
    // my corrective actions
    const acts = (tasks.value?.actions || []).slice(0, 6);
    $('#homeTasksWrap').hidden = !acts.length;
    $('#homeTasks').innerHTML = acts.map((a, i) => `<button type="button" class="row" data-act="${i}">
      <span class="sev-pill ${esc(a.severity)}">${esc(a.severity)}</span>
      <span class="row-main"><span class="row-title">${esc(a.title)}</span><span class="row-sub">${esc([a.overdue ? 'Overdue' : a.dueAt ? 'Due ' + new Date(a.dueAt).toLocaleDateString() : '', a.status === 'in_progress' ? 'in progress' : '', a.siteName].filter(Boolean).join(', '))}</span></span>
      <svg class="row-chev" aria-hidden="true"><use href="#i-chev"/></svg></button>`).join('');
    $$('#homeTasks [data-act]').forEach((b) => b.addEventListener('click', () => openAction(acts[+b.dataset.act])));
  }
  function startDue(d) {
    if (!d.templateId || !getType(d.templateId)) { toast('This inspection type is not available. Ask your admin.', true); return; }
    selectType(d.templateId);
    $('#sfId').value = d.assetCode || '';
    if (d.siteId) $('#sfSite').value = d.siteId;
    if (d.location) $('#sfLocation').value = d.location;
    if (d.assetCode) lookupAsset();
  }
  // close or update a corrective action from the phone
  function openAction(a) {
    const dlg = $('#actionDlg');
    $('#adTitle').textContent = a.title;
    $('#adDesc').textContent = a.description || '';
    $('#adNote').value = a.closureNote || '';
    $('#adPhoto').value = '';
    const send = async (status) => {
      let closurePhoto;
      const f = $('#adPhoto').files?.[0];
      if (f) closurePhoto = await shrink(URL.createObjectURL(f), 1024, 0.72);
      try {
        await api('/api/actions/' + a.id, { status, closureNote: $('#adNote').value.trim(), closurePhoto }, { method: 'PUT' });
        dlg.close(); toast(status === 'done' ? 'Action marked done' : 'Action updated'); loadHomeData();
      } catch (e) { toast(e.message, true); }
    };
    $('#adDone').onclick = () => send('done');
    $('#adProgress').onclick = () => send('in_progress');
    $('#adClose').onclick = () => dlg.close();
    dlg.showModal();
  }
  $('#homeInstallClose').addEventListener('click', () => { LS.set('pc_hide_install', true); $('#homeInstall').hidden = true; });

  // ---------- STEP 1: choose what to inspect ----------
  function renderTypePicker() {
    const q = state.typeQuery.toLowerCase();
    const list = state.types.filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q));
    $('#typeGrid').innerHTML = list.map((t) => `
      <button type="button" class="type-card" data-type="${esc(t.id)}">
        ${typeIcon(t)}
        <b>${esc(t.name)}</b>
        <p>${esc(t.description || '')}</p>
        <small>${t.angles.length} view${t.angles.length === 1 ? '' : 's'}, ${countChecks(t)} checks</small>
      </button>`).join('') + `
      <button type="button" class="type-card new" data-new-type="picker">
        <span class="type-icon"><svg><use href="#i-plus"/></svg></span>
        <b>Create custom inspection</b>
        <p>Your own name, views and checklist</p>
      </button>`;
    $$('#typeGrid [data-type]').forEach((b) => b.addEventListener('click', () => selectType(b.dataset.type)));
  }
  $('#typeSearch').addEventListener('input', (e) => { state.typeQuery = e.target.value; renderTypePicker(); });

  function selectType(id) {
    if (state.selTypeId !== id) resetSetupForm();
    state.selTypeId = id;
    LS.set('pc_last_type', id);
    show('details');
  }

  // ---------- STEP 2: details ----------
  function renderDetails() {
    const t = getType(state.selTypeId);
    if (!t) return;
    $('#dtIconWrap').innerHTML = typeIcon(t);
    $('#dtName').textContent = t.name;
    $('#dtDesc').textContent = t.description || '';
    $('#sfIdLabel').textContent = t.idLabel || 'Asset ID / serial no.';
    $('#sfId').placeholder = 'e.g. A-102';
    renderCustomFields(t);
    loadAssetList(t);
    $('#btnQr').hidden = !('BarcodeDetector' in window);
    if (!$('#sfInspector').value) $('#sfInspector').value = state.profile.name || '';
    if (state.profile.site) $('#sfLocation').placeholder = state.profile.site;
    $('#planSteps').innerHTML = t.angles.map((a) => {
      const crit = a.parts.filter((p) => splitCheck(p).critical).length;
      return `<li><b>${esc(a.name)}</b><span>${a.parts.length} check${a.parts.length === 1 ? '' : 's'}${crit ? `, ${crit} critical` : ''}. ${esc(a.guidance || '')}</span></li>`;
    }).join('') + ((t.general_parts || []).length ? `<li class="any"><b>Seen in any view</b><span>${t.general_parts.map((p) => esc(splitCheck(p).name)).join(', ')}</span></li>` : '');
  }
  $('#btnEditThisType').addEventListener('click', () => openEditor(state.selTypeId, 'details'));
  $('#btnEditThisType').hidden = false;

  function renderCustomFields(t) {
    const box = $('#customFields');
    const keep = {}; $$('[data-cf]', box).forEach((el) => { keep[el.dataset.cf] = el.type === 'checkbox' ? el.checked : el.value; });
    box.innerHTML = (t.customFields || []).map((f) => {
      const id = 'cf_' + f.key;
      const req = f.required ? ' *' : '';
      if (f.type === 'select') return `<label class="field"><span>${esc(f.label)}${req}</span><select data-cf="${esc(f.key)}" id="${id}"><option value="">Choose</option>${(f.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>`;
      if (f.type === 'checkbox') return `<label class="switch"><input type="checkbox" data-cf="${esc(f.key)}" id="${id}" /><span class="switch-ui" aria-hidden="true"></span><span>${esc(f.label)}</span></label>`;
      const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
      return `<label class="field"><span>${esc(f.label)}${req}</span><input data-cf="${esc(f.key)}" id="${id}" type="${type}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} maxlength="120" /></label>`;
    }).join('');
    $$('[data-cf]', box).forEach((el) => { if (keep[el.dataset.cf] !== undefined) { if (el.type === 'checkbox') el.checked = keep[el.dataset.cf]; else el.value = keep[el.dataset.cf]; } });
    if ((t.customFields || []).some((f) => f.required)) $('#sfMore').open = true;
  }
  function readCustomFields(t) {
    const out = {};
    for (const f of t.customFields || []) {
      const el = $(`[data-cf="${CSS.escape(f.key)}"]`);
      const v = el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : '';
      if (f.required && (v === '' || v === false)) { $('#sfMore').open = true; el?.focus(); throw new Error(`Fill in "${f.label}".`); }
      if (v !== '' && v !== false) out[f.key] = { label: f.label, value: v };
    }
    return out;
  }
  async function loadAssetList(t) {
    try {
      const out = await api('/api/assets?template=' + encodeURIComponent(t.id));
      state.assets = out.assets;
      $('#assetList').innerHTML = out.assets.slice(0, 300).map((a) => `<option value="${esc(a.code)}">${esc([a.name, a.location].filter(Boolean).join(', '))}</option>`).join('');
    } catch { $('#assetList').innerHTML = ''; }
  }
  let lookupTimer;
  async function lookupAsset() {
    const code = $('#sfId').value.trim();
    const info = $('#assetInfo');
    if (!code) { info.hidden = true; return; }
    try {
      const { asset } = await api('/api/assets/lookup?code=' + encodeURIComponent(code));
      if ($('#sfId').value.trim() !== code) return;
      if (!asset) { info.hidden = false; info.textContent = 'New asset. It will be added to the asset register when you save.'; return; }
      if (asset.location && !$('#sfLocation').value) $('#sfLocation').value = asset.location;
      if (asset.siteId) $('#sfSite').value = asset.siteId;
      info.hidden = false;
      info.textContent = [asset.name || 'Known asset', asset.lastTag ? `last result ${asset.lastTag.toLowerCase()} ${ago(asset.lastInspectedAt)}` : 'not inspected yet', asset.nextDueAt ? (asset.overdue ? 'OVERDUE' : 'next due ' + new Date(asset.nextDueAt).toLocaleDateString()) : ''].filter(Boolean).join(', ');
    } catch { info.hidden = true; }
  }
  $('#sfId').addEventListener('input', () => { clearTimeout(lookupTimer); lookupTimer = setTimeout(lookupAsset, 500); });
  // read a QR code / barcode label from a photo (Android Chrome and others with BarcodeDetector)
  $('#qrInput').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const codes = await new window.BarcodeDetector().detect(bmp);
      if (!codes.length) { toast('No QR code or barcode found. Try closer and with more light.', true); return; }
      let v = codes[0].rawValue || '';
      const m = /[?&]asset=([^&]+)/.exec(v); if (m) v = decodeURIComponent(m[1]);
      $('#sfId').value = v.slice(0, 80); lookupAsset(); toast('Code read: ' + v.slice(0, 40));
    } catch { toast('Could not read the code on this device.', true); }
  });


  function newRecord(mode = 'photo') {
    const t = getType(state.selTypeId);
    if (!t) { show('setup'); throw new Error('Choose what you are inspecting first.'); }
    if (!countChecks(t)) throw new Error('This inspection type has no checks yet. Tap Edit checklist to add some.');
    const id = $('#sfId').value.trim();
    if (!id) {
      $('#sfId').classList.add('invalid'); $('#sfId').focus();
      throw new Error(`Enter the ${(t.idLabel || 'asset ID').toLowerCase()}.`);
    }
    $('#sfId').classList.remove('invalid');
    const custom = readCustomFields(t);
    const siteId = $('#sfSite').value || '';
    const siteName = (state.sites || []).find((x) => x.id === siteId)?.name || '';
    const location = $('#sfLocation').value.trim() || siteName || '';
    const inspector = $('#sfInspector').value.trim() || state.profile.name || '';
    const asset = { id, location, lastInspection: $('#sfLast').value, reason: $('#sfReason').value };
    const notes = $('#sfNotes').value.trim();
    const description = [
      t.description,
      ...Object.values(custom).map((c) => `${c.label}: ${c.value === true ? 'yes' : c.value}`),
      asset.reason && `Inspection: ${asset.reason}`,
      notes && `Inspector notes: ${notes}`,
    ].filter(Boolean).join('. ');
    state.cur = {
      mode,
      typeId: t.id,
      typeName: t.name,
      safety: Boolean(t.safety),
      idLabel: t.idLabel || 'Asset ID',
      asset,
      id: uid(),
      createdAt: new Date().toISOString(),
      item: t.name,
      description,
      angles: clone(t.angles),
      general_parts: clone(t.general_parts || []),
      meta: {
        inspector, serial: id, location, notes, gps: null,
        company: state.profile.company || '', empId: state.profile.empId || '', siteId, siteName, custom,
      },
      shots: {},
      result: null,
      override: { status: '', remarks: '' },
      signoff: { done: false, by: '', at: '' },
      saved: false,
    };
    LS.set('pc_recent_types', [t.id, ...LS.get('pc_recent_types', []).filter((x) => x !== t.id)].slice(0, 6));
    state.angleIdx = 0;
    if ($('#sfGps').checked) getGps();
    return state.cur;
  }
  $('#sfId').addEventListener('input', () => $('#sfId').classList.remove('invalid'));

  function resetSetupForm() {
    ['#sfId', '#sfLocation', '#sfLast', '#sfNotes'].forEach((s) => { $(s).value = ''; });
    $$('#customFields [data-cf]').forEach((el) => { if (el.type === 'checkbox') el.checked = false; else el.value = ''; });
    $('#assetInfo').hidden = true;
    $('#sfId').classList.remove('invalid');
  }

  function getGps() {
    if (!navigator.geolocation) return toast('GPS is not available on this device.', true);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (state.cur) state.cur.meta.gps = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }; },
      () => toast('Location permission denied. Photos will not have GPS.', true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  $('#btnStart').addEventListener('click', () => {
    try { newRecord('photo'); } catch (e) { toast(e.message, true); return; }
    show('capture');
    renderCapture();
    startCamera();
  });

  // ---------- FLASH (torch) – shared by photo mode and live scan ----------
  // Off / On / Auto. Works in Chrome on most Android phones; iPhone browsers usually do not allow it.
  function createFlash(btn, getTrack) {
    const LABEL = { off: 'Off', on: 'On', auto: 'Auto' };
    const ctl = { mode: LS.get('pc_flash', 'off'), lit: false, supported: false, darkSince: 0, brightSince: 0, lastBrightness: 128, holdUntil: 0 };
    const label = (t) => { const sp = $('span', btn); if (sp) sp.textContent = t; else btn.textContent = t; };
    function paint() {
      if (!ctl.supported) { label('No flash'); btn.disabled = true; btn.classList.remove('on'); btn.title = 'Flash is not supported by this camera or browser'; return; }
      btn.disabled = false; btn.title = 'Flash: tap to change';
      label(`${LABEL[ctl.mode]}${ctl.mode === 'auto' && ctl.lit ? ' (on)' : ''}`);
      btn.classList.toggle('on', ctl.lit);
      btn.setAttribute('aria-label', `Flash ${LABEL[ctl.mode]}`);
    }
    async function set(on) {
      const t = getTrack();
      if (!t || !ctl.supported) return false;
      try { await t.applyConstraints({ advanced: [{ torch: on }] }); ctl.lit = on; }
      catch { ctl.lit = false; if (on) toast('Could not turn on the flash on this camera.', true); }
      paint();
      return ctl.lit === on;
    }
    ctl.attach = () => {
      const t = getTrack();
      ctl.supported = Boolean(t?.getCapabilities?.().torch);
      ctl.mode = LS.get('pc_flash', ctl.mode);
      ctl.lit = false; ctl.darkSince = 0; ctl.brightSince = 0;
      paint();
      if (ctl.supported && ctl.mode === 'on') set(true);
    };
    ctl.detach = () => { ctl.lit = false; ctl.supported = false; ctl.holdUntil = 0; };
    // turn the light off now (after a photo, before checking photos). holdMs stops Auto from relighting at once.
    ctl.off = (holdMs = 0) => { ctl.holdUntil = holdMs ? Date.now() + holdMs : 0; ctl.darkSince = 0; return ctl.lit ? set(false) : Promise.resolve(true); };
    // camera preview is back: "On" mode lights again, "Auto" decides by itself
    ctl.resume = () => { ctl.holdUntil = 0; if (ctl.supported && ctl.mode === 'on' && !ctl.lit) set(true); };
    // switch the torch off BEFORE stopping the camera (some phones keep it lit otherwise)
    ctl.stopTrack = (t) => {
      if (!t) return;
      if (ctl.lit && ctl.supported) t.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}).finally(() => t.stop());
      else t.stop();
    };
    ctl.feed = (b) => {
      ctl.lastBrightness = b;
      if (ctl.mode !== 'auto' || !ctl.supported || Date.now() < ctl.holdUntil) return;
      const now = Date.now();
      if (!ctl.lit && b < 60) { ctl.darkSince ||= now; if (now - ctl.darkSince > 700) set(true); } else ctl.darkSince = 0;
      if (ctl.lit && b > 185) { ctl.brightSince ||= now; if (now - ctl.brightSince > 2000) set(false); } else ctl.brightSince = 0;
    };
    ctl.beforeShot = async () => {
      if (ctl.mode === 'auto' && ctl.supported && !ctl.lit && ctl.lastBrightness < 70) {
        if (await set(true)) await sleep(700);
      }
    };
    btn.addEventListener('click', () => {
      ctl.mode = ctl.mode === 'off' ? 'on' : ctl.mode === 'on' ? 'auto' : 'off';
      LS.set('pc_flash', ctl.mode);
      if (ctl.mode === 'on') set(true); else if (ctl.mode === 'off') set(false); else paint();
      toast(`Flash: ${LABEL[ctl.mode]}`);
    });
    paint();
    return ctl;
  }

  // ---------- PHOTO CAPTURE ----------
  const video = $('#video');
  const photoFlash = createFlash($('#btnFlash'), () => state.stream?.getVideoTracks()[0]);

  async function startCamera() {
    $('#nocam').hidden = true;
    if (state.stream) { startLiveCheck(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { $('#nocam').hidden = false; $('#btnShoot').disabled = true; return; }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
      });
      video.srcObject = state.stream;
      await video.play().catch(() => {});
      $('#btnShoot').disabled = false;
      photoFlash.attach();
      startLiveCheck();
    } catch {
      $('#nocam').hidden = false;
      $('#btnShoot').disabled = true;
      toast('Camera blocked or not found. Use the gallery button instead.', true);
    }
  }
  function stopCamera() {
    clearInterval(state.liveTimer); state.liveTimer = null;
    if (state.stream) { state.stream.getTracks().forEach((t) => photoFlash.stopTrack(t)); state.stream = null; }
    photoFlash.detach();
    video.srcObject = null;
  }

  // brightness + sharpness check (like the "hold steady" hints in face KYC)
  const qCanvas = document.createElement('canvas');
  function analyze(src, sw, sh) {
    const w = 256, h = Math.max(1, Math.round((sh / sw) * 256));
    qCanvas.width = w; qCanvas.height = h;
    const ctx = qCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += g[j]; }
    const brightness = sum / g.length;
    let n = 0, m = 0, m2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      n++; const delta = lap - m; m += delta / n; m2 += delta * (lap - m);
    }
    const sharpness = n > 1 ? m2 / (n - 1) : 0;
    const issues = [];
    if (brightness < 55) issues.push('Too dark');
    else if (brightness > 215) issues.push('Too bright');
    if (sharpness < 40) issues.push('Blurry – hold steady');
    return { brightness: Math.round(brightness), sharpness: Math.round(sharpness), ok: issues.length === 0, issues };
  }
  function qualityPills(q) {
    if (!q) return '';
    const light = q.brightness < 55 ? ['bad', 'Too dark'] : q.brightness > 215 ? ['bad', 'Too bright'] : ['good', 'Light OK'];
    const sharp = q.sharpness < 40 ? ['bad', 'Blurry'] : ['good', 'Sharp'];
    return [light, sharp].map(([c, t]) => `<span class="qpill ${c}">${t}</span>`).join('');
  }
  function startLiveCheck() {
    clearInterval(state.liveTimer);
    state.liveTimer = setInterval(() => {
      if (!state.cur || state.view !== 'capture') return;
      const a = state.cur.angles[state.angleIdx];
      if (state.cur.shots[a?.name] || !video.videoWidth) return;
      const q = analyze(video, video.videoWidth, video.videoHeight);
      photoFlash.feed(q.brightness);
      $('#qbar').innerHTML = qualityPills(q);
    }, 500);
  }

  function watermark(ctx, w, h, angleName) {
    const strip = Math.max(18, Math.round(h * 0.034));
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h - strip, w, strip);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(strip * 0.6)}px Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    const m = state.cur.meta;
    const gps = m.gps ? `  |  ${m.gps.lat}, ${m.gps.lng}` : '';
    const text = `${m.serial || state.cur.item}  |  ${angleName}  |  ${new Date().toLocaleString()}${gps}`;
    ctx.fillText(text, Math.round(strip * 0.4), h - strip / 2, w - strip);
  }

  function processImage(src, sw, sh) {
    const a = state.cur.angles[state.angleIdx];
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    const quality = analyze(c, w, h);
    watermark(ctx, w, h, a.name);
    state.cur.shots[a.name] = { dataUrl: c.toDataURL('image/jpeg', JPEG_Q), quality, ts: new Date().toISOString() };
    state.cur.result = null;
    if (!quality.ok) toast(`Saved, but ${quality.issues.join(' and ').toLowerCase()}. Retake for a better result.`, true);
    else navigator.vibrate?.(30);
    renderCapture();
  }

  $('#btnShoot').addEventListener('click', async () => {
    if (!video.videoWidth) { toast('Camera is still starting…'); return; }
    const btn = $('#btnShoot');
    btn.disabled = true;
    try {
      await photoFlash.beforeShot();
      $('#stage').classList.remove('snap'); void $('#stage').offsetWidth; $('#stage').classList.add('snap');
      processImage(video, video.videoWidth, video.videoHeight);
      photoFlash.off(); // like a camera flash: off right after the photo
    } finally { btn.disabled = false; }
  });
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Choose an image file.', true); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { processImage(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
    img.onerror = () => { toast('Could not read that image. Try a JPG or PNG.', true); URL.revokeObjectURL(url); };
    img.src = url;
  });
  $('#btnRetake').addEventListener('click', () => {
    const a = state.cur.angles[state.angleIdx];
    delete state.cur.shots[a.name];
    state.cur.result = null;
    renderCapture();
  });
  $('#btnNext').addEventListener('click', () => {
    const angles = state.cur.angles;
    const nextMissing = angles.findIndex((a, i) => i > state.angleIdx && !state.cur.shots[a.name]);
    const anyMissing = angles.findIndex((a) => !state.cur.shots[a.name]);
    state.angleIdx = nextMissing >= 0 ? nextMissing : anyMissing >= 0 ? anyMissing : state.angleIdx;
    renderCapture();
  });
  $('#btnExtraAngle').addEventListener('click', () => {
    const name = prompt('Name for the extra photo (e.g. "Close-up of damage"):');
    if (!name?.trim()) return;
    if (state.cur.angles.some((a) => a.name.toLowerCase() === name.trim().toLowerCase())) { toast('A view with that name already exists.', true); return; }
    state.cur.angles.push({ name: name.trim().slice(0, 60), guidance: 'Extra evidence photo', parts: [], extra: true });
    state.angleIdx = state.cur.angles.length - 1;
    renderCapture();
  });
  $('#btnBackSetup').addEventListener('click', () => {
    if (Object.keys(state.cur?.shots || {}).length && !confirm('Close the camera? Photos taken so far will be lost.')) return;
    show('details');
  });

  function renderCapture() {
    const cur = state.cur;
    const a = cur.angles[state.angleIdx];
    const shot = cur.shots[a.name];
    const done = cur.angles.filter((x) => cur.shots[x.name]).length;
    const total = cur.angles.length;
    $('#capProgress').textContent = `${cur.meta.serial}, view ${state.angleIdx + 1} of ${total}`;
    $('#angleName').textContent = a.name;

    $('#angleChips').innerHTML = cur.angles.map((x, i) => {
      const s = cur.shots[x.name];
      const cls = [i === state.angleIdx ? 'cur' : '', s ? (s.quality.ok ? 'ok' : 'warn') : ''].join(' ');
      return `<button type="button" role="tab" class="${cls}" data-i="${i}" aria-selected="${i === state.angleIdx}">${i + 1}. ${esc(x.name)}</button>`;
    }).join('');
    $$('#angleChips button').forEach((b) => b.addEventListener('click', () => { state.angleIdx = +b.dataset.i; renderCapture(); }));
    const chip = $('#angleChips .cur'), bar = $('#angleChips');
    if (chip) bar.scrollTo({ left: chip.offsetLeft - (bar.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });

    $('#angleGuide').textContent = a.guidance || 'Fill the yellow frame with this view.';
    $('#angleParts').innerHTML = a.parts.length
      ? a.parts.map((p) => { const c = splitCheck(p); return `<li class="${c.critical ? 'is-crit' : ''}"><span>${esc(c.name)}${c.critical ? ' <span class="crit-dot">critical</span>' : ''}</span></li>`; }).join('')
      : '<li class="none">Extra evidence photo, no checks.</li>';

    $('#stage').classList.toggle('has-shot', Boolean(shot));
    $('#preview').hidden = !shot;
    video.hidden = Boolean(shot);
    if (shot) { $('#preview').src = shot.dataUrl; $('#qbar').innerHTML = qualityPills(shot.quality); $('#nocam').hidden = true; }
    else { $('#qbar').innerHTML = ''; $('#nocam').hidden = Boolean(state.stream) || !$('#btnShoot').disabled; }
    $('#btnShoot').hidden = Boolean(shot);
    $('#lblUpload').hidden = Boolean(shot);
    $('#btnRetake').hidden = !shot;
    const allDone = done === total;
    $('#btnNext').hidden = !shot || allDone;
    if (state.stream) { if (shot) photoFlash.off(); else photoFlash.resume(); }
    const ev = $('#btnEvaluate');
    ev.disabled = done === 0;
    ev.textContent = allDone ? 'Check photos and get tag' : `Check photos (${done} of ${total})`;
  }

  // ---------- evaluate (photo mode, also used by live "full check") ----------
  $('#btnEvaluate').addEventListener('click', evaluate);
  async function evaluate() {
    const cur = state.cur;
    const missingViews = cur.angles.filter((a) => !cur.shots[a.name] && a.parts.length);
    if (missingViews.length && !confirm(`No photo yet for: ${missingViews.map((a) => a.name).join(', ')}.\nTheir checks will be marked Not OK. Check anyway?`)) return;
    const payload = {
      item: cur.item,
      templateId: cur.typeId || '',
      description: cur.description,
      general_parts: cur.general_parts,
      angles: cur.angles.map((a) => ({ name: a.name, guidance: a.guidance || '', parts: a.parts, image: cur.shots[a.name]?.dataUrl || null })),
    };
    const sizeMb = JSON.stringify(payload).length / 1048576;
    if (sizeMb > 4.2 && !confirm(`Upload is ${sizeMb.toFixed(1)} MB and may be too large. Continue?`)) return;
    loading(true, 'Checking every point twice…');
    const fromPhotoMode = state.view === 'capture';
    stopCamera(); // flash and camera off while the AI checks the photos
    try {
      cur.result = await api('/api/ai/evaluate', payload);
      cur.override = { status: '', remarks: '' };
      cur.saved = false;
      renderResult();
      show('result');
    } catch (e) {
      toast(e.message, true);
      if (fromPhotoMode && state.view === 'capture') { await startCamera(); renderCapture(); }
    } finally {
      loading(false);
    }
  }

  // ---------- RESULT ----------
  const ICON = { present: '✓', missing: '✕', unclear: '?' };
  const STATUS_TEXT = { present: 'OK', missing: 'Not OK', unclear: 'Unclear' };

  function partRow(c) {
    const sc = splitCheck(c.part);
    const crit = c.critical ?? sc.critical;
    const where = c.group === ANY && c.foundIn ? `Seen in ${c.foundIn}. ` : '';
    return `<li>
      <span class="ic ${c.status}" aria-label="${STATUS_TEXT[c.status]}">${ICON[c.status]}</span>
      <span><span class="pn">${crit ? '<span class="crit">Critical</span>' : ''}${esc(sc.name)}</span>
        ${sc.rule ? `<span class="prule">Must be: ${esc(sc.rule)}</span>` : ''}
        <span class="pnote">${esc(STATUS_TEXT[c.status] + '. ' + where + cap(c.note || ''))}</span></span>
      <span class="pc">${Math.round((c.confidence || 0) * 100)}%</span>
    </li>`;
  }

  function renderResult() {
    const rec = state.cur;
    const r = rec.result;
    const ai = r.ai || {};
    const tag = resultTag(rec);
    const tt = tagWords(rec, tag);
    const sf = assetOf(rec);
    const safety = isSafety(rec);
    const scaffoldRec = /scaffold/i.test(rec.typeName || '');
    const customTxt = Object.values(rec.meta?.custom || {}).map((c) => `${c.label}: ${c.value === true ? 'yes' : c.value}`).join(', ');
    const rv = rec.reviewStatus;
    const reviewHtml = rv === 'pending' ? '<p class="review-line pending">Waiting for manager review</p>'
      : rv === 'approved' ? `<p class="review-line approved">Approved by ${esc(rec.review?.by || 'manager')}${rec.review?.comment ? ': ' + esc(rec.review.comment) : ''}</p>`
      : rv === 'rejected' ? `<p class="review-line rejected">Rejected by ${esc(rec.review?.by || 'manager')}: ${esc(rec.review?.comment || '')}</p>` : '';
    const when = r.evaluatedAt || rec.createdAt;
    const ov = rec.override?.status || '';
    const bad = r.checklist.filter((c) => c.status === 'missing');
    const unc = r.checklist.filter((c) => c.status === 'unclear');
    const attention = [...bad.sort((a, b) => Number(b.critical ?? 0) - Number(a.critical ?? 0)), ...unc];
    const defects = ai.defects || [];
    const groups = [...rec.angles.map((a) => a.name), ...(r.checklist.some((c) => c.group === ANY) ? [ANY] : [])];
    const details = [
      sf.height && `${sf.height} m high`, sf.lifts && `${sf.lifts} lifts`, sf.duty, sf.erector && `erected by ${sf.erector}`,
      sf.lastInspection && `last inspected ${sf.lastInspection}`, sf.reason,
    ].filter(Boolean).join(', ');

    const groupHtml = groups.map((g) => {
      const rows = r.checklist.filter((c) => c.group === g);
      const shot = rec.shots[g];
      if (!rows.length && !shot) return '';
      const okN = rows.filter((c) => c.status === 'present').length;
      return `<div class="check-group">
        <div class="cg-head">
          ${shot ? `<img src="${shot.dataUrl}" alt="${esc(g)} photo" data-zoom />` : `<div class="noimg">${g === ANY ? 'All views' : 'No photo'}</div>`}
          <div><h3>${esc(g)}</h3><p>${rows.length ? `${okN} of ${rows.length} OK` : 'Extra photo'}</p></div>
        </div>
        ${rows.length ? `<ul class="plist">${rows.map(partRow).join('')}</ul>` : ''}
      </div>`;
    }).join('');

    $('#view-result').innerHTML = `
      <div class="result-wrap">
        <div class="stag-col">
          <article class="stag ${tag}" aria-label="${tag} tag: ${tt.word}">
            <div class="stag-top">
              <div class="stag-word">${tt.word}</div>
              <div class="stag-sub">${ov ? 'Set by inspector' : esc(tt.sub)}</div>
            </div>
            <div class="stag-body">
              <dl class="stag-fields">
                <div><dt>${esc(rec.typeName || rec.item || 'Item')}</dt><dd>${esc(sf.id || rec.meta.serial || '–')}</dd></div>
                <div><dt>Location</dt><dd>${esc(sf.location || rec.meta.location || '–')}</dd></div>
                <div><dt>Inspected by</dt><dd>${esc(rec.meta.inspector || '–')}</dd></div>
                <div><dt>Date</dt><dd>${esc(fmtDate(when))}</dd></div>
              </dl>
              <div class="stag-score">
                <b>${r.completion}%</b>
                <div style="flex:1;display:grid;gap:.35rem">
                  <div class="stag-bar"><i style="width:${r.completion}%"></i></div>
                  <div class="stag-counts"><span class="ok">${r.counts.present} OK</span><span class="bad">${r.counts.missing} not OK</span><span class="unc">${r.counts.unclear} unclear</span></div>
                </div>
              </div>
              ${rec.signoff?.done ? `<p class="stag-note">Signed off by ${esc(rec.signoff.by)} on ${esc(fmtDate(rec.signoff.at))}</p>` : `<p class="stag-note">AI result. ${safety ? 'Needs sign-off by a competent person.' : 'Inspector to confirm.'}</p>`}
            </div>
            <div class="stag-foot"></div>
          </article>
          <div class="result-actions">
            ${reviewHtml}
            <button type="button" class="btn btn-hivis" id="btnSave">${rec.saved ? 'Saved ✓ Update' : 'Save inspection'}</button>
            <button type="button" class="btn btn-line" id="btnShare"><svg aria-hidden="true"><use href="#i-share"/></svg>Share</button>
            <button type="button" class="btn btn-line" id="btnPrint"><svg aria-hidden="true"><use href="#i-download"/></svg>PDF report</button>
            <button type="button" class="btn btn-line btn-sm" id="btnCsv">Export CSV</button>
            ${!rec.fromHistory ? `<button type="button" class="btn btn-line btn-sm" id="btnRecapture">${rec.mode === 'live' ? 'Continue scan' : 'Retake photos'}</button>` : '<span></span>'}
          </div>
        </div>

        <div class="result-main">
          ${attention.length ? `<div class="card">
            <h2 class="card-title">Needs attention</h2>
            <ul class="plist attention">${attention.map((c) => partRow(c).replace('<li>', `<li class="${c.status === 'unclear' ? 'unc' : ''}">`)).join('')}</ul>
          </div>` : `<div class="card"><h2 class="card-title">All ${r.counts.total} checks passed</h2><p class="muted">${esc(ai.summary || '')}</p></div>`}

          <div class="card">
            <h2 class="card-title">Your decision</h2>
            <div class="decision" role="radiogroup" aria-label="Final tag">
              <button type="button" data-o="" class="${!ov ? 'on' : ''}">Keep AI result</button>
              <button type="button" data-o="PASS" class="${ov === 'PASS' ? 'on' : ''}">Green</button>
              <button type="button" data-o="REVIEW" class="${ov === 'REVIEW' ? 'on' : ''}">Yellow</button>
              <button type="button" data-o="FAIL" class="${ov === 'FAIL' ? 'on' : ''}">Red</button>
            </div>
            <label class="field" style="margin:0"><span>Remarks and actions</span><textarea id="ovRemarks" rows="2" maxlength="500" placeholder="e.g. Toe board fitted on east side, re-inspect tomorrow">${esc(rec.override?.remarks || '')}</textarea></label>
            <label class="signoff"><input type="checkbox" id="signoff" ${rec.signoff?.done ? 'checked' : ''} /> <span>${safety ? `I have inspected this ${esc((rec.typeName || 'item').toLowerCase())} in person as a competent person` : 'I have checked this in person and confirm the result'}${state.profile.name ? ` (${esc(state.profile.name)})` : ''}.</span></label>
          </div>

          <div class="card">
            <h2 class="card-title">Why this tag</h2>
            <ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
            ${ai.item_matches === false ? `<p class="disclaimer">The photos do not clearly show a ${esc((rec.typeName || 'the item').toLowerCase())}. Retake them.</p>` : ''}
            ${details ? `<p class="muted">Details: ${esc(details)}.</p>` : ''}
            ${customTxt ? `<p class="muted">${esc(customTxt)}</p>` : ''}
            ${rec.meta?.siteName ? `<p class="muted">Site: ${esc(rec.meta.siteName)}</p>` : ''}
            ${(rec.actions || []).length ? `<p class="muted">Corrective actions: ${rec.actions.map((a) => esc(a.title) + ' (' + esc(a.status) + ')').join('; ')}</p>` : ''}
            ${rec.meta.notes ? `<p class="muted">Notes: ${esc(rec.meta.notes)}</p>` : ''}
            ${rec.meta.gps ? `<p class="muted">GPS: ${rec.meta.gps.lat}, ${rec.meta.gps.lng}</p>` : ''}
          </div>

          ${defects.length ? `<div class="card"><h2 class="card-title">Damage spotted</h2>
            <ul class="defects">${defects.map((d) => `<li><span class="sev ${esc(d.severity)}">${esc(d.severity)}</span><span>${esc(d.description)}${d.angle ? ` <span class="muted">(${esc(d.angle)})</span>` : ''}</span></li>`).join('')}</ul></div>` : ''}

          <div class="card">
            <h2 class="card-title">All checks</h2>
            ${groupHtml}
          </div>

          <p class="disclaimer">${scaffoldRec ? 'AI pre-inspection only, not a scaffold certificate. A competent person must inspect and sign the tag before use.' : safety ? 'AI pre-inspection only. A competent person must confirm before use.' : 'The AI result supports the inspector, who makes the final decision.'}
            ${r.liveStats ? ` Live scan checked ${r.liveStats.calls} frames in ${r.liveStats.seconds} s.` : ''}${r.secondCheck ? ' Every OK was double-checked.' : ''}</p>
        </div>
      </div>`;

    $$('.decision button').forEach((b) => b.addEventListener('click', () => {
      rec.override.status = b.dataset.o;
      rec.saved = false;
      renderResult();
      toast(b.dataset.o ? `Result set to ${resultTag(rec).toLowerCase()}` : 'Using the AI result');
    }));
    $('#ovRemarks').addEventListener('input', (e) => { rec.override.remarks = e.target.value; rec.saved = false; });
    $('#signoff').addEventListener('change', (e) => {
      rec.signoff = e.target.checked ? { done: true, by: state.profile.name || rec.meta.inspector || 'Inspector', at: new Date().toISOString() } : { done: false, by: '', at: '' };
      rec.saved = false;
      renderResult();
    });
    $('#btnSave').addEventListener('click', () => saveToServer(rec));
    $('#btnShare').addEventListener('click', () => shareSummary(rec));
    $('#btnPrint').addEventListener('click', () => { if (rec.serverId) window.open('/report?id=' + encodeURIComponent(rec.serverId), '_blank'); else window.print(); });
    $('#btnCsv').addEventListener('click', () => exportCsv(rec));
    $('#btnRecapture')?.addEventListener('click', () => {
      if (rec.mode === 'live') { window.dispatchEvent(new CustomEvent('pc:resume-live')); return; }
      show('capture'); renderCapture(); startCamera();
    });
    $$('#view-result [data-zoom]').forEach((img) => img.addEventListener('click', () => zoom(img.src)));
  }

  function zoom(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${src}" alt="Enlarged photo" />`;
    const close = () => { lb.remove(); document.removeEventListener('keydown', k); };
    function k(e) { if (e.key === 'Escape') close(); }
    lb.addEventListener('click', close);
    document.addEventListener('keydown', k);
    document.body.appendChild(lb);
  }

  function summaryText(rec) {
    const tag = resultTag(rec);
    const r = rec.result;
    const a = assetOf(rec);
    const bad = r.checklist.filter((c) => c.status !== 'present').map((c) => `- ${splitCheck(c.part).name}: ${STATUS_TEXT[c.status]}`);
    return [
      `${rec.typeName || rec.item} ${a.id || rec.meta.serial}${a.location ? ' at ' + a.location : ''}`,
      `${tag}: ${tagWords(rec, tag).word}`,
      `${r.counts.present} of ${r.counts.total} checks OK`,
      ...(bad.length ? ['Needs attention:', ...bad.slice(0, 10)] : []),
      rec.override?.remarks ? `Remarks: ${rec.override.remarks}` : '',
      `Inspected by ${rec.meta.inspector || '–'} on ${fmtDate(r.evaluatedAt || rec.createdAt)}`,
      `Checked with ${state.me?.tenant?.branding?.app_name || 'Inspection AI'}.`,
    ].filter(Boolean).join('\n');
  }
  async function shareSummary(rec) {
    const text = summaryText(rec);
    try {
      if (navigator.share) { await navigator.share({ title: `${rec.typeName || rec.item} ${assetOf(rec).id || ''} inspection`, text }); return; }
      await navigator.clipboard.writeText(text);
      toast('Summary copied. Paste it in WhatsApp or email.');
    } catch (e) {
      if (e.name !== 'AbortError') toast('Could not share on this device.', true);
    }
  }

  // ---------- export ----------
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'inspection';
  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportCsv(rec) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const tag = resultTag(rec);
    const head = ['Inspection type', 'ID', 'Location', 'Inspector', 'Date', 'Result', 'AI status', 'Final status', 'Completion %', 'View', 'Check', 'Critical', 'Status', 'Confidence %', 'Note', 'Remarks'];
    const a = assetOf(rec);
    const rows = rec.result.checklist.map((c) => [
      rec.typeName || rec.item, a.id || rec.meta.serial, a.location || rec.meta.location, rec.meta.inspector, fmtDate(rec.result.evaluatedAt),
      tag, rec.result.status, finalStatus(rec), rec.result.completion, c.group, splitCheck(c.part).name,
      (c.critical ?? splitCheck(c.part).critical) ? 'yes' : '', STATUS_TEXT[c.status], Math.round((c.confidence || 0) * 100), c.note, rec.override?.remarks,
    ]);
    const csv = '\uFEFF' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    download(`${slug(rec.typeName || rec.item)}-${slug(a.id || rec.meta.serial)}-${rec.id}.csv`, csv, 'text/csv;charset=utf-8');
  }

  // ---------- history ----------
  function shrink(dataUrl, side = THUMB_SIDE, qual = 0.6) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', qual));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }
  async function saveToServer(rec) {
    loading(true, 'Saving…');
    try {
      if (rec.serverId) {
        await api('/api/inspections/' + rec.serverId, { override: rec.override, signoff: rec.signoff }, { method: 'PUT' });
        toast('Inspection updated');
      } else {
        const photos = [];
        for (const [view, s] of Object.entries(rec.shots || {})) photos.push({ view, dataUrl: await shrink(s.dataUrl, 1024, 0.72), quality: s.quality });
        const out = await api('/api/inspections', {
          templateId: rec.typeId, templateName: rec.typeName, mode: rec.mode, safety: rec.safety, idLabel: rec.idLabel,
          assetCode: rec.asset?.id || rec.meta.serial, siteId: rec.meta.siteId || '', location: rec.asset?.location || rec.meta.location,
          inspectorName: rec.meta.inspector, description: rec.description, angles: rec.angles, general_parts: rec.general_parts,
          result: rec.result, override: rec.override, signoff: rec.signoff, photos, clientId: rec.id, meta: { ...rec.meta, asset: rec.asset },
        });
        rec.serverId = out.id; rec.reviewStatus = out.reviewStatus;
        toast(out.actionsCreated ? `Saved. ${out.actionsCreated} corrective action${out.actionsCreated > 1 ? 's' : ''} created.` : 'Inspection saved');
      }
      rec.saved = true;
      if (!rec.fromHistory) resetSetupForm();
      renderResult();
    } catch (e) { toast(e.message, true); }
    finally { loading(false); }
  }
  async function openHistory(id) {
    loading(true, 'Opening…');
    try {
      const x = (await api('/api/inspections/' + encodeURIComponent(id))).inspection;
      const m = x.meta || {};
      state.cur = {
        serverId: x.id, id: x.id, mode: x.mode, typeId: x.templateId, typeName: x.templateName, item: x.templateName,
        safety: Boolean(m.safety), idLabel: m.idLabel || 'Asset ID', asset: m.asset || { id: x.assetCode, location: x.location },
        description: m.description || '', angles: m.angles || [], general_parts: m.general_parts || [],
        meta: { ...m, inspector: x.inspectorName, serial: x.assetCode, location: x.location, siteName: x.siteName || m.siteName },
        shots: Object.fromEntries((x.photos || []).map((p) => [p.view, { dataUrl: p.dataUrl, quality: p.quality || { ok: true, issues: [] } }])),
        result: x.result, override: x.override || { status: '', remarks: '' }, signoff: x.signoff || { done: false },
        review: x.review, reviewStatus: x.reviewStatus, actions: x.actions, createdAt: x.createdAt, saved: true, fromHistory: true,
      };
      if (!state.cur.angles.length) state.cur.angles = Object.keys(state.cur.shots).map((n) => ({ name: n, parts: [] }));
      renderResult();
      show('result');
    } catch (e) { toast(e.message, true); }
    finally { loading(false); }
  }
  let histTimer;
  async function renderHistory() {
    $$('#histFilters button').forEach((b) => b.classList.toggle('on', b.dataset.f === state.histFilter));
    const box = $('#historyList');
    const q = new URLSearchParams({ limit: '100' });
    if (state.histFilter !== 'all') q.set('tag', state.histFilter);
    if (state.histQuery.trim()) q.set('q', state.histQuery.trim());
    let out;
    try { out = await api('/api/inspections?' + q); } catch (e) { box.innerHTML = `<div class="empty"><b>Could not load</b><span>${esc(e.message)}</span></div>`; return; }
    if (state.view !== 'history') return;
    if (!out.total && state.histFilter === 'all' && !state.histQuery) {
      box.innerHTML = '<div class="empty"><b>No saved inspections</b><span>After an inspection, tap Save inspection.</span><button type="button" class="btn btn-hivis" data-go="setup">Start inspection</button></div>';
      return;
    }
    box.innerHTML = out.inspections.length ? out.inspections.map(rowHtml).join('') + (out.total > out.inspections.length ? `<p class="muted">Showing ${out.inspections.length} of ${out.total}. Search to narrow down, or use the Console for the full list.</p>` : '')
      : '<div class="empty"><b>Nothing matches</b><span>Try another search or filter.</span></div>';
    wireRows(box);
  }
  $('#histSearch').addEventListener('input', (e) => { state.histQuery = e.target.value; clearTimeout(histTimer); histTimer = setTimeout(renderHistory, 350); });
  $$('#histFilters button').forEach((b) => b.addEventListener('click', () => { state.histFilter = b.dataset.f; renderHistory(); }));

  // ---------- SETTINGS ----------
  function renderSettings() {
    const p = state.profile;
    $('#pfName').value = p.name || ''; $('#pfRole').value = p.role || ''; $('#pfCompany').value = p.company || '';
    $('#pfEmpId').value = p.empId || ''; $('#pfPhone').value = p.phone || ''; $('#pfEmail').value = p.email || '';
    $('#pfSite').value = LS.get('pc_default_site', '');
    paintProfileBits();
    renderInstall();
    $('#setTypes').hidden = !can('template.manage');
    if (can('template.manage')) renderTypeList();
    renderServerInfo();
  }
  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/me', { name: $('#pfName').value.trim(), title: $('#pfRole').value.trim(), empId: $('#pfEmpId').value.trim(), phone: $('#pfPhone').value.trim() }, { method: 'PUT' });
      LS.set('pc_default_site', $('#pfSite').value);
      $('#sfSite').value = $('#pfSite').value;
      await loadServerInfo();
      if (!$('#sfInspector').value) $('#sfInspector').value = state.profile.name;
      toast('Profile saved');
    } catch (err) { toast(err.message, true); }
  });
  $('#chgPwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api('/api/me/password', { current: $('#cpOld').value, next: $('#cpNew').value });
      LS.set('pc_token', out.token); LS.set('pc_token_exp', out.expiresAt);
      $('#cpOld').value = ''; $('#cpNew').value = '';
      toast('Password changed. Other devices are signed out.');
    } catch (err) { toast(err.message, true); }
  });

  function renderServerInfo() {
    const me = state.me;
    const row = (k, v, cls = '') => `<div><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`;
    if (!me) { $('#accountBox').innerHTML = ''; $('#serverInfo').innerHTML = row('Server', 'Cannot reach the server', 'badv'); return; }
    $('#accountBox').innerHTML = `<div class="account-row">
        <span class="avatar">${esc(initials(me.user.name))}</span>
        <div><b>${esc(me.user.name)}</b><span>${esc(me.roleLabel)}, ${esc(me.tenant?.name || '')}</span></div>
        <button type="button" class="btn btn-line btn-sm" id="btnSignOut">Sign out</button>
      </div>
      ${can('console.open') ? '<a class="btn btn-ink btn-sm" href="/console">Open admin console</a>' : ''}`;
    $('#btnSignOut').addEventListener('click', signOut);
    const ai = me.ai || {};
    const lim = me.limits || {};
    $('#serverInfo').innerHTML =
      row('AI', ai.ready ? `${esc(ai.provider)} (${esc(ai.model)})${ai.verifyProvider && ai.verifyProvider !== ai.provider ? `, second check by ${esc(ai.verifyProvider)}` : ''}` : esc(ai.message || 'Not set up'), ai.ready ? 'okv' : 'badv')
      + (me.plan ? row('Plan', esc(me.plan.name) + (me.tenant?.status === 'trial' && me.tenant.trialEndsAt ? `, trial until ${new Date(me.tenant.trialEndsAt).toLocaleDateString()}` : '')) : '')
      + (me.usage ? row('This month', `${me.usage.inspections}${lim.max_inspections_month ? ' / ' + lim.max_inspections_month : ''} inspections, ${me.usage.aiCalls}${lim.max_ai_calls_month ? ' / ' + lim.max_ai_calls_month : ''} AI checks`) : '')
      + row('Version', `App ${APP_VERSION}, server ${esc(me.version || '')}`);
  }

  // ---------- inspection types: list in Settings ----------
  function renderTypeList() {
    $('#typeList').innerHTML = state.types.map((t) => `
      <button type="button" class="row" data-edit-type="${esc(t.id)}">
        ${typeIcon(t)}
        <span class="row-main"><span class="row-title">${esc(t.name)} ${t.libraryKey ? '<span class="type-badge">Library</span>' : ''}</span>
          <span class="row-sub">${t.angles.length} views, ${countChecks(t)} checks${t.description ? ', ' + esc(t.description) : ''}</span></span>
        <svg class="row-chev" aria-hidden="true"><use href="#i-chev"/></svg>
      </button>`).join('') || '<div class="empty"><b>No inspection types</b><span>Create one or restore the built-in types.</span></div>';
    $$('#typeList [data-edit-type]').forEach((b) => b.addEventListener('click', () => openEditor(b.dataset.editType, 'settings')));
  }
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-new-type]');
    if (n) openEditor(null, n.dataset.newType === 'picker' ? 'picker' : 'settings');
  });

  // ---------- inspection type editor ----------
  function edViewRow(a = { name: '', guidance: '', parts: [] }, i = 0) {
    const div = document.createElement('div');
    div.className = 'ed-view';
    div.innerHTML = `
      <div class="ed-top">
        <span class="ed-num">${i + 1}</span>
        <input class="aname" placeholder="View name, e.g. Front" maxlength="60" value="${esc(a.name)}" aria-label="View name" />
        <button type="button" class="icon-btn ed-x" aria-label="Remove view"><svg><use href="#i-close"/></svg></button>
      </div>
      <input class="guide" placeholder="How to frame the photo, e.g. Whole front in frame" maxlength="200" value="${esc(a.guidance || '')}" aria-label="Photo guidance" />
      <textarea class="aparts" rows="${Math.max(3, a.parts.length + 1)}" aria-label="Checks for this view" placeholder="One check per line, e.g.&#10;Nameplate&#10;! Earthing wire :: connected and tightened">${esc(a.parts.join('\n'))}</textarea>`;
    $('.ed-x', div).addEventListener('click', () => { div.remove(); renumber(); });
    return div;
  }
  function renumber() { $$('#edViews .ed-num').forEach((n, i) => { n.textContent = i + 1; }); }
  function fillEditorViews(angles, general) {
    const box = $('#edViews');
    box.innerHTML = '';
    angles.forEach((a, i) => box.appendChild(edViewRow(a, i)));
    $('#edGeneral').value = (general || []).join('\n');
  }
  function openEditor(id, returnTo) {
    const t = id ? getType(id) : null;
    state.editor = { id: t ? t.id : null, returnTo };
    $('#edTitle').textContent = t ? `Edit: ${t.name}` : 'New inspection type';
    $('#edName').value = t?.name || '';
    $('#edDesc').value = t?.description || '';
    $('#edIdLabel').value = t?.idLabel || '';
    $('#edSafety').checked = Boolean(t?.safety);
    fillEditorViews(t ? t.angles : [{ name: 'Front', guidance: '', parts: [] }, { name: 'Back', guidance: '', parts: [] }, { name: 'Left side', guidance: '', parts: [] }, { name: 'Right side', guidance: '', parts: [] }], t?.general_parts || []);
    $('#edDelete').hidden = !t;
    show('editor');
    if (!t) setTimeout(() => $('#edName').focus(), 50);
  }
  function readEditor() {
    const name = $('#edName').value.trim();
    const angles = $$('#edViews .ed-view').map((row) => ({
      name: $('.aname', row).value.trim(), guidance: $('.guide', row).value.trim(), parts: splitLines($('.aparts', row).value),
    })).filter((a) => a.name);
    const names = angles.map((a) => a.name.toLowerCase());
    if (!name) { $('#edName').focus(); throw new Error('Enter a name for this inspection type.'); }
    if (!angles.length) throw new Error('Add at least one view.');
    if (new Set(names).size !== names.length) throw new Error('Each view needs a different name.');
    const general = splitLines($('#edGeneral').value);
    if (!angles.some((a) => a.parts.length) && !general.length) throw new Error('Add at least one check.');
    return { name, description: $('#edDesc').value.trim(), idLabel: $('#edIdLabel').value.trim(), safety: $('#edSafety').checked, angles, general_parts: general };
  }
  function leaveEditor(savedId) {
    const back = state.editor?.returnTo;
    state.editor = null;
    if (back === 'picker' && savedId) { state.selTypeId = savedId; LS.set('pc_last_type', savedId); resetSetupForm(); show('details'); return; }
    if (back === 'details') { show(getType(state.selTypeId) ? 'details' : 'setup'); return; }
    if (back === 'picker') { show('setup'); return; }
    show('settings');
    setTimeout(() => $('#setTypes')?.scrollIntoView({ behavior: 'smooth' }), 60);
  }
  $('#edAddView').addEventListener('click', () => { const r = edViewRow(undefined, $$('#edViews .ed-view').length); $('#edViews').appendChild(r); $('.aname', r).focus(); });
  $('#edSave').addEventListener('click', async () => {
    let data;
    try { data = readEditor(); } catch (e) { toast(e.message, true); return; }
    let id = state.editor?.id;
    const body = { ...data, angles: data.angles.map((a) => ({ name: a.name, guidance: a.guidance, parts: a.parts })) };
    loading(true, 'Saving…');
    try {
      const out = id ? await api('/api/templates/' + id, body, { method: 'PUT' }) : await api('/api/templates', body);
      id = out.template.id;
      const i = state.types.findIndex((t) => t.id === id);
      if (i >= 0) state.types[i] = out.template; else state.types.push(out.template);
      saveTypes();
      toast('Inspection type saved');
      leaveEditor(id);
    } catch (e) { toast(e.message, true); }
    finally { loading(false); }
  });
  $('#edCancel').addEventListener('click', () => leaveEditor(null));
  $('#edDelete').addEventListener('click', async () => {
    const t = getType(state.editor?.id);
    if (!t || !confirm(`Delete the inspection type "${t.name}"? Saved inspections are kept.`)) return;
    try { const out = await api('/api/templates/' + t.id, null, { method: 'DELETE' }); if (out.message) toast(out.message); } catch (e) { toast(e.message, true); return; }
    state.types = state.types.filter((x) => x.id !== t.id);
    if (state.selTypeId === t.id) { state.selTypeId = ''; LS.set('pc_last_type', ''); }
    saveTypes();
    toast('Inspection type deleted');
    if (state.editor.returnTo === 'details') state.editor.returnTo = 'picker';
    leaveEditor(null);
  });
  $('#btnSuggest').addEventListener('click', async () => {
    const item = $('#edName').value.trim();
    if (!item) { toast('Type the name first, e.g. "Forklift".', true); $('#edName').focus(); return; }
    const hasChecks = $$('#edViews .aparts').some((t) => t.value.trim());
    if (hasChecks && !confirm('Replace the current views and checks with AI suggestions?')) return;
    loading(true, 'AI is building a checklist…');
    try {
      const out = await api('/api/ai/suggest', { item, description: $('#edDesc').value.trim(), industry: state.me?.tenant?.industries?.[0] || '' });
      fillEditorViews(out.angles, out.general_parts);
      toast('Checklist suggested. Review it, then save.');
    } catch (e) { toast(e.message, true); }
    finally { loading(false); }
  });

  // ---------- INSTALL APP (PWA) ----------
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canOfferInstall = () => !isStandalone() && (Boolean(state.installEvt) || isIOS());

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvt = e;
    if (state.view === 'home') renderHome();
    if (state.view === 'settings') renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    state.installEvt = null;
    toast('App installed. Open it from your home screen.');
    renderInstall();
    $('#homeInstall').hidden = true;
  });
  function renderInstall() {
    const btn = $('#installBtn');
    const steps = $('#installSteps');
    steps.hidden = true;
    if (isStandalone()) {
      $('#installText').innerHTML = '<span class="installed-badge">✓ Installed</span> You are using the app version.';
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    if (state.installEvt) {
      $('#installText').textContent = 'Install Inspection AI on this device. It opens full screen from your home screen and starts faster.';
      btn.disabled = false;
    } else if (isIOS()) {
      $('#installText').textContent = 'On iPhone and iPad, add the app from Safari:';
      btn.hidden = true;
      steps.hidden = false;
      steps.innerHTML = '<ol><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>';
    } else {
      $('#installText').textContent = 'Your browser can install this app from its menu:';
      btn.hidden = true;
      steps.hidden = false;
      steps.innerHTML = '<ol><li><b>Android (Chrome):</b> tap ⋮ menu, then <b>Install app</b> or <b>Add to Home screen</b>.</li><li><b>Computer (Chrome / Edge):</b> click the install icon in the address bar, or menu, then <b>Install Inspection AI</b>.</li></ol>';
    }
  }
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-install]')) return;
    if (state.installEvt) {
      state.installEvt.prompt();
      const choice = await state.installEvt.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') toast('Installing…');
      state.installEvt = null;
      renderInstall();
      $('#homeInstall').hidden = true;
    } else {
      show('settings');
      setTimeout(() => $('#setInstall').scrollIntoView({ behavior: 'smooth' }), 60);
    }
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // ---------- leave warning ----------
  window.addEventListener('beforeunload', (e) => {
    if (state.cur && Object.keys(state.cur.shots || {}).length && !state.cur.saved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- bridge for live.js ----------
  window.PartCheck = {
    state, $, $$, esc, toast, loading, show, api, analyze, watermark, newRecord, renderResult, evaluate, createFlash, LS, checkLabel, splitCheck,
    resetSetupForm, selectType, can,
  };

  // ---------- boot: check the login before showing anything ----------
  localStorage.removeItem('pc_pw');
  paintProfileBits();
  (async () => {
    const token = LS.get('pc_token', '');
    if (!token) { signOutLocal(); showLogin(); return; } // the server decides whether the token is still valid
    try {
      state.me = await api('/api/me');
    } catch (e) {
      if (e.status === 401 || e.status === 403) return; // api() already showed the sign-in screen
      if (state.types.length) { unlock(); toast('You are offline. AI checks and saving need internet.', true); }
      else showLogin('No internet. Connect to sign in.');
      return;
    }
    if (state.me.platformRole && !state.me.support) { location.href = '/console'; return; }
    if (state.me.user.mustChangePassword) { showPwChange(''); return; }
    await loadSites(); applyMe();
    unlock();
    loadTemplates().then(handleDeepLink);
  })();
  // QR label opens  /?asset=CODE  -> start that asset's inspection straight away
  async function handleDeepLink() {
    const code = new URLSearchParams(location.search).get('asset');
    if (!code) return;
    history.replaceState({ view: state.view }, '', location.pathname + location.hash);
    try {
      const { asset } = await api('/api/assets/lookup?code=' + encodeURIComponent(code));
      if (asset?.templateId && getType(asset.templateId)) startDue({ templateId: asset.templateId, assetCode: asset.code, siteId: asset.siteId, location: asset.location });
      else { show('setup'); $('#sfId').value = code; toast(`Asset ${code}: choose what to inspect.`); }
    } catch (e) { toast(e.message, true); }
  }
})();
