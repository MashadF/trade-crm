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
  const TABLES = ['customers', 'leads', 'jobs', 'documents', 'tasks', 'review_requests', 'emails', 'client_accounts', 'client_sites', 'client_enquiries', 'site_proposals'];
  const COLUMNS = {
    businesses: ['name', 'accent', 'phone', 'email', 'postal_address', 'google_review_link', 'review_sms', 'review_email', 'review_followup', 'support_email', 'tax_rate', 'lead_form_enabled', 'services'],
    customers: ['name', 'phone', 'email', 'address', 'source', 'tags', 'notes', 'sms_ok', 'email_ok', 'consent_log', 'opted_out', 'opted_out_at', 'next_service_due', 'updated_at'],
    leads: ['name', 'phone', 'email', 'address', 'service', 'message', 'sms_ok', 'source', 'status', 'customer_id', 'contacted_at', 'updated_at'],
    jobs: ['customer_id', 'title', 'date', 'price', 'status', 'notes', 'photos', 'updated_at'],
    documents: ['customer_id', 'kind', 'number', 'status', 'items', 'tax_rate', 'deposit', 'pay_link', 'notes', 'due_date', 'sent_at', 'paid_at', 'accepted_name', 'accepted_at', 'accepted_via', 'from_quote_id', 'updated_at'],
    tasks: ['title', 'due', 'done', 'done_at', 'customer_id', 'auto_key'],
    review_requests: ['customer_id', 'channel', 'kind'],
    emails: ['lead_id', 'customer_id', 'to_email', 'subject', 'body', 'template', 'source', 'status', 'sent_at', 'replied_at', 'updated_at'],
    client_accounts: ['client_business_id', 'client_key', 'name_key', 'lead_id', 'setup_status'],
    client_sites: ['public_token', 'origin_key', 'status', 'capture_enabled', 'approved_at', 'template', 'accent', 'business_name', 'trade', 'phone', 'email', 'service_area', 'about', 'services', 'workspace_note', 'updated_at'],
    client_enquiries: ['client_site_id', 'name', 'phone', 'email', 'service', 'message', 'sms_ok', 'source', 'status'],
    site_proposals: ['client_business_id', 'client_site_id', 'lead_id', 'client_key', 'to_email', 'email_confidence', 'email_note', 'subject', 'body', 'provenance', 'notes', 'status', 'sent_at', 'updated_at']
  };
  const ORDER = { customers: 'name', leads: 'created_at', jobs: 'date', documents: 'created_at', tasks: 'due', review_requests: 'created_at', emails: 'created_at', client_accounts: 'created_at', client_sites: 'created_at', client_enquiries: 'created_at', site_proposals: 'created_at' };
  const pick = (table, obj) => { const o = {}; (COLUMNS[table] || []).forEach(k => { if (obj && obj[k] !== undefined) o[k] = obj[k]; }); return o; };
  const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const emptyState = () => ({ customers: [], leads: [], jobs: [], documents: [], tasks: [], review_requests: [], emails: [], client_accounts: [], client_sites: [], client_enquiries: [], site_proposals: [] });
  const nowIso = () => new Date().toISOString();
  const memStorage = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };

  /* =========================== Demo (localStorage) =========================== */
  const DEMO_KEY = 'tradecrm.demo.v2';
  function ownBusiness(fields) {
    return Object.assign({ id: 'demo', name: 'My Business', accent: '#2563eb', tax_rate: 0, lead_form_enabled: true, workspace_kind: 'own', claim_status: 'claimed', role: 'owner' }, fields || {});
  }
  function DemoStore(opts) {
    opts = opts || {};
    const ls = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memStorage());
    const logic = () => opts.logic || (typeof CRMLogic !== 'undefined' ? CRMLogic : null);
    const self = { mode: 'demo', user: { id: 'demo', email: 'demo (this browser only)' }, business: null, businesses: [], workspaces: [], memberships: [], state: emptyState(), _all: emptyState() };
    const save = () => ls.setItem(DEMO_KEY, JSON.stringify(Object.assign({ active_id: self.business && self.business.id, businesses: self.businesses, business: self.business }, self._all)));
    function syncLists() {
      self.workspaces = self.businesses.map(b => Object.assign({}, b));
      self.memberships = self.businesses.map(b => ({ business_id: b.id, role: b.role || 'owner' }));
      self.role = (self.business && self.business.role) || 'owner';
    }
    function project() {
      const id = self.business && self.business.id;
      TABLES.forEach(t => { self.state[t] = (self._all[t] || []).filter(r => r.business_id === id); });
    }
    function load() {
      let raw = null; try { raw = JSON.parse(ls.getItem(DEMO_KEY) || 'null'); } catch (e) { raw = null; }
      if (raw && Array.isArray(raw.businesses) && raw.businesses.length) self.businesses = raw.businesses;
      else self.businesses = [ownBusiness(raw && raw.business)];
      self.businesses.forEach(b => { b.workspace_kind = b.workspace_kind || 'own'; b.claim_status = b.claim_status || 'claimed'; b.role = b.role || (b.workspace_kind === 'client' ? 'manager' : 'owner'); });
      self.business = self.businesses.find(b => raw && b.id === raw.active_id) || self.businesses.find(b => b.role === 'owner' && b.workspace_kind !== 'client') || self.businesses[0];
      self._all = emptyState();
      TABLES.forEach(t => { self._all[t] = (raw && Array.isArray(raw[t])) ? raw[t] : []; });
      syncLists(); project();
    }
    self.init = async () => { load(); return { user: self.user, business: self.business }; };
    self.reload = async () => { load(); return self.state; };
    self.loadAll = self.reload;
    self.updateBusiness = async patch => { Object.assign(self.business, pick('businesses', patch)); syncLists(); save(); return self.business; };
    self.insert = async (table, row) => {
      const target = (row && row.business_id && self.businesses.some(b => b.id === row.business_id)) ? row.business_id : (self.business && self.business.id);
      const r = Object.assign({ id: uuid(), created_at: nowIso() }, row, { business_id: target });
      if (table === 'documents' && !r.share_token) r.share_token = uuid();
      if (table === 'tasks' && r.auto_key && self._all.tasks.some(t => t.business_id === target && t.auto_key === r.auto_key)) return self._all.tasks.find(t => t.business_id === target && t.auto_key === r.auto_key);
      self._all[table].push(r); project(); save(); return r;
    };
    self.update = async (table, id, patch) => {
      const r = self._all[table].find(x => x.id === id); if (!r) throw new Error('Not found');
      const clean = Object.assign({}, patch); delete clean.business_id; delete clean.id;
      if (table === 'client_sites') {
        const L = logic(); if (!L || !L.applySitePatch) throw new Error('Could not check this site.');
        const next = L.applySitePatch(r, clean);
        Object.keys(r).forEach(k => delete r[k]); Object.assign(r, next);
      } else if (table === 'client_enquiries') {
        if (clean.status) r.status = clean.status;
      } else Object.assign(r, clean, COLUMNS[table] && COLUMNS[table].includes('updated_at') ? { updated_at: nowIso() } : {});
      project(); save(); return r;
    };
    self.remove = async (table, id) => {
      self._all[table] = self._all[table].filter(x => x.id !== id);
      if (table === 'customers') {
        ['jobs', 'tasks', 'review_requests', 'emails'].forEach(t => { self._all[t] = self._all[t].filter(x => x.customer_id !== id); });
        ['leads', 'documents'].forEach(t => self._all[t].forEach(x => { if (x.customer_id === id) x.customer_id = null; }));
      }
      if (table === 'leads') self._all.emails = self._all.emails.filter(x => x.lead_id !== id);
      project(); save();
    };
    self.replaceAll = async (data) => {
      const biz = ownBusiness(Object.assign({}, data.business || {}, { id: 'demo' }));
      self.businesses = [biz]; self.business = biz;
      self._all = emptyState();
      TABLES.forEach(t => { self._all[t] = (Array.isArray(data[t]) ? data[t] : []).map(r => Object.assign({}, r, { business_id: r.business_id || 'demo' })); });
      syncLists(); project(); save();
    };
    self.switchBusiness = async (id) => {
      const b = self.businesses.find(x => x.id === id); if (!b) throw new Error('That workspace is not on this login.');
      self.business = b; syncLists(); project(); save(); return b;
    };
    self.homeBusinessId = () => {
      const w = self.businesses.find(b => b.role === 'owner' && b.workspace_kind !== 'client');
      return w ? w.id : (self.business && self.business.id);
    };
    self.bootstrapClientPreview = async (input) => {
      const L = logic(); if (!L) throw new Error('Could not prepare this site.');
      input = input || {};
      const sales = self.businesses.find(b => b.id === input.salesBusinessId);
      if (!sales || sales.role !== 'owner' || sales.workspace_kind === 'client') throw new Error('Only the owner of your own account can open a client workspace.');
      const key = String(input.clientKey || '').trim();
      const name = String(input.name || '').trim();
      if (!/^[A-Za-z0-9:_-]{2,80}$/.test(key)) throw new Error('Missing a stable client key.');
      if (!name || name.length > 120) throw new Error('Enter the business name.');
      const nameKey = name.toLowerCase().replace(/\s+/g, ' ');
      let account = self._all.client_accounts.find(a => a.business_id === sales.id && (a.client_key === key || a.name_key === nameKey));
      const reusedWorkspace = !!account;
      let clientId = account && account.client_business_id;
      if (!account) {
        clientId = uuid();
        self.businesses.push({ id: clientId, name: name, accent: '#334155', tax_rate: 0, lead_form_enabled: false, workspace_kind: 'client', claim_status: 'invite_pending', role: 'manager', owner_id: null, example: !!sales.example });
        account = { id: uuid(), business_id: sales.id, client_business_id: clientId, client_key: key, name_key: nameKey, lead_id: input.leadId || null, setup_status: 'invite_pending', created_at: nowIso() };
        self._all.client_accounts.push(account);
      } else if (input.leadId && !account.lead_id) account.lead_id = input.leadId;
      let site = self._all.client_sites.find(s => s.business_id === clientId && s.origin_key === 'primary');
      const reusedSite = !!site;
      if (!site) {
        const content = L.cleanSiteContent(Object.assign({ business_name: name }, input.site || {}));
        site = Object.assign({ id: uuid(), business_id: clientId, public_token: uuid(), origin_key: 'primary', status: 'draft', capture_enabled: false, approved_at: null, workspace_note: '', created_at: nowIso(), updated_at: nowIso() }, content);
        self._all.client_sites.push(site);
      }
      let proposal = self._all.site_proposals.find(p => p.business_id === sales.id && p.client_key === key);
      const reusedProposal = !!proposal;
      if (!proposal) {
        proposal = Object.assign({ id: uuid(), business_id: sales.id, client_business_id: clientId, client_site_id: site.id, lead_id: input.leadId || null, client_key: key, status: 'draft', sent_at: null, created_at: nowIso(), updated_at: nowIso() }, L.cleanProposal(input.proposal || {}));
        self._all.site_proposals.push(proposal);
      } else if (!proposal.client_site_id) proposal.client_site_id = site.id;
      syncLists(); project(); save();
      return { client_business_id: clientId, site_id: site.id, public_token: site.public_token, reused_workspace: reusedWorkspace, reused_site: reusedSite, reused_proposal: reusedProposal };
    };
    self.listManagedSites = async () => {
      const ids = self.businesses.filter(b => b.role === 'manager').map(b => b.id);
      return self._all.client_sites.filter(s => ids.includes(s.business_id));
    };
    self.listManagedEnquiries = async () => {
      const ids = self.businesses.filter(b => b.role === 'manager').map(b => b.id);
      return self._all.client_enquiries.filter(e => ids.includes(e.business_id));
    };
    self.uploadPhoto = async (jobId, blob, dataUrl) => ({ path: dataUrl });
    self.photoUrl = async path => path;
    self.removePhoto = async () => {};
    self.exportAll = async () => ({ exported_at: nowIso(), app: 'Trade CRM v2', mode: 'demo', business: self.business, ...JSON.parse(JSON.stringify(self.state)) });
    self.deleteAllData = async () => { ls.removeItem(DEMO_KEY); load(); };
    self.findDocByToken = token => self._all.documents.find(d => d.share_token === token) || null;
    self.findCustomer = id => self._all.customers.find(c => c.id === id) || null;
    self.businessById = id => self.businesses.find(b => b.id === id) || null;
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
    const writeCache = () => { try { ls.setItem(cacheKey(), JSON.stringify({ at: self.lastSync, business: self.business, workspaces: self.workspaces || [], active_id: self.business && self.business.id, ...self.state })); } catch (e) { /* storage full: cache is optional */ } };
    const bid = () => { if (!self.business || !self.business.id) throw new Error('No business set up for this account yet.'); return self.business.id; };

    self.init = async () => {
      const { data } = await client.auth.getSession();
      self.user = data && data.session ? data.session.user : null;
      if (!self.user) return { user: null, business: null };
      // show cached data instantly, then refresh from the server
      try { const c = JSON.parse(ls.getItem(cacheKey()) || 'null'); if (c) { self.business = c.business; self.workspaces = c.workspaces || (c.business ? [c.business] : []); TABLES.forEach(t => { self.state[t] = c[t] || []; }); self.lastSync = c.at; if (c.active_id) self.activeBusinessId = c.active_id; } } catch (e) {}
      // No signal: keep the saved copy (this browser's localStorage, written after each sync) instead of
      // bouncing a signed-in user to the login screen. Saving still needs the network.
      try { await self.fetchBusiness(); self.offline = false; }
      catch (e) { if (!self.business) throw e; self.offline = true; }
      return { user: self.user, business: self.business };
    };
    self.fetchBusiness = async () => {
      const raw = must(await client.from('members').select('business_id, role').eq('user_id', self.user.id));
      const rows = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      self.memberships = rows;
      if (!rows.length) { self.business = null; self.role = null; self.workspaces = []; return null; }
      if (!self.activeBusinessId) { try { self.activeBusinessId = ls.getItem('tradecrm.activeBusiness.' + self.user.id); } catch (e) {} }
      self.workspaces = [];
      for (const m of rows) {
        const b = must(await client.from('businesses').select('*').eq('id', m.business_id).single());
        self.workspaces.push(Object.assign({}, b, { role: m.role }));
      }
      let pick = self.workspaces.find(w => w.id === self.activeBusinessId);
      if (!pick) pick = self.workspaces.find(w => w.role === 'owner' && (w.workspace_kind || 'own') !== 'client') || self.workspaces[0];
      self.activeBusinessId = pick.id;
      self.business = pick;
      self.role = pick.role;
      try { ls.setItem('tradecrm.activeBusiness.' + self.user.id, pick.id); } catch (e) {}
      return self.business;
    };
    self.homeBusinessId = () => {
      const w = (self.workspaces || []).find(x => x.role === 'owner' && (x.workspace_kind || 'own') !== 'client');
      return w ? w.id : (self.business && self.business.id);
    };
    self.switchBusiness = async (id) => {
      if (!(self.memberships || []).some(m => m.business_id === id)) throw new Error('That workspace is not on this login.');
      self.activeBusinessId = id;
      try { ls.setItem('tradecrm.activeBusiness.' + self.user.id, id); } catch (e) {}
      await self.fetchBusiness();
      await self.loadAll();
      return self.business;
    };
    self.bootstrapClientPreview = async (input) => {
      input = input || {};
      const data = must(await client.rpc('bootstrap_client_preview', {
        p_sales_business_id: input.salesBusinessId,
        p_client_key: input.clientKey,
        p_name: input.name,
        p_lead_id: input.leadId || null,
        p_site: input.site || {},
        p_proposal: input.proposal || {}
      }));
      if (!data || !data.client_business_id) throw new Error('That did not go through.');
      await self.fetchBusiness();
      return data;
    };
    async function rowsFor(table, ids, cols) {
      const out = [];
      for (const id of ids) {
        const raw = must(await client.from(table).select(cols).eq('business_id', id));
        (Array.isArray(raw) ? raw : (raw ? [raw] : [])).forEach(r => out.push(r));
      }
      return out;
    }
    self.listManagedSites = async () => rowsFor('client_sites', (self.memberships || []).filter(m => m.role === 'manager').map(m => m.business_id), 'id, business_id, business_name, status, capture_enabled, approved_at, public_token, template, created_at, updated_at');
    self.listManagedEnquiries = async () => rowsFor('client_enquiries', (self.memberships || []).filter(m => m.role === 'manager').map(m => m.business_id), 'id, business_id, client_site_id, status, source, created_at');
    self.signIn = async (email, password) => { const d = must(await client.auth.signInWithPassword({ email, password })); self.user = d.user; await self.fetchBusiness(); return self.user; };
    self.signUp = async (email, password, redirectTo) => {
      const d = must(await client.auth.signUp({ email, password, options: redirectTo ? { emailRedirectTo: redirectTo } : undefined }));
      self.user = d.session ? d.user : null;      // null = "check your email to confirm"
      return { user: d.user, needsConfirm: !d.session };
    };
    self.resetPassword = async (email, redirectTo) => must(await client.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined));
    self.updatePassword = async password => must(await client.auth.updateUser({ password }));
    self.signOut = async () => { try { ls.removeItem(cacheKey()); } catch (e) {} await client.auth.signOut(); self.user = null; self.business = null; self.workspaces = []; self.memberships = []; self.state = emptyState(); };
    self.createBusiness = async fields => {
      const row = Object.assign(pick('businesses', fields), { owner_id: self.user.id });
      self.business = must(await client.from('businesses').insert(row).select().single());
      self.business.role = 'owner';
      self.role = 'owner';
      self.workspaces = [Object.assign({ role: 'owner', workspace_kind: 'own', claim_status: 'claimed' }, self.business)];
      self.memberships = [{ business_id: self.business.id, role: 'owner' }];
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
      if (table === 'leads') self.state.emails = self.state.emails.filter(x => x.lead_id !== id);   // database cascades these
      if (table === 'customers') { await self.loadAll(); } else writeCache();
    };
    self.replaceAll = async (data) => {   // import from a JSON backup into this (empty or not) business: adds rows, new ids
      const idMap = {};
      for (const c of data.customers || []) { const n = await self.insert('customers', c); idMap[c.id] = n.id; }
      const remap = r => Object.assign({}, r, { customer_id: r.customer_id ? (idMap[r.customer_id] || null) : null });
      const leadMap = {};
      for (const t of ['leads', 'jobs', 'documents', 'tasks', 'review_requests'])
        for (const r of data[t] || []) { if ((t === 'jobs' || t === 'review_requests') && !idMap[r.customer_id]) continue; const n = await self.insert(t, Object.assign(remap(r), t === 'jobs' ? { photos: [] } : {})); if (t === 'leads' && n) leadMap[r.id] = n.id; }
      for (const r of data.emails || []) {   // email log: keep only rows whose lead or customer came across
        const e = Object.assign(remap(r), { lead_id: r.lead_id ? (leadMap[r.lead_id] || null) : null });
        if (!e.lead_id && !e.customer_id) continue;
        await self.insert('emails', e);
      }
      // saved services come back too, but never overwrite a list that is already there
      const sv = data.business && Array.isArray(data.business.services) ? data.business.services : [];
      if (sv.length && !((self.business && self.business.services) || []).length) { try { await self.updateBusiness({ services: sv }); } catch (e) { console.warn('services not restored', e); } }
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
  async function getPublicSite(client, token) {
    const { data, error } = await client.rpc('get_public_site', { p_token: token });
    if (error) throw new Error(error.message);
    return data || null;
  }
  async function submitSiteEnquiry(client, args) {
    const { data, error } = await client.rpc('submit_site_enquiry', args || {});
    if (error) throw new Error(error.message || 'That did not go through.');
    if (!data) throw new Error('That did not go through.');
    return data;
  }
  function previewLogic() {
    if (typeof CRMLogic !== 'undefined') return CRMLogic;
    if (typeof require === 'function') { try { return require('./logic.js'); } catch (e) { return null; } }
    return null;
  }
  function readDemoRaw(storage) {
    try { return JSON.parse((storage || localStorage).getItem(DEMO_KEY) || 'null'); } catch (e) { return null; }
  }
  function readDemoPublicSite(token, storage) {
    const L = previewLogic();
    const raw = readDemoRaw(storage); if (!raw || !L) return null;
    const site = (raw.client_sites || []).find(s => s.public_token === token);
    return site ? L.publicSitePayload(site) : null;
  }
  async function submitDemoEnquiry(token, form, storage) {
    const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const L = previewLogic();
    if (!ls || !L) throw new Error('This preview link is not active.');
    const raw = readDemoRaw(ls); if (!raw) throw new Error('This preview link is not active.');
    const site = (raw.client_sites || []).find(s => s.public_token === token);
    const gate = L.enquiryOpen(site); if (!gate.ok) throw new Error(gate.error);
    const cleaned = L.cleanEnquiry(form || {}); if (!cleaned.ok) throw new Error(cleaned.error);
    const list = raw.client_enquiries || [];
    const recent = list.filter(e => e.client_site_id === site.id && (Date.now() - new Date(e.created_at).getTime()) < 3600000);
    if (recent.length >= 10) throw new Error('Too many requests. Please try again later.');
    const row = { id: uuid(), business_id: site.business_id, client_site_id: site.id, status: 'new', created_at: nowIso(), name: cleaned.enquiry.name, phone: cleaned.enquiry.phone || '', email: cleaned.enquiry.email || '', service: cleaned.enquiry.service || '', message: cleaned.enquiry.message || '', sms_ok: !!cleaned.enquiry.sms_ok, source: cleaned.enquiry.source || 'Website form' };
    list.push(row); raw.client_enquiries = list;
    ls.setItem(DEMO_KEY, JSON.stringify(raw));
    const saved = readDemoRaw(ls);
    if (!saved || !(saved.client_enquiries || []).some(e => e.id === row.id)) throw new Error('That did not go through.');
    return row.id;
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

  return { TABLES, COLUMNS, pick, uuid, DemoStore, SupabaseStore, createStore, submitPublicLead, getPublicDocument, acceptPublicQuote, getPublicSite, submitSiteEnquiry, readDemoPublicSite, submitDemoEnquiry, DEMO_KEY, BUCKET };
});
