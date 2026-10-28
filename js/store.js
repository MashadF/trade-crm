/* Trade CRM v2: data layer. Two stores with the same async interface:
 *   DemoStore     - everything in this browser's localStorage (no account, no cloud)
 *   SupabaseStore - Supabase Auth + Postgres (RLS) + Storage, with a local read cache
 * Every cloud write carries business_id and every cloud query filters on it, on top of the RLS
 * policies in supabase/schema.sql (defence in depth). Only the public anon/publishable key is used.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CRMStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TABLES = ['customers', 'leads', 'jobs', 'documents', 'tasks', 'review_requests'];
  const COLUMNS = {
    businesses: ['name', 'accent', 'phone', 'email', 'postal_address', 'google_review_link', 'review_sms', 'review_email', 'review_followup', 'support_email', 'tax_rate', 'lead_form_enabled'],
    customers: ['name', 'phone', 'email', 'address', 'source', 'tags', 'notes', 'sms_ok', 'email_ok', 'consent_log', 'opted_out', 'opted_out_at', 'next_service_due', 'updated_at'],
    leads: ['name', 'phone', 'email', 'address', 'service', 'message', 'sms_ok', 'source', 'status', 'customer_id', 'contacted_at', 'updated_at'],
    jobs: ['customer_id', 'title', 'date', 'price', 'status', 'notes', 'photos', 'updated_at'],
    documents: ['customer_id', 'kind', 'number', 'status', 'items', 'tax_rate', 'deposit', 'pay_link', 'notes', 'due_date', 'sent_at', 'paid_at', 'accepted_name', 'accepted_at', 'accepted_via', 'from_quote_id', 'updated_at'],
    tasks: ['title', 'due', 'done', 'done_at', 'customer_id', 'auto_key'],
    review_requests: ['customer_id', 'channel', 'kind']
  };
  const ORDER = { customers: 'name', leads: 'created_at', jobs: 'date', documents: 'created_at', tasks: 'due', review_requests: 'created_at' };
  const pick = (table, obj) => { const o = {}; (COLUMNS[table] || []).forEach(k => { if (obj && obj[k] !== undefined) o[k] = obj[k]; }); return o; };
  const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const emptyState = () => ({ customers: [], leads: [], jobs: [], documents: [], tasks: [], review_requests: [] });
  const nowIso = () => new Date().toISOString();
  const memStorage = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };

  /* =========================== Demo (localStorage) =========================== */
  const DEMO_KEY = 'tradecrm.demo.v2';
  function DemoStore(opts) {
    opts = opts || {};
    const ls = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memStorage());
    const self = { mode: 'demo', user: { id: 'demo', email: 'demo (this browser only)' }, business: null, state: emptyState() };
    const save = () => ls.setItem(DEMO_KEY, JSON.stringify({ business: self.business, ...self.state }));
    function load() {
      let raw = null; try { raw = JSON.parse(ls.getItem(DEMO_KEY) || 'null'); } catch (e) { raw = null; }
      self.business = (raw && raw.business) || { id: 'demo', name: 'My Business', accent: '#2563eb', tax_rate: 0, lead_form_enabled: true };
      self.state = emptyState(); TABLES.forEach(t => { self.state[t] = (raw && Array.isArray(raw[t])) ? raw[t] : []; });
    }
    self.init = async () => { load(); return { user: self.user, business: self.business }; };
    self.reload = async () => { load(); return self.state; };
    self.loadAll = self.reload;
    self.updateBusiness = async patch => { Object.assign(self.business, pick('businesses', patch)); save(); return self.business; };
    self.insert = async (table, row) => {
      const r = Object.assign({ id: uuid(), business_id: 'demo', created_at: nowIso() }, row);
      if (table === 'documents' && !r.share_token) r.share_token = uuid();
      if (table === 'tasks' && r.auto_key && self.state.tasks.some(t => t.auto_key === r.auto_key)) return self.state.tasks.find(t => t.auto_key === r.auto_key);
      self.state[table].push(r); save(); return r;
    };
    self.update = async (table, id, patch) => {
      const r = self.state[table].find(x => x.id === id); if (!r) throw new Error('Not found');
      Object.assign(r, patch, COLUMNS[table].includes('updated_at') ? { updated_at: nowIso() } : {}); save(); return r;
    };
    self.remove = async (table, id) => {
      self.state[table] = self.state[table].filter(x => x.id !== id);
      if (table === 'customers') {   // mirror the database's cascade / set-null rules
        ['jobs', 'tasks', 'review_requests'].forEach(t => { self.state[t] = self.state[t].filter(x => x.customer_id !== id); });
        ['leads', 'documents'].forEach(t => self.state[t].forEach(x => { if (x.customer_id === id) x.customer_id = null; }));
      }
      save();
    };
    self.replaceAll = async (data) => {   // used by "load example data" and JSON restore
      if (data.business) self.business = Object.assign({ id: 'demo' }, data.business, { id: 'demo' });
      TABLES.forEach(t => { self.state[t] = Array.isArray(data[t]) ? data[t] : []; }); save();
    };
    // Demo photos are stored as small data: URLs inside the job row
    self.uploadPhoto = async (jobId, blob, dataUrl) => ({ path: dataUrl });
    self.photoUrl = async path => path;
    self.removePhoto = async () => {};
    self.exportAll = async () => ({ exported_at: nowIso(), app: 'Trade CRM v2', mode: 'demo', business: self.business, ...JSON.parse(JSON.stringify(self.state)) });
    self.deleteAllData = async () => { ls.removeItem(DEMO_KEY); load(); };
    self.findDocByToken = token => self.state.documents.find(d => d.share_token === token) || null;
    // auth calls are no-ops in demo mode
    self.signIn = self.signUp = self.resetPassword = async () => { throw new Error('Demo mode has no accounts. Add your Supabase details to config.js to turn on login.'); };
    self.signOut = async () => {};
    self.createBusiness = async (fields) => self.updateBusiness(fields);
    return self;
  }

  /* =========================== Supabase (cloud) =========================== */
  const BUCKET = 'job-photos';
  function SupabaseStore(client, opts) {
    opts = opts || {};
    const ls = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memStorage());
    const self = { mode: 'cloud', client, user: null, business: null, state: emptyState(), lastSync: null };
    const must = ({ data, error }) => { if (error) throw new Error(error.message || String(error)); return data; };
    const cacheKey = () => `tradecrm.cache.${self.user && self.user.id}`;
    const writeCache = () => { try { ls.setItem(cacheKey(), JSON.stringify({ at: self.lastSync, business: self.business, ...self.state })); } catch (e) { /* storage full: cache is optional */ } };
    const bid = () => { if (!self.business || !self.business.id) throw new Error('No business set up for this account yet.'); return self.business.id; };

    self.init = async () => {
      const { data } = await client.auth.getSession();
      self.user = data && data.session ? data.session.user : null;
      if (!self.user) return { user: null, business: null };
      // show cached data instantly, then refresh from the server
      try { const c = JSON.parse(ls.getItem(cacheKey()) || 'null'); if (c) { self.business = c.business; TABLES.forEach(t => { self.state[t] = c[t] || []; }); self.lastSync = c.at; } } catch (e) {}
      // No signal: keep the saved copy (this browser's localStorage, written after each sync) instead of
      // bouncing a signed-in user to the login screen. Saving still needs the network.
      try { await self.fetchBusiness(); self.offline = false; }
      catch (e) { if (!self.business) throw e; self.offline = true; }
      return { user: self.user, business: self.business };
    };
    self.fetchBusiness = async () => {
      const m = must(await client.from('members').select('business_id, role').eq('user_id', self.user.id).maybeSingle());
      if (!m) { self.business = null; return null; }
      self.business = must(await client.from('businesses').select('*').eq('id', m.business_id).single());
      self.role = m.role; return self.business;
    };
    self.signIn = async (email, password) => { const d = must(await client.auth.signInWithPassword({ email, password })); self.user = d.user; await self.fetchBusiness(); return self.user; };
    self.signUp = async (email, password, redirectTo) => {
      const d = must(await client.auth.signUp({ email, password, options: redirectTo ? { emailRedirectTo: redirectTo } : undefined }));
      self.user = d.session ? d.user : null;      // null = "check your email to confirm"
      return { user: d.user, needsConfirm: !d.session };
    };
    self.resetPassword = async (email, redirectTo) => must(await client.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined));
    self.updatePassword = async password => must(await client.auth.updateUser({ password }));
    self.signOut = async () => { try { ls.removeItem(cacheKey()); } catch (e) {} await client.auth.signOut(); self.user = null; self.business = null; self.state = emptyState(); };
    self.createBusiness = async fields => {
      const row = Object.assign(pick('businesses', fields), { owner_id: self.user.id });
      self.business = must(await client.from('businesses').insert(row).select().single());
      return self.business;
    };
    self.updateBusiness = async patch => {
      self.business = must(await client.from('businesses').update(pick('businesses', patch)).eq('id', bid()).select().single());
      writeCache(); return self.business;
    };
    self.loadAll = async () => {
      const b = bid();
      const results = await Promise.all(TABLES.map(t => client.from(t).select('*').eq('business_id', b).order(ORDER[t], { ascending: t === 'customers' || t === 'tasks' }).limit(5000)));
      results.forEach((r, i) => { self.state[TABLES[i]] = must(r) || []; });
      self.lastSync = nowIso(); self.offline = false; writeCache(); return self.state;
    };
    self.reload = self.loadAll;
    self.insert = async (table, row) => {
      const clean = Object.assign(pick(table, row), { business_id: bid() });
      if (table === 'tasks' && clean.auto_key) {
        const r = await client.from(table).upsert(clean, { onConflict: 'business_id,auto_key', ignoreDuplicates: true }).select();
        const rows = must(r) || []; if (rows[0]) { self.state[table].push(rows[0]); writeCache(); }
        return rows[0] || null;
      }
      const created = must(await client.from(table).insert(clean).select().single());
      self.state[table].push(created); writeCache(); return created;
    };
    self.update = async (table, id, patch) => {
      const clean = pick(table, patch); if (COLUMNS[table].includes('updated_at')) clean.updated_at = nowIso();
      const row = must(await client.from(table).update(clean).eq('id', id).eq('business_id', bid()).select().single());
      const i = self.state[table].findIndex(x => x.id === id); if (i >= 0) self.state[table][i] = row; writeCache(); return row;
    };
    self.remove = async (table, id) => {
      must(await client.from(table).delete().eq('id', id).eq('business_id', bid()));
      self.state[table] = self.state[table].filter(x => x.id !== id);
      if (table === 'customers') { await self.loadAll(); } else writeCache();
    };
    self.replaceAll = async (data) => {   // import from a JSON backup into this (empty or not) business: adds rows, new ids
      const idMap = {};
      for (const c of data.customers || []) { const n = await self.insert('customers', c); idMap[c.id] = n.id; }
      const remap = r => Object.assign({}, r, { customer_id: r.customer_id ? (idMap[r.customer_id] || null) : null });
      for (const t of ['leads', 'jobs', 'documents', 'tasks', 'review_requests'])
        for (const r of data[t] || []) { if ((t === 'jobs' || t === 'review_requests') && !idMap[r.customer_id]) continue; await self.insert(t, Object.assign(remap(r), t === 'jobs' ? { photos: [] } : {})); }
      await self.loadAll();
    };
    self.uploadPhoto = async (jobId, blob) => {
      const ext = (blob && blob.type === 'image/png') ? 'png' : 'jpg';
      const path = `${bid()}/${jobId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      must(await client.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false }));
      return { path };
    };
    const urlCache = {};
    self.photoUrl = async path => {
      if (!path) return '';
      if (urlCache[path] && urlCache[path].exp > Date.now()) return urlCache[path].url;
      const d = must(await client.storage.from(BUCKET).createSignedUrl(path, 3600));
      urlCache[path] = { url: d.signedUrl, exp: Date.now() + 3300 * 1000 }; return d.signedUrl;
    };
    self.removePhoto = async path => { must(await client.storage.from(BUCKET).remove([path])); };
    self.exportAll = async () => { await self.loadAll(); return { exported_at: nowIso(), app: 'Trade CRM v2', mode: 'cloud', account: self.user && self.user.email, business: self.business, ...JSON.parse(JSON.stringify(self.state)) }; };
    // Delete-my-data: photos first, then the business row (database cascades every table), then sign out.
    self.deleteAllData = async () => {
      const b = bid();
      const paths = [];
      self.state.jobs.forEach(j => (j.photos || []).forEach(p => p.path && paths.push(p.path)));
      for (let i = 0; i < paths.length; i += 100) must(await client.storage.from(BUCKET).remove(paths.slice(i, i + 100)));
      must(await client.from('businesses').delete().eq('id', b));
      try { ls.removeItem(cacheKey()); } catch (e) {}
      await self.signOut();
    };
    return self;
  }

  /* Public helpers used by lead-form.html and doc.html (anon key only) */
  async function submitPublicLead(client, lead) {
    // No .select(): the anon role may insert but can never read leads back.
    const { error } = await client.from('leads').insert(lead);
    if (error) throw new Error(error.message);
    return true;
  }
  async function getPublicDocument(client, token) {
    const { data, error } = await client.rpc('get_public_document', { p_token: token });
    if (error) throw new Error(error.message); return data;
  }
  async function acceptPublicQuote(client, token, name) {
    const { data, error } = await client.rpc('accept_quote', { p_token: token, p_name: name });
    if (error) throw new Error(error.message); return data;
  }

  function createStore(cfg, opts) {
    opts = opts || {};
    const L = opts.logic || (typeof CRMLogic !== 'undefined' ? CRMLogic : null);
    const check = L ? L.checkConfig(cfg) : { ok: true, mode: (cfg && cfg.SUPABASE_URL) ? 'cloud' : 'demo' };
    if (check.mode === 'cloud' && check.ok) {
      const lib = opts.supabase || (typeof supabase !== 'undefined' ? supabase : null);
      if (!lib) throw new Error('Supabase library failed to load (vendor/supabase.js).');
      const client = lib.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      return SupabaseStore(client, opts);
    }
    const s = DemoStore(opts); s.configError = check.ok ? '' : check.error; return s;
  }

  return { TABLES, COLUMNS, pick, uuid, DemoStore, SupabaseStore, createStore, submitPublicLead, getPublicDocument, acceptPublicQuote, DEMO_KEY, BUCKET };
});
