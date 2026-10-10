// End-to-end API test. Start the server with AI_MOCK=1 first, then: node tests/smoke.mjs http://localhost:3999
const BASE = process.argv[2] || 'http://localhost:3000';
const OWNER = { email: process.env.OWNER_EMAIL || 'owner@test.com', password: process.env.OWNER_PASSWORD || 'Owner12345' };
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
async function call(method, path, { token, body, tenant } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['X-Tenant-Id'] = tenant;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, data };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data;
const img = 'data:image/jpeg;base64,' + Buffer.from('fakeimagebytes'.repeat(20)).toString('base64');

const owner = await login(OWNER.email, OWNER.password);
ok(owner.token && owner.platform, 'owner login');
const ov = await call('GET', '/api/platform/overview', { token: owner.token });
ok(ov.status === 200, 'platform overview');

const t1 = await call('POST', '/api/platform/tenants', { token: owner.token, body: { name: 'Acme Steel', adminEmail: 'admin@acme.test', adminName: 'Asha', industries: ['construction', 'fire_safety'], planId: 'trial', status: 'trial', siteName: 'Pune plant' } });
ok(t1.status === 200 && t1.data.adminPassword, 'create tenant A');
const t2 = await call('POST', '/api/platform/tenants', { token: owner.token, body: { name: 'Beta Foods', adminEmail: 'admin@beta.test', industries: ['hospitality_retail'], planId: 'starter', status: 'active' } });
ok(t2.status === 200, 'create tenant B');

const a = await login('admin@acme.test', t1.data.adminPassword);
ok(a.token && a.user.mustChangePassword, 'tenant A admin login (must change password)');
const pw = await call('POST', '/api/me/password', { token: a.token, body: { current: t1.data.adminPassword, next: 'AcmeAdmin123' } });
ok(pw.status === 200 && pw.data.token, 'change password returns new token');
const old = await call('GET', '/api/me', { token: a.token });
ok(old.status === 401, 'old token revoked after password change');
const A = pw.data.token;
const me = await call('GET', '/api/me', { token: A });
ok(me.status === 200 && me.data.tenant.name === 'Acme Steel' && me.data.ai.ready, 'me + AI ready (demo AI)');

const tpls = await call('GET', '/api/templates', { token: A });
ok(tpls.data.templates.length >= 6, `templates seeded from industries (${tpls.data.templates.length})`);
const ext = tpls.data.templates.find((t) => /extinguisher/i.test(t.name));
const sites = await call('GET', '/api/sites', { token: A });
ok(sites.data.sites.length === 1, 'site created with tenant');

const insp = await call('POST', '/api/users', { token: A, body: { email: 'ravi@acme.test', name: 'Ravi', role: 'inspector' } });
ok(insp.status === 200 && insp.data.tempPassword, 'create inspector user');
const ravi = await login('ravi@acme.test', insp.data.tempPassword);

const ev = await call('POST', '/api/ai/evaluate', { token: ravi.token, body: { item: ext.name, templateId: ext.id, description: ext.description, general_parts: ext.general_parts, angles: ext.angles.map((x) => ({ ...x, image: img })) } });
ok(ev.status === 200 && ev.data.checklist?.length && ev.data.secondCheck, `evaluate (mock): ${ev.data.status} ${ev.data.completion}%`);

const save = await call('POST', '/api/inspections', { token: ravi.token, body: {
  templateId: ext.id, templateName: ext.name, mode: 'photo', safety: true, assetCode: 'FE-101', siteId: sites.data.sites[0].id, location: 'Gate 2',
  inspectorName: 'Ravi', angles: ext.angles, general_parts: ext.general_parts, result: ev.data, override: { status: '', remarks: '' }, signoff: { done: true },
  photos: ext.angles.map((x) => ({ view: x.name, dataUrl: img })), meta: { notes: 'test' } } });
ok(save.status === 200 && save.data.id, `save inspection: tag ${save.data.finalTag}, actions ${save.data.actionsCreated}`);
const got = await call('GET', `/api/inspections/${save.data.id}`, { token: ravi.token });
ok(got.status === 200 && got.data.inspection.photos.length === ext.angles.length, 'open saved inspection with photos');
const asset = await call('GET', '/api/assets/lookup?code=fe-101', { token: ravi.token });
ok(asset.data.asset?.code === 'FE-101' && asset.data.asset.nextDueAt, 'asset auto-created with next due date');

const denied = await call('POST', '/api/users', { token: ravi.token, body: { email: 'x@acme.test', role: 'inspector' } });
ok(denied.status === 403, 'inspector cannot create users');

const B = (await login('admin@beta.test', t2.data.adminPassword)).token;
const cross = await call('GET', `/api/inspections/${save.data.id}`, { token: B });
ok(cross.status === 404, 'tenant B cannot read tenant A inspection');
const crossList = await call('GET', '/api/inspections', { token: B });
ok(crossList.data.total === 0, 'tenant B list is empty');
const noai = await call('GET', '/api/me', { token: B });
ok(noai.data.ai.ready === true, 'tenant B (starter, no key) falls back to demo AI only because AI_MOCK=1');

const list = await call('GET', '/api/inspections?tag=' + save.data.finalTag, { token: A });
ok(list.data.total === 1, 'admin sees inspection in list');
const dash = await call('GET', '/api/dashboard', { token: A });
ok(dash.status === 200 && dash.data.totals.inspections === 1, 'dashboard');
const man = await call('POST', '/api/actions', { token: A, body: { title: 'Replace pressure gauge', inspectionId: save.data.id, severity: 'high' } });
ok(man.status === 200, 'manual corrective action');
const acts = await call('GET', '/api/actions?status=open', { token: A });
ok(acts.status === 200, `actions list (${acts.data.actions.length})`);
if (acts.data.actions[0]) {
  const people = await call('GET', '/api/people', { token: A });
  const r1 = await call('PUT', `/api/actions/${acts.data.actions[0].id}`, { token: A, body: { assigneeId: people.data.people.find((p) => p.name === 'Ravi').id } });
  ok(r1.status === 200, 'assign action');
  const r2 = await call('PUT', `/api/actions/${acts.data.actions[0].id}`, { token: ravi.token, body: { status: 'done', closureNote: 'Fixed', closurePhoto: img } });
  ok(r2.status === 200, 'assignee closes action');
  const r3 = await call('PUT', `/api/actions/${acts.data.actions[0].id}`, { token: ravi.token, body: { status: 'verified' } });
  const after = await call('GET', `/api/actions?status=done`, { token: A });
  ok(r3.status === 200 && after.data.actions.some((x) => x.id === acts.data.actions[0].id), 'inspector cannot verify (status stays done)');
}
const rev = await call('POST', `/api/inspections/${save.data.id}/review`, { token: A, body: { decision: 'approved', comment: 'ok' } });
ok(rev.status === 200, 'manager approves');
const edit = await call('PUT', `/api/inspections/${save.data.id}`, { token: ravi.token, body: { override: { status: 'PASS' } } });
ok(edit.status === 403, 'inspector cannot edit approved inspection');
const csv = await call('GET', '/api/export/inspections.csv', { token: A });
ok(csv.status === 200 && String(csv.data).includes('FE-101'), 'CSV export');

const sch = await call('POST', '/api/schedules', { token: A, body: { templateId: tpls.data.templates[0].id, frequencyDays: 7, siteId: sites.data.sites[0].id, title: 'Weekly scaffold check' } });
ok(sch.status === 200, 'create schedule');
const due = await call('GET', '/api/due', { token: ravi.token });
ok(due.status === 200 && due.data.items.length >= 1, `due list (${due.data.items.length})`);

const lib = await call('GET', '/api/library', { token: A });
const wh = lib.data.industries.find((i) => i.key === 'warehouse');
const imp = await call('POST', '/api/library/import', { token: A, body: { ids: wh.templates.map((t) => t.id) } });
ok(imp.data.imported === wh.templates.length, 'import library templates');

const key = await call('POST', '/api/ai-keys', { token: A, body: { provider: 'gemini', apiKey: 'AIzaFAKEKEY1234567890', model: 'gemini-flash-latest', test: false } });
ok(key.status === 200 && key.data.key.hint && !JSON.stringify(key.data).includes('FAKEKEY1234567890'), 'add AI key (stored encrypted, only hint returned)');
const keys = await call('GET', '/api/ai-keys', { token: A });
ok(keys.data.keys.length === 1 && keys.data.status.provider === 'gemini', 'own key becomes the active provider');

const sup = await call('GET', '/api/inspections', { token: owner.token, tenant: t1.data.tenantId });
ok(sup.status === 200 && sup.data.total === 1, 'super admin support access to tenant');
const susp = await call('PUT', `/api/platform/tenants/${t1.data.tenantId}`, { token: owner.token, body: { status: 'suspended' } });
const blocked = await call('GET', '/api/me', { token: A });
ok(susp.status === 200 && blocked.status === 401, 'suspending tenant signs users out');
const relog = await call('POST', '/api/auth/login', { body: { email: 'admin@acme.test', password: 'AcmeAdmin123' } });
ok(relog.status === 403, 'suspended tenant cannot log in');
await call('PUT', `/api/platform/tenants/${t1.data.tenantId}`, { token: owner.token, body: { status: 'active' } });

const ind = await call('POST', '/api/platform/library/industries', { token: owner.token, body: { name: 'Solar energy' } });
ok(ind.status === 200 && ind.data.key === 'solar_energy', 'platform adds a new industry');
const lt = await call('POST', '/api/platform/library/templates', { token: owner.token, body: { industry: 'solar_energy', name: 'Solar panel array', safety: false, angles: [{ name: 'Panels', guidance: 'Wide view', parts: ['Panels clean :: no dust or bird droppings', '! Glass :: no cracked panels'] }] } });
ok(lt.status === 200, 'platform adds a library template to the new industry');
const A2 = (await login('admin@acme.test', 'AcmeAdmin123')).token;
const libA = await call('GET', '/api/library', { token: A2 });
ok(libA.data.industries.some((i) => i.key === 'solar_energy' && i.templates.length === 1), 'clients see the new industry in their library');
const exp = await call('GET', `/api/templates/${ext.id}/export`, { token: A2 });
const reimp = await call('POST', '/api/templates/import-json', { token: B, body: exp.data });
ok(exp.status === 200 && reimp.status === 200, 'template JSON export from A and import into B');
const prom = await call('POST', '/api/platform/library/promote', { token: owner.token, body: { templateId: ext.id, industry: 'solar_energy' } });
ok(prom.status === 200, 'platform promotes a client template into the library');
const demo = await call('POST', '/api/platform/demo', { token: owner.token });
ok(demo.status === 200 && demo.data.adminPassword, 'create demo tenant');
const audit = await call('GET', '/api/platform/audit', { token: owner.token });
ok(audit.data.entries.length > 10, `audit log (${audit.data.entries.length})`);
const bad = await call('POST', '/api/auth/login', { body: { email: 'admin@acme.test', password: 'wrong' } });
ok(bad.status === 401, 'wrong password rejected');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
