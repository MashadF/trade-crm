/* Trade CRM v2: UI. Plain JS, no build step. Data goes through window.CRMStore (demo or Supabase). */
(function () {
  'use strict';
  const L = window.CRMLogic, ST = window.CRMStore, CFG = window.CRM_CONFIG || {};
  const h = L.esc, money = L.money;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const view = $('#view');
  const ACCENTS = ['#2563eb', '#0891b2', '#16a34a', '#65a30d', '#d97706', '#ea580c', '#dc2626', '#db2777', '#7c3aed', '#334155'];
  const SOURCES = ['Website form', 'Google', 'Google Business Profile', 'Referral', 'Repeat customer', 'Facebook', 'Nextdoor', 'Yard sign / truck', 'Thumbtack / Angi', 'Other'];
  const params = new URLSearchParams(location.search);
  let store = null, S = null, B = null;   // store, state, business
  let leadFilter = 'open', moneyTab = 'quote', custQuery = '';

  /* ---------------- helpers ---------------- */
  const todayISO = () => L.isoDate(new Date());
  const custById = id => S.customers.find(c => c.id === id);
  const custName = id => (custById(id) || {}).name || '';
  const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const fmtDate = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const fmtDateTime = d => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const ago = d => { const m = Math.floor((Date.now() - new Date(d)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' hr ago' : Math.floor(m / 1440) + ' d ago'; };
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }
  function dueChip(due) {
    if (!due) return '';
    const t = todayISO(); const cls = due < t ? 'over' : due === t ? 'today' : '';
    return `<span class="due ${cls}">${due < t ? 'Overdue · ' : due === t ? 'Today' : ''}${due === t ? '' : fmtDate(due)}</span>`;
  }
  const statusChip = s => `<span class="chip st-${h(s)}">${h({ quote: 'Quote sent', new: 'New', contacted: 'Contacted', won: 'Won', lost: 'Lost', draft: 'Draft', sent: 'Sent', accepted: 'Accepted', paid: 'Paid', scheduled: 'Scheduled', done: 'Done', canceled: 'Canceled' }[s] || s)}</span>`;
  /* Lead message -> DOM (display only; the stored text is never changed). Built with textContent and only
     http(s) links from L.linkParts / L.parseLeadNote, so nothing in a message can inject HTML or script. */
  function linkInto(el, parts) {
    parts.forEach(p => {
      if (p.href && L.safeHttpUrl(p.href)) { const a = document.createElement('a'); a.href = L.safeHttpUrl(p.href); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'note-link'; a.textContent = p.text; el.appendChild(a); }
      else el.appendChild(document.createTextNode(p.text));
    });
    return el;
  }
  function noteNode(text, compact) {
    const n = L.parseLeadNote(text), box = document.createElement('div');
    if (!n) { box.className = 'note-plain'; linkInto(box, compact ? [{ text: '“' }].concat(L.linkParts(text), [{ text: '”' }]) : L.linkParts(text)); return box; }
    box.className = 'note' + (compact ? ' compact' : '');
    n.rows.forEach(r => {
      const row = document.createElement('div'); row.className = 'note-row' + (/^(Notes|Outreach)$/.test(r.label) ? ' note-long' : '');
      const lab = document.createElement('span'); lab.className = 'note-label'; lab.textContent = r.label + ': ';
      const val = document.createElement('span'); val.className = 'note-val'; linkInto(val, r.parts);
      row.append(lab, val); box.appendChild(row);
    });
    return box;
  }
  function fillNotes(root) {
    $$('[data-note]', root).forEach(el => { const l = S.leads.find(x => x.id === el.dataset.note); el.replaceChildren(noteNode((l && l.message) || '', el.hasAttribute('data-compact'))); });
  }
  async function guard(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { console.error(e); toast('Could not save: ' + (e.message || e), 5000); throw e; } }
  function download(name, text, type = 'text/csv') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const supportEmail = () => (B && B.support_email) || CFG.SUPPORT_EMAIL || '';
  const docLink = d => new URL('doc.html?t=' + encodeURIComponent(d.share_token), location.href).href;
  const leadFormLink = () => new URL('lead-form.html?b=' + encodeURIComponent(B.id), location.href).href;

  /* ---------------- modal ---------------- */
  function openModal(title, html, onMount) {
    $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').hidden = false;
    const f = $('#modalBody input:not([type=hidden]), #modalBody textarea, #modalBody select'); if (f && window.innerWidth > 640) f.focus();
    if (onMount) onMount($('#modalBody'));
  }
  const closeModal = () => { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; };
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  const fieldVal = (form, name) => { const el = form.elements[name]; if (!el) return undefined; return el.type === 'checkbox' ? el.checked : el.value.trim(); };

  /* ---------------- branding / chrome ---------------- */
  function applyBrand() {
    const name = (B && B.name) || 'Trade CRM';
    document.documentElement.style.setProperty('--accent', (B && B.accent) || '#2563eb');
    $('meta[name=theme-color]').content = (B && B.accent) || '#2563eb';
    const appTitle = (B && B.name && !B.example && B.name !== 'My Business') ? B.name.slice(0, 30) : (CFG.APP_NAME || 'Trade CRM');
    $$('meta[name=apple-mobile-web-app-title],meta[name=application-name]').forEach(m => m.content = appTitle);
    $('#brandName').textContent = name; $('#brandLogo').textContent = initials(name).slice(0, 2) || 'T';
    document.title = name + ' · CRM';
    $('#exampleBadge').hidden = !(B && B.example);
    const pill = $('#modePill');
    if (store && store.mode === 'demo') { pill.hidden = false; pill.className = 'mode-pill demo'; pill.textContent = 'Demo mode · saved in this browser only'; pill.title = 'Add Supabase details to config.js to turn on login and cloud sync.'; }
    else if (store && store.user && store.offline) { pill.hidden = false; pill.className = 'mode-pill demo'; pill.textContent = 'Offline · saved copy'; pill.title = 'No connection. You can look things up; saving needs signal.'; }
    else if (store && store.user) { pill.hidden = false; pill.className = 'mode-pill cloud'; pill.textContent = 'Synced' + (store.lastSync ? ' ' + new Date(store.lastSync).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''); pill.title = 'Signed in as ' + store.user.email; }
    else pill.hidden = true;
    const sl = $('#supportLink'), se = supportEmail();
    sl.hidden = !se; if (se) sl.href = L.mailtoLink(se, `Help with ${name} CRM`, `Hi,\n\nI need help with:\n\n\n--\nBusiness: ${name}\nAccount: ${(store && store.user && store.user.email) || 'demo'}\nPage: ${location.hash}`);
    const newLeads = S ? S.leads.filter(l => l.status === 'new').length : 0;
    $('#leadCount').hidden = !newLeads; $('#leadCount').textContent = newLeads;
  }
  function setChrome(loggedIn) { document.body.classList.toggle('auth-mode', !loggedIn); }

  /* ---------------- auth screens ---------------- */
  function renderLogin(mode = 'signin', note = '') {
    setChrome(false);
    const preview = store.mode === 'demo';
    const titles = { signin: 'Sign in', signup: 'Create your account', forgot: 'Reset your password' };
    view.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <div class="auth-logo"><span class="logo">${h(initials(CFG.APP_NAME || 'Trade CRM'))}</span><div><div class="brand-name">${h(CFG.APP_NAME || 'Trade CRM')}</div><div class="muted small">Leads, customers, quotes and invoices in one place</div></div></div>
      ${preview ? `<div class="notice warn small">Preview only. Login turns on once your Supabase URL and anon key are in <code>config.js</code>. <a href="./">Back to the demo</a></div>` : ''}
      ${note ? `<div class="notice small">${h(note)}</div>` : ''}
      <h1>${titles[mode]}</h1>
      <form id="authForm" class="mt">
        <div class="field"><label for="em">Email</label><input class="input" id="em" name="email" type="email" autocomplete="email" required placeholder="you@yourbusiness.com"></div>
        ${mode !== 'forgot' ? `<div class="field"><label for="pw">Password</label><input class="input" id="pw" name="password" type="password" minlength="8" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required placeholder="At least 8 characters"></div>` : ''}
        <div class="auth-err" id="authErr" hidden></div>
        <button class="btn primary block" type="submit">${mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Email me a reset link'}</button>
      </form>
      <div class="auth-links">
        ${mode === 'signin' ? `<a href="#" data-auth="forgot">Forgot password?</a><a href="#" data-auth="signup">New here? Create an account</a>` : `<a href="#" data-auth="signin">Back to sign in</a>`}
      </div>
      <p class="muted small center">One account = one business. Your data is private to your business.${supportEmail() ? ` Need help? <a href="mailto:${h(supportEmail())}">Contact support</a>` : ''}</p>
    </div></div>`;
    $$('[data-auth]').forEach(a => a.onclick = e => { e.preventDefault(); renderLogin(a.dataset.auth); });
    $('#authForm').onsubmit = async e => {
      e.preventDefault(); const f = e.target, err = $('#authErr'); err.hidden = true;
      if (preview) { err.hidden = false; err.textContent = 'This is a preview. Add Supabase details to config.js to enable login.'; return; }
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        const email = fieldVal(f, 'email'), pw = fieldVal(f, 'password');
        if (mode === 'signin') { await store.signIn(email, pw); await afterLogin(); }
        else if (mode === 'signup') { const r = await store.signUp(email, pw, location.href.split('#')[0]); if (r.needsConfirm) renderLogin('signin', 'Check your email and click the confirmation link, then sign in.'); else await afterLogin(); }
        else { await store.resetPassword(email, location.href.split('#')[0]); renderLogin('signin', 'If that email has an account, a reset link is on its way.'); }
      } catch (ex) { err.hidden = false; err.textContent = ex.message || String(ex); btn.disabled = false; }
    };
  }
  function renderSetup() {
    setChrome(false);
    view.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <h1>Name your business</h1><p class="muted">This shows on your quotes, invoices and website form. You can change it later.</p>
      <form id="setupForm">
        <div class="field"><label>Business name</label><input class="input" name="name" required maxlength="120" placeholder="e.g. Peachtree Pressure Washing"></div>
        <div class="field"><label>Business phone</label><input class="input" name="phone" type="tel" maxlength="40"></div>
        <div class="field"><label>Color</label><div class="swatches">${ACCENTS.map((c, i) => `<label class="swatch-l"><input type="radio" name="accent" value="${c}" ${i === 0 ? 'checked' : ''}><span class="swatch" style="background:${c}"></span></label>`).join('')}</div></div>
        <div class="auth-err" id="authErr" hidden></div>
        <button class="btn primary block">Start</button>
      </form>
      <p class="center small"><a href="#" id="signOutLink">Sign out</a></p></div></div>`;
    $('#signOutLink').onclick = async e => { e.preventDefault(); await store.signOut(); renderLogin(); };
    $('#setupForm').onsubmit = async e => {
      e.preventDefault(); const f = e.target;
      try { await store.createBusiness({ name: fieldVal(f, 'name'), phone: fieldVal(f, 'phone'), accent: f.elements.accent.value, review_sms: L.DEFAULT_TEMPLATES.review_sms, review_email: L.DEFAULT_TEMPLATES.review_email, review_followup: L.DEFAULT_TEMPLATES.review_followup }); await afterLogin(); }
      catch (ex) { $('#authErr').hidden = false; $('#authErr').textContent = ex.message; }
    };
  }
  async function afterLogin() {
    if (!store.business) return renderSetup();
    B = store.business; S = store.state;
    try { await store.loadAll(); } catch (e) { store.offline = true; toast(navigator.onLine === false ? 'You\'re offline. Showing your saved copy; saving needs signal.' : 'Showing saved copy. Could not reach the server: ' + e.message, 5000); }
    setChrome(true); await syncAutoTasks(); applyBrand();
    if (!location.hash || location.hash === '#/') location.hash = '#/today'; else route();
  }

  /* ---------------- automatic reminder tasks ---------------- */
  async function syncAutoTasks() {
    try {
      for (const t of L.generateAutoTasks(S, new Date())) await store.insert('tasks', t);
      for (const t of L.obsoleteAutoTasks(S)) await store.update('tasks', t.id, { done: true, done_at: new Date().toISOString() });
    } catch (e) { console.warn('auto tasks', e); }
  }

  /* ---------------- router ---------------- */
  async function route() {
    if (store && store.business && store.state) { S = store.state; B = store.business; }
    if (!S) return;
    const parts = (location.hash.replace(/^#\/?/, '') || 'today').split('/');
    const [page, id] = parts;
    $$('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === ({ customer: 'customers', doc: 'money' }[page] || page)));
    const r = { today: renderToday, leads: renderLeads, customers: renderCustomers, customer: () => renderCustomer(id), money: renderMoney, doc: () => renderDoc(id), settings: renderSettings }[page] || renderToday;
    applyBrand(); await r(); window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  const rerender = () => route();

  /* ---------------- TODAY ---------------- */
  function leadRow(l) {
    const age = L.leadAge(l);
    return `<div class="lead-row" data-lead="${h(l.id)}">
      <div class="li-main"><div class="li-title">${h(l.name)} ${age.level !== 'none' ? `<span class="age age-${age.level}">${h(age.label)}</span>` : ''}</div>
      <div class="li-sub">${h(l.service || L.leadNoteSummary(l.message || ''))}${l.source ? ' · ' + h(l.source) : ''}</div></div>
      <div class="row nowrap">${l.phone ? `<a class="btn sm" href="${h(L.telLink(l.phone))}" data-contact="${h(l.id)}">Call</a><a class="btn sm" href="${h(L.smsLink(l.phone, `Hi ${L.firstName(l.name)}, this is ${B.name}. Thanks for reaching out about ${l.service || 'your project'}!`))}" data-contact="${h(l.id)}">Text</a>` : ''}${!l.phone && l.email ? `<a class="btn sm" href="${h(L.mailtoLink(l.email, 'Your request to ' + B.name, `Hi ${L.firstName(l.name)},\n\nThanks for reaching out to ${B.name}.`))}" data-contact="${h(l.id)}">Email</a>` : ''}</div>
    </div>`;
  }
  function taskRow(t) {
    return `<div class="task ${t.done ? 'done' : ''}"><button class="check ${t.done ? 'on' : ''}" data-task="${h(t.id)}" aria-label="Mark done">${t.done ? '✓' : ''}</button>
      <div class="li-main"><div class="li-title">${h(t.title)}</div><div class="li-sub">${t.auto_key ? '<span class="auto">Auto reminder</span> ' : ''}${t.customer_id ? `<a href="#/customer/${h(t.customer_id)}">${h(custName(t.customer_id))}</a>` : ''}</div></div>${dueChip(t.due)}</div>`;
  }
  function bindCommon(root) {
    $$('[data-task]', root).forEach(b => b.onclick = async () => { const t = S.tasks.find(x => x.id === b.dataset.task); await guard(() => store.update('tasks', t.id, { done: !t.done, done_at: t.done ? null : new Date().toISOString() })); rerender(); });
    $$('[data-contact]', root).forEach(a => a.addEventListener('click', () => markContacted(a.dataset.contact)));
    $$('[data-lead]', root).forEach(el => el.addEventListener('click', e => { if (e.target.closest('a,button,select')) return; openLead(el.dataset.lead); }));
  }
  async function markContacted(id) {
    const l = S.leads.find(x => x.id === id); if (!l || l.contacted_at) return;
    await guard(() => store.update('leads', id, { contacted_at: new Date().toISOString(), status: l.status === 'new' ? 'contacted' : l.status }));
    setTimeout(rerender, 300);
  }
  function renderToday() {
    const st = L.stats(S), t = todayISO();
    const fresh = S.leads.filter(l => l.status === 'new').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const tasks = S.tasks.filter(x => !x.done && (!x.due || x.due <= L.isoDate(L.addDays(new Date(), 2)))).sort((a, b) => (a.due || '9') < (b.due || '9') ? -1 : 1);
    const jobsToday = S.jobs.filter(j => j.date === t && j.status !== 'canceled');
    const upcoming = S.jobs.filter(j => j.date > t && j.date <= L.isoDate(L.addDays(new Date(), 7)) && j.status === 'scheduled').sort((a, b) => a.date < b.date ? -1 : 1);
    const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
    view.innerHTML = `
      ${B.example ? `<div class="notice warn">You're looking at <b>example data</b> for a made-up business. Clear it in <a href="#/settings">Settings</a> before adding real customers.</div>` : ''}
      <div class="page-head"><div><h1>${hello}</h1><div class="muted">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
        <div class="row"><button class="btn" id="addLead">+ Lead</button><button class="btn" id="addTask">+ Task</button><a class="btn primary" href="#/doc/new-quote">+ Quote</a></div></div>
      <div class="stats">
        <a class="card stat accent" href="#/leads"><div class="label">New leads this week</div><div class="value">${st.newLeadsWeek}</div><div class="hint">${st.untouchedLeads ? st.untouchedLeads + ' waiting for a reply' : 'All answered'}</div></a>
        <a class="card stat" href="#/money"><div class="label">Money owed</div><div class="value">${money(st.moneyOwed)}</div><div class="hint">Unpaid invoices</div></a>
        <a class="card stat" href="#/money"><div class="label">Quotes won (30 days)</div><div class="value">${st.quotesWon30} of ${st.quotesSent30}</div><div class="hint">${money(st.quotesWonValue30)} won</div></a>
        <div class="card stat"><div class="label">Jobs today</div><div class="value">${jobsToday.length}</div><div class="hint">${upcoming.length} more this week</div></div>
      </div>
      <div class="grid2">
        <div class="card"><div class="card-head"><h2>New leads</h2><a href="#/leads" class="small">Lead inbox →</a></div>
          ${fresh.length ? fresh.slice(0, 6).map(leadRow).join('') : '<div class="empty">No new leads. 🎉</div>'}</div>
        <div class="card"><div class="card-head"><h2>Tasks due</h2><span class="muted small">${tasks.length} open</span></div>
          ${tasks.length ? tasks.slice(0, 8).map(taskRow).join('') : '<div class="empty">Nothing due. Reminders for open quotes, unpaid invoices and service visits show up here automatically.</div>'}</div>
        <div class="card span2"><div class="card-head"><h2>Jobs today</h2><a href="#/customers" class="small">Customers →</a></div>
          ${jobsToday.length ? jobsToday.map(jobLine).join('') : '<div class="empty small">No jobs scheduled today.</div>'}
          ${upcoming.length ? `<div class="section-label">Coming up</div>${upcoming.slice(0, 5).map(jobLine).join('')}` : ''}</div>
      </div>`;
    $('#addLead').onclick = () => editLead(); $('#addTask').onclick = () => editTask();
    bindCommon(view);
  }
  function jobLine(j) {
    const c = custById(j.customer_id) || {};
    return `<a class="list-item" href="#/customer/${h(j.customer_id)}"><div class="avatar">${h(initials(c.name))}</div>
      <div class="li-main"><div class="li-title">${h(j.title)} <span class="muted">· ${h(c.name || '')}</span></div><div class="li-sub">${h(c.address || '')}</div></div>
      <div class="right"><div class="strong">${j.price ? money(j.price) : ''}</div><div class="small muted">${fmtDate(j.date)}</div></div></a>`;
  }

  /* ---------------- LEADS ---------------- */
  function renderLeads() {
    const counts = {}; L.LEAD_STATUSES.forEach(s => { counts[s.id] = S.leads.filter(l => l.status === s.id).length; });
    const open = S.leads.filter(l => ['new', 'contacted', 'quote'].includes(l.status));
    const list = (leadFilter === 'open' ? open : S.leads.filter(l => l.status === leadFilter)).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    view.innerHTML = `
      <div class="page-head"><div><h1>Leads</h1><div class="muted small">Answer within 15 minutes. Most customers hire whoever calls back first.</div></div>
        <div class="row"><button class="btn" id="formLink">Website form link</button><button class="btn primary" id="addLead">+ Add lead</button></div></div>
      <div class="seg wrap" id="seg">
        <button data-f="open" class="${leadFilter === 'open' ? 'on' : ''}">Open <b>${open.length}</b></button>
        ${L.LEAD_STATUSES.map(s => `<button data-f="${s.id}" class="${leadFilter === s.id ? 'on' : ''}">${s.name} <b>${counts[s.id]}</b></button>`).join('')}
      </div>
      <div class="card mt">${list.length ? list.map(l => {
        const age = L.leadAge(l);
        return `<div class="lead" data-lead="${h(l.id)}">
          <div class="lead-top"><div class="li-main"><div class="li-title">${h(l.name)} ${age.level !== 'none' ? `<span class="age age-${age.level}">${h(age.label)}</span>` : ''}</div>
            <div class="li-sub">${h([l.service, l.address].filter(Boolean).join(' · '))}</div></div>
            <div class="right small muted">${ago(l.created_at)}<br>${h(l.source || '')}</div></div>
          ${l.message ? `<div class="lead-msg" data-note="${h(l.id)}" data-compact></div>` : ''}
          <div class="row mt-s">
            ${l.phone ? `<a class="btn sm" href="${h(L.telLink(l.phone))}" data-contact="${h(l.id)}">📞 Call</a><a class="btn sm" href="${h(L.smsLink(l.phone, `Hi ${L.firstName(l.name)}, this is ${B.name}. Thanks for reaching out about ${l.service || 'your project'}!`))}" data-contact="${h(l.id)}">💬 Text</a>` : ''}
            ${l.email ? `<a class="btn sm" href="${h(L.mailtoLink(l.email, 'Your request to ' + B.name, `Hi ${L.firstName(l.name)},\n\nThanks for reaching out to ${B.name}.\n`))}" data-contact="${h(l.id)}">✉️ Email</a>` : ''}
            <select class="input sm-select" data-status="${h(l.id)}" aria-label="Status">${L.LEAD_STATUSES.map(s => `<option value="${s.id}" ${l.status === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
            ${l.customer_id ? `<a class="btn sm" href="#/customer/${h(l.customer_id)}">Customer card →</a>` : `<button class="btn sm" data-convert="${h(l.id)}">Make customer</button>`}
            <button class="btn sm" data-quote="${h(l.id)}">Quote</button>
            ${l.sms_ok ? '<span class="chip ok-chip" title="Ticked “OK to text me” on the form">Text OK</span>' : ''}
          </div></div>`;
      }).join('') : `<div class="empty">No leads here.${leadFilter === 'open' ? ' Share your website form link to start collecting them.' : ''}</div>`}</div>`;
    fillNotes(view);
    $$('#seg button').forEach(b => b.onclick = () => { leadFilter = b.dataset.f; renderLeads(); });
    $('#addLead').onclick = () => editLead(); $('#formLink').onclick = showFormLink;
    $$('[data-status]').forEach(s => s.onchange = async () => { await guard(() => store.update('leads', s.dataset.status, { status: s.value, contacted_at: S.leads.find(x => x.id === s.dataset.status).contacted_at || (s.value !== 'new' ? new Date().toISOString() : null) }), 'Lead updated'); renderLeads(); });
    $$('[data-convert]').forEach(b => b.onclick = async () => { const c = await convertLead(b.dataset.convert); location.hash = '#/customer/' + c.id; });
    $$('[data-quote]').forEach(b => b.onclick = async () => { const l = S.leads.find(x => x.id === b.dataset.quote); const c = l.customer_id ? custById(l.customer_id) : await convertLead(l.id); location.hash = '#/doc/new-quote?c=' + c.id + '&lead=' + l.id; });
    bindCommon(view);
  }
  async function convertLead(id) {
    const l = S.leads.find(x => x.id === id);
    const existing = S.customers.find(c => (l.phone && L.smsLink(c.phone) === L.smsLink(l.phone)) || (l.email && c.email && c.email.toLowerCase() === l.email.toLowerCase()));
    const c = existing || await guard(() => store.insert('customers', { name: l.name, phone: l.phone || '', email: l.email || '', address: l.address || '', source: l.source || 'Website form',
      notes: [l.service, l.message].filter(Boolean).join(': '), sms_ok: !!l.sms_ok, consent_log: l.sms_ok ? `${fmtDateTime(l.created_at)}: ticked "OK to text me" on website form` : '', tags: [] }), 'Customer created');
    await guard(() => store.update('leads', id, { customer_id: c.id, status: l.status === 'new' ? 'contacted' : l.status, contacted_at: l.contacted_at || new Date().toISOString() }));
    return c;
  }
  function openLead(id) {
    const l = S.leads.find(x => x.id === id); if (!l) return;
    openModal(l.name, `<dl class="kv"><dt>Status</dt><dd>${statusChip(l.status)}</dd><dt>Phone</dt><dd>${h(l.phone || '—')}</dd><dt>Email</dt><dd>${h(l.email || '—')}</dd><dt>Address</dt><dd>${h(l.address || '—')}</dd>
      <dt>Service</dt><dd>${h(l.service || '—')}</dd><dt>${(() => { const n = L.parseLeadNote(l.message); return n ? 'Notes from ' + n.from : 'Message'; })()}</dt><dd>${l.message ? `<div class="lead-msg detail" data-note="${h(l.id)}"></div>` : '—'}</dd><dt>Source</dt><dd>${h(l.source || '—')}</dd><dt>Received</dt><dd>${fmtDateTime(l.created_at)}</dd>
      <dt>Text OK?</dt><dd>${l.sms_ok ? 'Yes, ticked on form' : 'Not given'}</dd></dl>
      <div class="modal-actions"><button class="btn danger" id="delLead">Delete</button><button class="btn" id="editL">Edit</button>${l.customer_id ? `<a class="btn primary" href="#/customer/${h(l.customer_id)}" data-close>Customer card</a>` : '<button class="btn primary" id="convL">Make customer</button>'}</div>`, m => {
      fillNotes(m);
      $('#delLead', m).onclick = async () => { if (confirm('Delete this lead?')) { await guard(() => store.remove('leads', id), 'Deleted'); closeModal(); rerender(); } };
      $('#editL', m).onclick = () => editLead(l);
      const cv = $('#convL', m); if (cv) cv.onclick = async () => { const c = await convertLead(id); closeModal(); location.hash = '#/customer/' + c.id; };
    });
  }
  function editLead(l) {
    l = l || {};
    openModal(l.id ? 'Edit lead' : 'Add a lead', `<form id="f">
      <div class="field"><label>Name *</label><input class="input" name="name" required maxlength="200" value="${h(l.name || '')}"></div>
      <div class="grid-2f"><div class="field"><label>Phone</label><input class="input" name="phone" type="tel" value="${h(l.phone || '')}"></div>
      <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${h(l.email || '')}"></div></div>
      <div class="field"><label>Address</label><input class="input" name="address" value="${h(l.address || '')}"></div>
      <div class="grid-2f"><div class="field"><label>Service wanted</label><input class="input" name="service" value="${h(l.service || '')}"></div>
      <div class="field"><label>Source</label><select class="input" name="source">${SOURCES.map(s => `<option ${s === (l.source || 'Phone call') ? 'selected' : ''}>${s}</option>`).join('')}<option ${(l.source || 'Phone call') === 'Phone call' ? 'selected' : ''}>Phone call</option></select></div></div>
      <div class="field"><label>Notes</label><textarea class="input" name="message">${h(l.message || '')}</textarea></div>
      <label class="checkline"><input type="checkbox" name="sms_ok" ${l.sms_ok ? 'checked' : ''}> They said it's OK to text them</label>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`, m => {
      $('#f', m).onsubmit = async e => {
        e.preventDefault(); const f = e.target; const row = {}; ['name', 'phone', 'email', 'address', 'service', 'source', 'message', 'sms_ok'].forEach(k => { row[k] = fieldVal(f, k); });
        if (l.id) await guard(() => store.update('leads', l.id, row), 'Saved'); else await guard(() => store.insert('leads', Object.assign(row, { status: 'new' })), 'Lead added');
        closeModal(); rerender();
      };
    });
  }
  function showFormLink() {
    const url = leadFormLink();
    openModal('Your website lead form', `<p class="muted small">Put this form on your website. Every request lands in your Lead inbox with a "no reply yet" timer. Spam bots are filtered by a hidden trap field.</p>
      <div class="field"><label>Link (button or Google Business Profile)</label><input class="input" readonly value="${h(url)}"></div>
      <div class="field"><label>Embed code (paste into your website)</label><textarea class="input code" readonly rows="3">${h(`<iframe src="${url}" title="Request a quote" style="width:100%;max-width:520px;height:640px;border:0"></iframe>`)}</textarea></div>
      ${store.mode === 'demo' ? '<div class="notice warn small">Demo mode: the form only works in this same browser. Real website leads need cloud sync (Supabase) turned on.</div>' : ''}
      <div class="modal-actions"><a class="btn" href="${h(url)}" target="_blank" rel="noopener">Open form</a><button class="btn primary" id="cp">Copy link</button></div>`, m => {
      $('#cp', m).onclick = () => { navigator.clipboard && navigator.clipboard.writeText(url); toast('Link copied'); };
    });
  }
  function editTask(t, customerId) {
    t = t || {};
    openModal(t.id ? 'Edit task' : 'Add a task', `<form id="f"><div class="field"><label>What needs doing?</label><input class="input" name="title" required maxlength="300" value="${h(t.title || '')}"></div>
      <div class="grid-2f"><div class="field"><label>Due</label><input class="input" type="date" name="due" value="${h(t.due || todayISO())}"></div>
      <div class="field"><label>Customer</label><select class="input" name="customer_id"><option value="">None</option>${S.customers.map(c => `<option value="${h(c.id)}" ${c.id === (t.customer_id || customerId) ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></div></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`, m => {
      $('#f', m).onsubmit = async e => { e.preventDefault(); const f = e.target; const row = { title: fieldVal(f, 'title'), due: fieldVal(f, 'due') || null, customer_id: fieldVal(f, 'customer_id') || null, done: false };
        if (t.id) await guard(() => store.update('tasks', t.id, row)); else await guard(() => store.insert('tasks', row), 'Task added'); closeModal(); rerender(); };
    });
  }

  /* ---------------- CUSTOMERS ---------------- */
  function quickLinks(c, small) {
    const cls = small ? 'btn sm' : 'btn';
    return `${c.phone ? `<a class="${cls}" href="${h(L.telLink(c.phone))}">📞 Call</a><a class="${cls}" href="${h(L.smsLink(c.phone, ''))}">💬 Text</a>` : ''}
      ${c.address ? `<a class="${cls}" href="${h(L.mapLink(c.address))}" target="_blank" rel="noopener">📍 Map</a>` : ''}
      ${c.email ? `<a class="${cls}" href="${h(L.mailtoLink(c.email, '', ''))}">✉️ Email</a>` : ''}`;
  }
  function renderCustomers() {
    const q = custQuery.toLowerCase();
    const list = S.customers.filter(c => !q || [c.name, c.phone, c.email, c.address, c.source, (c.tags || []).join(' ')].join(' ').toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    view.innerHTML = `
      <div class="page-head"><div><h1>Customers</h1><div class="muted small">${S.customers.length} customer${S.customers.length === 1 ? "" : "s"}</div></div>
        <div class="row"><div class="search"><input class="input" id="q" placeholder="Search name, phone, street, tag…" value="${h(custQuery)}"></div><button class="btn primary" id="addC">+ Customer</button></div></div>
      <div class="cust-grid">${list.length ? list.map(c => {
        const jobs = S.jobs.filter(j => j.customer_id === c.id), last = jobs.sort((a, b) => a.date < b.date ? 1 : -1)[0];
        return `<div class="card cust-card" data-c="${h(c.id)}">
          <div class="row nowrap"><div class="avatar">${h(initials(c.name))}</div><div class="li-main"><div class="li-title">${h(c.name)}</div><div class="li-sub">${h(c.address || c.phone || c.email || '')}</div></div></div>
          <div class="tags">${c.source ? `<span class="tag src">${h(c.source)}</span>` : ''}${(c.tags || []).map(t => `<span class="tag">${h(t)}</span>`).join('')}${c.opted_out ? '<span class="tag stop">Opted out</span>' : ''}${c.next_service_due ? `<span class="tag svc">Service due ${fmtDate(c.next_service_due)}</span>` : ''}</div>
          <div class="small muted mt-s">${jobs.length} job${jobs.length === 1 ? '' : 's'}${last ? ` · last ${fmtDate(last.date)}: ${h(last.title)}` : ''}</div>
          <div class="quick">${quickLinks(c, true)}</div></div>`;
      }).join('') : `<div class="card empty">${S.customers.length ? 'No match.' : 'No customers yet. Add one, convert a lead, or import a CSV in Settings.'}</div>`}</div>`;
    const qi = $('#q'); qi.oninput = () => { custQuery = qi.value; const pos = qi.selectionStart; renderCustomers(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
    $('#addC').onclick = () => editCustomer();
    $$('[data-c]').forEach(el => el.onclick = e => { if (e.target.closest('a,button')) return; location.hash = '#/customer/' + el.dataset.c; });
  }
  function editCustomer(c) {
    c = c || {};
    openModal(c.id ? 'Edit customer' : 'New customer', `<form id="f">
      <div class="field"><label>Name *</label><input class="input" name="name" required maxlength="200" value="${h(c.name || '')}"></div>
      <div class="grid-2f"><div class="field"><label>Mobile phone</label><input class="input" name="phone" type="tel" value="${h(c.phone || '')}"></div>
      <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${h(c.email || '')}"></div></div>
      <div class="field"><label>Service address</label><input class="input" name="address" value="${h(c.address || '')}"></div>
      <div class="grid-2f"><div class="field"><label>Lead source (how they found you)</label><select class="input" name="source"><option value="">—</option>${SOURCES.concat(['Phone call']).map(s => `<option ${s === c.source ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Next service due</label><input class="input" type="date" name="next_service_due" value="${h(c.next_service_due || '')}"></div></div>
      <div class="field"><label>Tags (comma separated)</label><input class="input" name="tags" value="${h((c.tags || []).join(', '))}" placeholder="gate code, dog, repeat"></div>
      <div class="field"><label>Notes</label><textarea class="input" name="notes">${h(c.notes || '')}</textarea></div>
      <div class="modal-actions">${c.id ? '<button type="button" class="btn danger" id="del">Delete</button>' : ''}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`, m => {
      $('#f', m).onsubmit = async e => {
        e.preventDefault(); const f = e.target; const row = {};
        ['name', 'phone', 'email', 'address', 'source', 'notes'].forEach(k => { row[k] = fieldVal(f, k); });
        row.next_service_due = fieldVal(f, 'next_service_due') || null; row.tags = fieldVal(f, 'tags').split(',').map(s => s.trim()).filter(Boolean);
        let saved;
        if (c.id) saved = await guard(() => store.update('customers', c.id, row), 'Saved'); else saved = await guard(() => store.insert('customers', Object.assign(row, { sms_ok: false, email_ok: false, opted_out: false })), 'Customer added');
        await syncAutoTasks(); closeModal(); if (!c.id) location.hash = '#/customer/' + saved.id; else rerender();
      };
      const d = $('#del', m); if (d) d.onclick = async () => { if (confirm(`Delete ${c.name} and their jobs, photos and tasks? Quotes and invoices are kept.`)) { await guard(() => store.remove('customers', c.id), 'Deleted'); closeModal(); location.hash = '#/customers'; } };
    });
  }
  async function renderCustomer(id) {
    const c = custById(id); if (!c) { view.innerHTML = '<div class="card empty">Customer not found. <a href="#/customers">Back</a></div>'; return; }
    const jobs = S.jobs.filter(j => j.customer_id === id).sort((a, b) => a.date < b.date ? 1 : -1);
    const docs = S.documents.filter(d => d.customer_id === id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const tasks = S.tasks.filter(t => t.customer_id === id && !t.done);
    const rv = L.reviewStatus(S.review_requests, id);
    const spent = docs.filter(d => d.kind === 'invoice' && d.status === 'paid').reduce((s, d) => s + L.docTotals(d).total, 0);
    view.innerHTML = `
      <div class="crumbs"><a href="#/customers">← Customers</a></div>
      <div class="detail-grid">
        <div class="col">
          <div class="card">
            <div class="detail-head"><div class="avatar lg">${h(initials(c.name))}</div><div class="li-main"><h1>${h(c.name)}</h1><div class="muted small">Customer since ${fmtDate(c.created_at)} · ${money(spent)} paid</div></div><button class="btn sm" id="editC">Edit</button></div>
            <div class="quick">${quickLinks(c)}</div>
            <dl class="kv"><dt>Phone</dt><dd>${h(c.phone || '—')}</dd><dt>Email</dt><dd>${h(c.email || '—')}</dd><dt>Address</dt><dd>${h(c.address || '—')}</dd>
              <dt>Source</dt><dd>${c.source ? `<span class="tag src">${h(c.source)}</span>` : '—'}</dd>
              <dt>Next service</dt><dd>${c.next_service_due ? dueChip(c.next_service_due) : '<span class="muted">not set</span>'}</dd>
              ${(c.tags || []).length ? `<dt>Tags</dt><dd><div class="tags">${c.tags.map(t => `<span class="tag">${h(t)}</span>`).join('')}</div></dd>` : ''}
              <dt>Notes</dt><dd class="pre">${h(c.notes || '—')}</dd></dl>
          </div>
          <div class="card">
            <div class="card-head"><h2>Ask for a review</h2>${rv.asked ? `<span class="small muted">Asked ${fmtDate(rv.firstAt)}${rv.followedUp ? ' · followed up' : ''}</span>` : ''}</div>
            ${!B.google_review_link ? '<div class="notice warn small">Add your Google review link in <a href="#/settings">Settings</a> first.</div>' : ''}
            ${c.opted_out ? '<div class="notice bad small">This customer opted out. Do not text or email them marketing or review requests.</div>' : `
            <p class="small muted">Opens your phone's texting or email app with the message filled in. Nothing is sent until you press send.</p>
            <div class="row">
              ${rv.followedUp ? '<span class="small muted">Review asked + one follow-up sent. That\'s the limit, no more nudges.</span>' : `
              <button class="btn" data-review="sms:${rv.asked ? 'followup' : 'first'}" ${c.phone ? '' : 'disabled'}>💬 ${rv.asked ? 'Text follow-up' : 'Text review request'}</button>
              <button class="btn" data-review="email:${rv.asked ? 'followup' : 'first'}" ${c.email ? '' : 'disabled'}>✉️ ${rv.asked ? 'Email follow-up' : 'Email review request'}</button>`}
            </div>${rv.followupDue ? '<div class="small mt-s"><b>Follow-up is due</b> (3+ days since you asked).</div>' : ''}`}
          </div>
          <div class="card">
            <div class="card-head"><h2>Consent & opt-out</h2></div>
            <label class="checkline"><input type="checkbox" id="smsOk" ${c.sms_ok ? 'checked' : ''} ${c.opted_out ? 'disabled' : ''}> OK to text (they agreed)</label>
            <label class="checkline"><input type="checkbox" id="emailOk" ${c.email_ok ? 'checked' : ''} ${c.opted_out ? 'disabled' : ''}> OK to email</label>
            <div class="field mt-s"><label>Consent log (when and how they agreed)</label><textarea class="input" id="consentLog" rows="3" placeholder="e.g. Oct 12: said OK to texts on the phone">${h(c.consent_log || '')}</textarea></div>
            <div class="row"><button class="btn sm" id="saveConsent">Save</button>${c.opted_out ? `<span class="tag stop">Opted out ${fmtDate(c.opted_out_at)}</span><button class="btn sm" id="optIn">They opted back in</button>` : '<button class="btn sm danger" id="optOut">They replied STOP</button>'}</div>
            <p class="small muted">If a customer replies STOP, QUIT, END, REVOKE, OPT OUT, CANCEL or UNSUBSCRIBE, mark it here. The law gives you at most 10 business days; doing it right away is safest.</p>
          </div>
        </div>
        <div class="col">
          <div class="card"><div class="card-head"><h2>Job history</h2><button class="btn sm primary" id="addJob">+ Job</button></div>
            ${jobs.length ? jobs.map(j => `<div class="job" data-job="${h(j.id)}">
              <div class="row nowrap"><div class="li-main"><div class="li-title">${h(j.title)}</div><div class="li-sub">${fmtDate(j.date)} · ${statusChip(j.status)} ${j.price ? '· ' + money(j.price) : ''}</div></div>
                <label class="btn sm">📷 Add photo<input type="file" accept="image/*" capture="environment" multiple hidden data-photo="${h(j.id)}"></label><button class="btn sm" data-editjob="${h(j.id)}">Edit</button></div>
              ${j.notes ? `<div class="job-notes pre">${h(j.notes)}</div>` : ''}
              ${(j.photos || []).length ? `<div class="photos">${j.photos.map((p, i) => `<figure><img data-src="${h(p.path)}" alt="${h(p.caption || 'Job photo')}" loading="lazy"><figcaption>${h(p.caption || '')}</figcaption><button class="ph-del" title="Remove photo" data-delphoto="${h(j.id)}:${i}">✕</button></figure>`).join('')}</div>` : ''}
            </div>`).join('') : '<div class="empty small">No jobs yet. Add one to keep notes and before/after photos.</div>'}
          </div>
          <div class="card"><div class="card-head"><h2>Quotes & invoices</h2><div class="row"><a class="btn sm" href="#/doc/new-quote?c=${h(id)}">+ Quote</a><a class="btn sm" href="#/doc/new-invoice?c=${h(id)}">+ Invoice</a></div></div>
            ${docs.length ? `<div class="table-wrap"><table class="ctable"><tbody>${docs.map(d => `<tr data-doc="${h(d.id)}"><td><b>${h(d.number)}</b> <span class="muted small">${d.kind === 'quote' ? 'Quote' : 'Invoice'}</span></td><td>${fmtDate(d.created_at)}</td><td>${statusChip(d.status)}</td><td class="num">${money(L.docTotals(d).total)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">None yet.</div>'}
          </div>
          <div class="card"><div class="card-head"><h2>Tasks</h2><button class="btn sm" id="addT">+ Task</button></div>${tasks.length ? tasks.map(taskRow).join('') : '<div class="empty small">No open tasks.</div>'}</div>
        </div>
      </div>`;
    $('#editC').onclick = () => editCustomer(c);
    $('#addJob').onclick = () => editJob(null, id);
    $('#addT').onclick = () => editTask(null, id);
    $$('[data-editjob]').forEach(b => b.onclick = () => editJob(S.jobs.find(j => j.id === b.dataset.editjob), id));
    $$('[data-doc]').forEach(r => r.onclick = () => { location.hash = '#/doc/' + r.dataset.doc; });
    $$('[data-photo]').forEach(inp => inp.onchange = () => addPhotos(inp.dataset.photo, Array.from(inp.files)));
    $$('[data-delphoto]').forEach(b => b.onclick = async () => { const [jid, i] = b.dataset.delphoto.split(':'); const j = S.jobs.find(x => x.id === jid); if (!confirm('Remove this photo?')) return;
      const p = j.photos[+i]; const photos = j.photos.filter((_, k) => k !== +i); await guard(() => store.update('jobs', jid, { photos })); try { await store.removePhoto(p.path); } catch (e) {} rerender(); });
    $$('img[data-src]').forEach(async img => { try { img.src = await store.photoUrl(img.dataset.src); } catch (e) { img.alt = 'Photo unavailable'; } });
    $$('[data-review]').forEach(b => b.onclick = () => reviewDialog(c, ...b.dataset.review.split(':')));
    const consent = async extra => { await guard(() => store.update('customers', id, Object.assign({ sms_ok: $('#smsOk').checked, email_ok: $('#emailOk').checked, consent_log: $('#consentLog').value.trim() }, extra || {})), 'Saved'); rerender(); };
    $('#saveConsent').onclick = () => consent();
    const oo = $('#optOut'); if (oo) oo.onclick = () => { if (confirm('Mark as opted out? Review and marketing messages will be blocked for this customer.')) consent({ opted_out: true, opted_out_at: new Date().toISOString(), sms_ok: false, email_ok: false, consent_log: (($('#consentLog').value.trim() + '\n').trim() + `\n${fmtDateTime(new Date())}: opted out (replied STOP / asked not to be contacted)`).trim() }); };
    const oi = $('#optIn'); if (oi) oi.onclick = () => { const why = prompt('How did they opt back in? (e.g. "texted START on Oct 30")'); if (why) consent({ opted_out: false, opted_out_at: null, consent_log: ((c.consent_log || '') + `\n${fmtDateTime(new Date())}: opted back in: ${why}`).trim() }); };
    bindCommon(view);
  }
  function reviewDialog(c, channel, kind) {
    const r = L.reviewRequest(B, c, kind, channel);
    openModal(kind === 'followup' ? 'Review follow-up' : 'Review request', `
      ${r.check.ok ? '' : `<div class="notice bad small">${h(r.check.reason)}</div>`}
      ${r.check.warn ? `<div class="notice warn small">${h(r.check.warn)}</div>` : ''}
      ${r.missingLink ? '<div class="notice warn small">No Google review link set. Add it in Settings so the message has a real link.</div>' : ''}
      ${r.missingAddress ? '<div class="notice warn small">Add your business postal address in Settings. Commercial email should include it.</div>' : ''}
      ${r.subject ? `<div class="small muted">Subject: ${h(r.subject)}</div>` : ''}
      <div class="msg-preview pre">${h(r.body)}</div>
      <p class="small muted">Tapping the button opens ${channel === 'sms' ? 'your texting app' : 'your email app'} with this filled in. You press send. We log that you asked so you only follow up once.</p>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button>${r.href ? `<a class="btn primary" id="go" href="${h(r.href)}">${channel === 'sms' ? 'Open in Messages' : 'Open in Email'}</a>` : ''}</div>`, m => {
      const go = $('#go', m); if (go) go.addEventListener('click', async () => { await guard(() => store.insert('review_requests', { customer_id: c.id, channel, kind }), 'Logged review request'); closeModal(); setTimeout(rerender, 200); });
    });
  }
  function editJob(j, customerId) {
    j = j || {};
    openModal(j.id ? 'Edit job' : 'New job', `<form id="f">
      <div class="field"><label>What was done / to do *</label><input class="input" name="title" required maxlength="200" value="${h(j.title || '')}" placeholder="e.g. Driveway + sidewalk wash"></div>
      <div class="grid-3f"><div class="field"><label>Date</label><input class="input" type="date" name="date" value="${h(j.date || todayISO())}"></div>
      <div class="field"><label>Price</label><input class="input" type="number" min="0" step="0.01" name="price" value="${h(j.price || '')}"></div>
      <div class="field"><label>Status</label><select class="input" name="status">${['scheduled', 'done', 'canceled'].map(s => `<option value="${s}" ${s === (j.status || 'scheduled') ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div></div>
      <div class="field"><label>Job notes</label><textarea class="input" name="notes" placeholder="Gate code, materials, what you found…">${h(j.notes || '')}</textarea></div>
      <div class="modal-actions">${j.id ? '<button type="button" class="btn danger" id="del">Delete</button>' : ''}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`, m => {
      $('#f', m).onsubmit = async e => { e.preventDefault(); const f = e.target;
        const row = { title: fieldVal(f, 'title'), date: fieldVal(f, 'date'), price: Number(fieldVal(f, 'price')) || 0, status: fieldVal(f, 'status'), notes: fieldVal(f, 'notes') };
        if (j.id) await guard(() => store.update('jobs', j.id, row), 'Saved'); else await guard(() => store.insert('jobs', Object.assign(row, { customer_id: customerId, photos: [] })), 'Job added');
        closeModal(); rerender(); };
      const d = $('#del', m); if (d) d.onclick = async () => { if (confirm('Delete this job and its photos?')) { for (const p of j.photos || []) { try { await store.removePhoto(p.path); } catch (e) {} } await guard(() => store.remove('jobs', j.id), 'Deleted'); closeModal(); rerender(); } };
    });
  }
  // Shrink photos before upload: saves storage + upload time on a phone connection.
  function shrinkImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => { const k = Math.min(1, maxSide / Math.max(img.width, img.height)); const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); const dataUrl = cv.toDataURL('image/jpeg', quality); cv.toBlob(b => resolve({ blob: b, dataUrl }), 'image/jpeg', quality); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); }; img.src = url;
    });
  }
  async function addPhotos(jobId, files) {
    const j = S.jobs.find(x => x.id === jobId); if (!j || !files.length) return;
    const caption = files.length === 1 ? (prompt('Caption (optional), e.g. "Before" or "After"', '') || '') : '';
    toast('Uploading ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + '…', 10000);
    const photos = (j.photos || []).slice();
    for (const f of files) {
      try { const small = await shrinkImage(f, store.mode === 'demo' ? 900 : 1600, store.mode === 'demo' ? 0.7 : 0.82);
        const { path } = await store.uploadPhoto(jobId, small.blob, small.dataUrl); photos.push({ path, caption, added_at: new Date().toISOString() }); }
      catch (e) { toast('Photo failed: ' + e.message, 5000); }
    }
    try { await store.update('jobs', jobId, { photos }); toast('Photos saved'); } catch (e) { toast(store.mode === 'demo' ? 'Browser storage is full. Demo mode keeps photos in this browser only.' : 'Could not save: ' + e.message, 6000); }
    rerender();
  }

  /* ---------------- MONEY ---------------- */
  function renderMoney() {
    const st = L.stats(S);
    const docs = S.documents.filter(d => d.kind === moneyTab).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const owedList = S.documents.filter(d => L.amountOwed(d) > 0);
    const rows = docs.map(d => { const age = d.status === 'sent' && d.sent_at ? Math.floor((Date.now() - new Date(d.sent_at)) / 86400000) : 0;
      return { d, t: L.docTotals(d), flag: age >= (d.kind === 'quote' ? 3 : 7) ? ` <span class="age age-amber">${age} days</span>` : '' }; });
    view.innerHTML = `
      <div class="page-head"><div><h1>Money</h1><div class="muted small">Quotes, invoices and who owes you</div></div>
        <div class="row"><a class="btn" href="#/doc/new-invoice">+ Invoice</a><a class="btn primary" href="#/doc/new-quote">+ Quote</a></div></div>
      <div class="stats">
        <div class="card stat accent"><div class="label">Money owed</div><div class="value">${money(st.moneyOwed)}</div><div class="hint">${owedList.length} unpaid invoice${owedList.length === 1 ? '' : 's'}</div></div>
        <div class="card stat"><div class="label">Quotes won (30 days)</div><div class="value">${money(st.quotesWonValue30)}</div><div class="hint">${st.quotesWon30} of ${st.quotesSent30} quotes sent</div></div>
        <div class="card stat"><div class="label">Open quotes</div><div class="value">${money(st.openQuotesValue)}</div><div class="hint">Waiting on the customer</div></div>
        <div class="card stat"><div class="label">Paid (30 days)</div><div class="value">${money(st.paid30)}</div><div class="hint">${st.invoicesSent30} invoices sent</div></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="seg" id="seg"><button data-t="quote" class="${moneyTab === 'quote' ? 'on' : ''}">Quotes</button><button data-t="invoice" class="${moneyTab === 'invoice' ? 'on' : ''}">Invoices</button></div></div>
        ${docs.length ? `<div class="only-desk table-wrap"><table class="ctable"><thead><tr><th>#</th><th>Customer</th><th>Date</th><th>Status</th><th class="num">Total</th><th class="num">${moneyTab === 'invoice' ? 'Balance' : 'Deposit'}</th></tr></thead><tbody>
          ${rows.map(({ d, t, flag }) => `<tr data-doc="${h(d.id)}"><td><b>${h(d.number)}</b></td><td>${h(custName(d.customer_id) || '—')}</td><td>${fmtDate(d.sent_at || d.created_at)}</td>
              <td>${statusChip(d.status)}${flag}${d.accepted_name ? ` <span class="small muted">by ${h(d.accepted_name)}</span>` : ''}</td>
              <td class="num">${money(t.total)}</td><td class="num">${moneyTab === 'invoice' ? money(t.balance) : (t.deposit ? money(t.deposit) : '—')}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="only-phone list doc-list">${rows.map(({ d, t, flag }) => `<div class="list-item" data-doc="${h(d.id)}" role="link" tabindex="0">
            <div class="li-main"><div class="li-title">${h(custName(d.customer_id) || '—')}</div>
              <div class="li-sub">${h(d.number)} · ${fmtDate(d.sent_at || d.created_at)}</div>
              <div class="doc-chips">${statusChip(d.status)}${flag}</div></div>
            <div class="right"><div class="strong">${money(t.total)}</div><div class="small muted">${moneyTab === 'invoice' ? (t.balance ? money(t.balance) + ' due' : 'Nothing due') : (t.deposit ? money(t.deposit) + ' deposit' : '')}</div></div></div>`).join('')}</div>` : `<div class="empty">No ${moneyTab}s yet.</div>`}
      </div>`;
    $$('#seg button').forEach(b => b.onclick = () => { if (moneyTab === b.dataset.t) return; moneyTab = b.dataset.t; renderMoney(); });
    $$('[data-doc]').forEach(r => { r.onclick = () => { location.hash = '#/doc/' + r.dataset.doc; }; r.onkeydown = e => { if (e.key === 'Enter') r.onclick(); }; });
  }

  let draft = null;
  function renderDoc(rawId) {
    const [id, qs] = String(rawId || '').split('?'); const p = new URLSearchParams(qs || '');
    let d;
    if (id === 'new-quote' || id === 'new-invoice') {
      const kind = id === 'new-quote' ? 'quote' : 'invoice';
      if (!draft || draft._key !== rawId) draft = { _key: rawId, kind, number: L.nextNumber(S.documents, kind), status: 'draft', customer_id: p.get('c') || '', items: [{ desc: '', qty: 1, price: 0 }],
        tax_rate: Number(B.tax_rate) || 0, deposit: 0, pay_link: B.default_pay_link || '', notes: '', due_date: kind === 'invoice' ? L.isoDate(L.addDays(new Date(), 7)) : null, _lead: p.get('lead') };
      d = draft;
    } else { d = S.documents.find(x => x.id === id); if (!d) { view.innerHTML = '<div class="card empty">Not found. <a href="#/money">Back</a></div>'; return; } d = JSON.parse(JSON.stringify(d)); }
    const isQ = d.kind === 'quote', c = custById(d.customer_id);
    const totalsHTML = t => `
              <div class="trow"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
              <div class="trow"><span>Tax (${t.rate}%)</span><span>${money(t.tax)}</span></div>
              <div class="trow total"><span>Total</span><span>${money(t.total)}</span></div>
              ${t.deposit ? `<div class="trow"><span>${isQ ? 'Deposit to start' : 'Deposit paid'}</span><span>${money(t.deposit)}</span></div><div class="trow strong"><span>${t.paid ? 'Balance' : 'Balance due'}</span><span>${money(t.balance)}</span></div>` : ''}
`;
    const draw = () => {
      const t = L.docTotals(d);
      view.innerHTML = `
        <div class="crumbs"><a href="#/money">← Money</a></div>
        <div class="page-head"><div><h1>${isQ ? 'Quote' : 'Invoice'} ${h(d.number)} ${statusChip(d.status)}</h1><div class="muted small">${d.id ? 'Created ' + fmtDate(d.created_at) : 'Not saved yet'}${d.sent_at ? ' · sent ' + fmtDate(d.sent_at) : ''}${d.from_quote_id ? ' · from quote ' + h((S.documents.find(x => x.id === d.from_quote_id) || {}).number || '') : ''}</div></div>
          <div class="row"><button class="btn primary" id="save">Save</button></div></div>
        <div class="doc-grid">
          <div class="card">
            <div class="grid-3f">
              <div class="field"><label>Customer</label><select class="input" id="cust"><option value="">Choose…</option>${S.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => `<option value="${h(x.id)}" ${x.id === d.customer_id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></div>
              <div class="field"><label>Number</label><input class="input" id="num" value="${h(d.number)}" maxlength="40"></div>
              <div class="field"><label>Status</label><select class="input" id="status">${L.DOC_STATUSES.filter(s => isQ || s !== 'accepted').map(s => `<option value="${s}" ${s === d.status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div>
            </div>
            <table class="items"><thead><tr><th>Description</th><th class="qty">Qty</th><th class="price">Price</th><th class="num">Amount</th><th></th></tr></thead><tbody>
              ${d.items.map((it, i) => `<tr><td class="desc"><input class="input" data-i="${i}" data-k="desc" value="${h(it.desc)}" placeholder="What you'll do" aria-label="Description"></td>
                <td class="qty" data-label="Qty"><input class="input" type="number" inputmode="decimal" min="0" step="any" data-i="${i}" data-k="qty" value="${h(it.qty)}" aria-label="Quantity"></td>
                <td class="price" data-label="Price"><input class="input" type="number" inputmode="decimal" min="0" step="0.01" data-i="${i}" data-k="price" value="${h(it.price)}" aria-label="Price"></td>
                <td class="num amt" data-amt="${i}">${money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td><td class="rm"><button class="icon-btn" data-rm="${i}" aria-label="Remove line">✕</button></td></tr>`).join('')}
            </tbody></table>
            <button class="btn sm" id="addLine">+ Add line</button>
            <div class="grid-3f mt">
              <div class="field"><label>Tax rate %</label><input class="input" type="number" min="0" max="30" step="0.001" id="tax" value="${h(d.tax_rate)}"></div>
              <div class="field"><label>${isQ ? 'Deposit to start' : 'Deposit already paid'}</label><input class="input" type="number" min="0" step="0.01" id="dep" value="${h(d.deposit)}"></div>
              <div class="field"><label>${isQ ? 'Valid until' : 'Due date'}</label><input class="input" type="date" id="due" value="${h(d.due_date || '')}"></div>
            </div>
            <div class="field"><label>Payment link (your Stripe, Square or PayPal link)</label><input class="input" id="pay" value="${h(d.pay_link || '')}" placeholder="https://buy.stripe.com/… or https://square.link/… or https://paypal.me/…"><span class="small muted">Paste a payment link from your own account. Money goes straight to you; this app never touches cards.</span></div>
            <div class="field"><label>Notes for the customer</label><textarea class="input" id="notes" rows="3" placeholder="Warranty, what's not included, scheduling…">${h(d.notes || '')}</textarea></div>
          </div>
          <div class="col">
            <div class="card totals" id="totals">${totalsHTML(t)}</div>
            ${d.accepted_at ? `<div class="card accept-rec"><div class="small strong">✔ Acceptance record</div><div><b>${h(d.accepted_name)}</b> typed their name to accept on ${fmtDateTime(d.accepted_at)}</div><div class="small muted">${h(d.accepted_via || '')}</div><div class="small muted mt-s">This is a record of acceptance, not a legal e-signature.</div></div>` : ''}
            ${d.id ? `<div class="card"><h3>Send & share</h3>
              <div class="stack">
                ${d.status === 'draft' ? '<button class="btn primary" id="markSent">Mark as sent</button>' : ''}
                <a class="btn" href="${h(docLink(d))}" target="_blank" rel="noopener">👁 Customer view / Print</a>
                ${c && c.phone ? `<a class="btn" id="smsDoc" href="${h(L.smsLink(c.phone, `Hi ${L.firstName(c.name)}, here's your ${isQ ? 'quote' : 'invoice'} from ${B.name}: ${docLink(d)}`))}">💬 Text link to ${h(L.firstName(c.name))}</a>` : ''}
                ${c && c.email ? `<a class="btn" id="mailDoc" href="${h(L.mailtoLink(c.email, `${isQ ? 'Quote' : 'Invoice'} ${d.number} from ${B.name}`, `Hi ${L.firstName(c.name)},\n\nHere is your ${isQ ? 'quote' : 'invoice'} (${money(t.total)}):\n${docLink(d)}\n\nThank you,\n${B.name}${B.phone ? '\n' + B.phone : ''}${B.postal_address ? '\n' + B.postal_address : ''}`))}">✉️ Email link</a>` : ''}
                <button class="btn" id="copyLink">🔗 Copy link</button>
                ${isQ && !d.accepted_at && d.status !== 'paid' ? '<button class="btn" id="acceptHere">✍️ Record acceptance in person</button>' : ''}
                ${isQ && (d.status === 'accepted' || d.status === 'paid') ? `<button class="btn primary" id="toInv">→ Turn into invoice</button>` : ''}
                ${!isQ && d.status !== 'paid' ? '<button class="btn primary" id="markPaid">✔ Mark paid</button>' : ''}
                <button class="btn danger" id="delDoc">Delete</button>
              </div>${store.mode === 'demo' ? '<p class="small muted mt-s">Demo mode: the customer link only opens in this browser. With cloud sync on, it works on any phone.</p>' : ''}</div>` : '<div class="card small muted">Save to get a shareable link, a printable view and payment/acceptance options.</div>'}
          </div>
        </div>`;
      const sync = () => {
        d.customer_id = $('#cust').value; d.number = $('#num').value.trim(); d.status = $('#status').value;
        d.tax_rate = Number($('#tax').value) || 0; d.deposit = Number($('#dep').value) || 0; d.due_date = $('#due').value || null; d.pay_link = $('#pay').value.trim(); d.notes = $('#notes').value;
        $$('[data-i]').forEach(el => { const it = d.items[+el.dataset.i]; it[el.dataset.k] = el.dataset.k === 'desc' ? el.value : (Number(el.value) || 0); });
      };
      const live = () => { sync(); d.items.forEach((it, i) => { const c = $(`[data-amt="${i}"]`); if (c) c.textContent = money((Number(it.qty) || 0) * (Number(it.price) || 0)); }); $('#totals').innerHTML = totalsHTML(L.docTotals(d)); };
      $$('[data-i], #tax, #dep').forEach(el => el.addEventListener('input', live));
      $('#addLine').onclick = () => { sync(); d.items.push({ desc: '', qty: 1, price: 0 }); draw(); };
      $$('[data-rm]').forEach(b => b.onclick = () => { sync(); d.items.splice(+b.dataset.rm, 1); if (!d.items.length) d.items.push({ desc: '', qty: 1, price: 0 }); draw(); });
      const save = async (extra, msg) => {
        sync(); Object.assign(d, extra || {});
        if (d.pay_link && !L.safePayLink(d.pay_link)) { toast('Payment link must start with https://', 4000); return null; }
        if (!d.customer_id) { toast('Choose a customer first', 3000); return null; }
        d.items = d.items.filter(it => it.desc || it.price);
        if (d.status !== 'draft' && !d.sent_at) d.sent_at = new Date().toISOString();
        if (d.status === 'paid' && !d.paid_at) d.paid_at = new Date().toISOString();
        const row = ST.pick('documents', d);
        let saved;
        if (d.id) saved = await guard(() => store.update('documents', d.id, row), msg || 'Saved');
        else { saved = await guard(() => store.insert('documents', row), msg || 'Saved'); if (d._lead) { const l = S.leads.find(x => x.id === d._lead); if (l && ['new', 'contacted'].includes(l.status)) await store.update('leads', l.id, { status: 'quote' }); } draft = null; }
        await syncAutoTasks(); return saved;
      };
      $('#save').onclick = async () => { const s = await save(); if (s) { if (location.hash !== '#/doc/' + s.id) location.hash = '#/doc/' + s.id; else rerender(); } };
      const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
      on('#markSent', async () => { const s = await save({ status: 'sent', sent_at: new Date().toISOString() }, 'Marked as sent'); if (s) rerender(); });
      on('#copyLink', () => { navigator.clipboard && navigator.clipboard.writeText(docLink(d)); toast('Link copied'); });
      ['#smsDoc', '#mailDoc'].forEach(sel => { const el = $(sel); if (el) el.addEventListener('click', () => { if (d.status === 'draft') save({ status: 'sent', sent_at: new Date().toISOString() }, 'Marked as sent').then(() => setTimeout(rerender, 300)); }); });
      on('#markPaid', async () => { const s = await save({ status: 'paid', paid_at: new Date().toISOString() }, 'Marked paid 💵'); if (s) rerender(); });
      on('#delDoc', async () => { if (confirm(`Delete ${d.number}?`)) { await guard(() => store.remove('documents', d.id), 'Deleted'); location.hash = '#/money'; } });
      on('#toInv', async () => { const inv = await guard(() => store.insert('documents', L.quoteToInvoice(d, S.documents)), 'Invoice created'); location.hash = '#/doc/' + inv.id; });
      on('#acceptHere', () => openModal('Record acceptance', `<p class="small">Hand the phone to the customer. They type their name to accept <b>${h(d.number)}</b> for <b>${money(L.docTotals(d).total)}</b>.</p>
        <form id="af"><div class="field"><label>Customer's full name</label><input class="input" name="n" required minlength="2" maxlength="120"></div>
        <label class="checkline"><input type="checkbox" name="ok" required> I accept this quote and its terms.</label>
        <p class="small muted">Saves the typed name with the date and time. This is an acceptance record, not a legal e-signature.</p>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Accept quote</button></div></form>`, m => {
        $('#af', m).onsubmit = async e => { e.preventDefault(); const n = e.target.elements.n.value.trim(); if (n.length < 2) return;
          const s = await save({ status: 'accepted', accepted_name: n, accepted_at: new Date().toISOString(), accepted_via: 'Typed in person on the business\'s device' }, 'Acceptance recorded'); closeModal(); if (s) rerender(); };
      }));
    };
    draw();
  }

  /* ---------------- SETTINGS ---------------- */
  function renderSettings() {
    const cloud = store.mode === 'cloud';
    view.innerHTML = `
      <div class="page-head"><h1>Settings</h1></div>
      <div class="grid2">
        <div class="card"><h2>Your business</h2>
          <form id="bizForm" class="mt">
            <div class="field"><label>Business name</label><input class="input" name="name" maxlength="120" value="${h(B.name || '')}"></div>
            <div class="grid-2f"><div class="field"><label>Phone</label><input class="input" name="phone" value="${h(B.phone || '')}"></div><div class="field"><label>Email</label><input class="input" name="email" type="email" value="${h(B.email || '')}"></div></div>
            <div class="field"><label>Postal address (shown on invoices and email footers)</label><input class="input" name="postal_address" value="${h(B.postal_address || '')}"></div>
            <div class="field"><label>Default sales tax %</label><input class="input" type="number" step="0.001" min="0" max="30" name="tax_rate" value="${h(B.tax_rate || 0)}"></div>
            <div class="field"><label>Color</label><div class="swatches">${ACCENTS.map(c => `<button type="button" class="swatch ${c === B.accent ? 'on' : ''}" style="background:${c}" data-accent="${c}" aria-label="${c}"></button>`).join('')}</div></div>
            <button class="btn primary">Save</button>
          </form></div>
        <div class="card"><h2>Reviews</h2>
          <form id="revForm" class="mt">
            <div class="field"><label>Your Google review link</label><input class="input" name="google_review_link" value="${h(B.google_review_link || '')}" placeholder="https://g.page/r/…/review"><span class="small muted">Google Business Profile → "Ask for reviews" → copy link.</span></div>
            <div class="field"><label>Review text message <span class="muted">({first}, {business}, {link})</span></label><textarea class="input" name="review_sms" rows="3">${h(B.review_sms || L.DEFAULT_TEMPLATES.review_sms)}</textarea><span class="small muted">"Reply STOP to opt out." is added automatically.</span></div>
            <div class="field"><label>Review email</label><textarea class="input" name="review_email" rows="5">${h(B.review_email || L.DEFAULT_TEMPLATES.review_email)}</textarea><span class="small muted">Your postal address and an unsubscribe line are added automatically.</span></div>
            <div class="field"><label>One follow-up (sent 3+ days later, only once)</label><textarea class="input" name="review_followup" rows="3">${h(B.review_followup || L.DEFAULT_TEMPLATES.review_followup)}</textarea></div>
            <button class="btn primary">Save</button>
          </form></div>
        <div class="card"><h2>Website lead form</h2>
          <p class="small muted">A short form for your website. Requests drop into Leads.</p>
          <label class="checkline"><input type="checkbox" id="lfOn" ${B.lead_form_enabled !== false ? 'checked' : ''}> Accept requests from the form</label>
          <div class="row mt-s"><button class="btn" id="formLink">Get link & embed code</button></div></div>
        <div class="card"><h2>Account & support</h2>
          ${cloud ? `<p>Signed in as <b>${h(store.user.email)}</b>. Data syncs to your private cloud database.</p><div class="row"><button class="btn" id="signOut">Sign out</button><button class="btn" id="chgPw">Change password</button></div>`
            : `<div class="notice warn small"><b>Demo mode.</b> Everything is saved in this browser only, so clearing browser data erases it. Ask your provider to turn on login + cloud sync (Supabase) to use it on several phones.</div>${store.configError ? `<div class="notice bad small">${h(store.configError)}</div>` : ''}<a class="btn sm" href="?login">Preview the login screen</a>`}
          <form id="supForm" class="mt"><div class="field"><label>Support email (where "Contact support" goes)</label><input class="input" type="email" name="support_email" value="${h(B.support_email || '')}" placeholder="${h(CFG.SUPPORT_EMAIL || 'support@…')}"></div><button class="btn sm">Save</button></form>
          ${supportEmail() ? `<a class="btn mt-s" href="${h($('#supportLink').href)}">✉️ Contact support</a>` : ''}
        </div>
        <div class="card span2" id="installCard"><div class="card-head"><h2>📲 Install app on your phone</h2>${PWA.installed() ? '<span class="chip ok-chip">Installed</span>' : ''}</div>
          <p class="small muted">Free. Puts an app icon on your home screen that opens full screen, like a normal app. It's the same account and data. No app store needed.</p>
          <div class="install-grid">
            <div><h3>iPhone / iPad (Safari)</h3><ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b> (square with arrow ↑).</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol><p class="small muted" style="margin:6px 0 0">The home-screen app has its own storage on iPhone, so sign in once inside it.</p></div>
            <div><h3>Android (Chrome)</h3><ol class="steps"><li>Open this page in <b>Chrome</b>.</li><li>Tap <b>Install app</b> below, or the <b>⋮ menu</b> → <b>Install app</b> / <b>Add to Home screen</b>.</li><li>Tap <b>Install</b>.</li></ol></div>
          </div>
          <div class="row mt-s"><button class="btn primary" id="installBtn" ${PWA.canPrompt() ? '' : 'hidden'}>⬇ Install app</button>
            <span class="small muted">${PWA.swActive() ? (cloud ? 'Offline-ready: the app opens without signal and shows your last saved copy. Adding or changing things needs signal.' : 'Offline-ready: the app opens and works without signal (demo data lives on this device).') : 'Offline mode turns on once the app is served over https.'}</span></div>
        </div>
        <div class="card span2"><h2>Your data</h2>
          <p class="small muted">It's your data. Download all of it any time, or delete it for good.</p>
          <div class="row">
            <button class="btn" id="impCSV">Import customers (CSV)</button>
            <button class="btn" data-csv="customers">Customers CSV</button><button class="btn" data-csv="leads">Leads CSV</button><button class="btn" data-csv="jobs">Jobs CSV</button><button class="btn" data-csv="documents">Quotes & invoices CSV</button><button class="btn" data-csv="tasks">Tasks CSV</button>
            <button class="btn primary" id="fullExport">⬇ Full export (everything, JSON)</button>
            <button class="btn" id="restore">Restore from export</button>
          </div>
          <div class="row mt">
            ${!cloud ? `<button class="btn" id="example">${B.example ? 'Reload' : 'Load'} example data</button>` : ''}
            ${B.example ? '<button class="btn" id="clearExample">Clear example data</button>' : ''}
            <button class="btn danger" id="deleteAll">Delete all my data</button>
          </div></div>
      </div>`;
    let accent = B.accent;
    $$('[data-accent]').forEach(b => b.onclick = () => { accent = b.dataset.accent; $$('[data-accent]').forEach(x => x.classList.toggle('on', x === b)); document.documentElement.style.setProperty('--accent', accent); });
    const saveBiz = async (patch, msg) => { B = await guard(() => store.updateBusiness(patch), msg || 'Saved'); applyBrand(); };
    $('#bizForm').onsubmit = async e => { e.preventDefault(); const f = e.target; await saveBiz({ name: fieldVal(f, 'name') || 'My Business', phone: fieldVal(f, 'phone'), email: fieldVal(f, 'email'), postal_address: fieldVal(f, 'postal_address'), tax_rate: Number(fieldVal(f, 'tax_rate')) || 0, accent }); };
    $('#revForm').onsubmit = async e => { e.preventDefault(); const f = e.target; const link = fieldVal(f, 'google_review_link'); if (link && !/^https:\/\//.test(link)) return toast('Review link must start with https://');
      await saveBiz({ google_review_link: link, review_sms: fieldVal(f, 'review_sms'), review_email: fieldVal(f, 'review_email'), review_followup: fieldVal(f, 'review_followup') }); };
    $('#supForm').onsubmit = async e => { e.preventDefault(); await saveBiz({ support_email: fieldVal(e.target, 'support_email') }); renderSettings(); };
    $('#lfOn').onchange = e => saveBiz({ lead_form_enabled: e.target.checked }, e.target.checked ? 'Form on' : 'Form off: new requests are refused');
    $('#formLink').onclick = showFormLink;
    $('#installBtn').onclick = () => PWA.prompt();
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#signOut', async () => { await store.signOut(); S = null; B = null; location.hash = ''; renderLogin(); });
    on('#chgPw', () => { const pw = prompt('New password (8+ characters)'); if (pw && pw.length >= 8) guard(() => store.updatePassword(pw), 'Password changed'); });
    $$('[data-csv]').forEach(b => b.onclick = () => exportCSV(b.dataset.csv));
    $('#fullExport').onclick = async () => { const data = await guard(() => store.exportAll()); download(`${slug()}-full-export-${todayISO()}.json`, JSON.stringify(data, null, 2), 'application/json'); toast('Downloaded. Keep it somewhere safe.'); };
    $('#impCSV').onclick = () => pickFile('.csv,text/csv', importCSV);
    $('#restore').onclick = () => pickFile('.json,application/json', restoreJSON);
    on('#example', async () => { if (S.customers.length && !B.example && !confirm('Replace what is here with example data?')) return; await loadExample(); toast('Example data loaded'); location.hash = '#/today'; });
    on('#clearExample', async () => { if (!confirm('Remove all example data and start fresh?')) return; await store.deleteAllData(); await blankDemo(); await boot(); toast('Cleared. Add your first customer or lead.'); });
    $('#deleteAll').onclick = () => openModal('Delete all my data', `<div class="notice bad small">This permanently deletes ${cloud ? 'your business, every customer, lead, job, photo, quote, invoice and task from the cloud' : 'everything saved in this browser'}. It cannot be undone.</div>
      <p class="small">Download a full export first if you might want it later.</p>
      <form id="df"><div class="field"><label>Type DELETE to confirm</label><input class="input" name="c" autocomplete="off"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn danger">Delete everything</button></div></form>
      ${cloud ? '<p class="small muted">Your login stays until support removes it (email them to close the account fully).</p>' : ''}`, m => {
      $('#df', m).onsubmit = async e => { e.preventDefault(); if (e.target.elements.c.value.trim() !== 'DELETE') return toast('Type DELETE in capitals'); await guard(() => store.deleteAllData(), 'All data deleted'); if (store.mode === 'demo') await blankDemo(); closeModal(); S = null; B = null; location.hash = ''; await boot(); };
    });
  }
  // demo: leave an empty saved record so the next boot doesn't auto-load example data again
  const blankDemo = () => store.replaceAll({ business: { name: 'My Business', accent: '#2563eb', tax_rate: 0, lead_form_enabled: true } });
  const slug = () => String(B.name || 'crm').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'crm';
  function pickFile(accept, fn) { const fi = $('#fileInput'); fi.accept = accept; fi.value = ''; fi.onchange = () => { const f = fi.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => fn(String(r.result)); r.readAsText(f); }; fi.click(); }
  function exportCSV(kind) {
    const dt = d => (d || '').slice(0, 10);
    const map = {
      customers: [['name', 'phone', 'email', 'address', 'source', 'tags', 'next service due', 'sms ok', 'email ok', 'opted out', 'consent log', 'notes', 'created'], S.customers.map(c => [c.name, c.phone, c.email, c.address, c.source, c.tags, c.next_service_due, c.sms_ok ? 'yes' : 'no', c.email_ok ? 'yes' : 'no', c.opted_out ? 'yes' : 'no', c.consent_log, c.notes, dt(c.created_at)])],
      leads: [['name', 'phone', 'email', 'address', 'service', 'message', 'source', 'status', 'text ok', 'received', 'first contact'], S.leads.map(l => [l.name, l.phone, l.email, l.address, l.service, l.message, l.source, l.status, l.sms_ok ? 'yes' : 'no', l.created_at, l.contacted_at])],
      jobs: [['customer', 'job', 'date', 'price', 'status', 'notes', 'photos'], S.jobs.map(j => [custName(j.customer_id), j.title, j.date, j.price, j.status, j.notes, (j.photos || []).length])],
      documents: [['type', 'number', 'customer', 'status', 'subtotal', 'tax', 'total', 'deposit', 'balance', 'sent', 'accepted by', 'accepted at', 'paid', 'items'], S.documents.map(d => { const t = L.docTotals(d); return [d.kind, d.number, custName(d.customer_id), d.status, t.subtotal, t.tax, t.total, t.deposit, t.balance, dt(d.sent_at), d.accepted_name, d.accepted_at, dt(d.paid_at), (d.items || []).map(i => `${i.qty} x ${i.desc} @ ${i.price}`).join(' | ')]; })],
      tasks: [['task', 'customer', 'due', 'done', 'automatic'], S.tasks.map(t => [t.title, custName(t.customer_id), t.due, t.done ? 'yes' : 'no', t.auto_key ? 'yes' : 'no'])]
    };
    const [head, rows] = map[kind]; download(`${slug()}-${kind}-${todayISO()}.csv`, L.toCSV(head, rows)); toast(`Exported ${rows.length} rows`);
  }
  async function importCSV(text) {
    const list = L.csvToCustomers(text);
    if (!list.length) return toast('No customers found. The first row must have column names like Name, Phone, Email, Address.', 6000);
    if (!confirm(`Import ${list.length} customers?`)) return;
    let n = 0; for (const c of list) { try { await store.insert('customers', Object.assign(c, { sms_ok: false, email_ok: false, opted_out: false })); n++; } catch (e) { console.warn(e); } }
    await syncAutoTasks(); toast(`Imported ${n} customers`); location.hash = '#/customers';
  }
  async function restoreJSON(text) {
    let data; try { data = JSON.parse(text); } catch (e) { return toast('That file is not a valid export.'); }
    if (!data || !Array.isArray(data.customers)) return toast('That file is not a Trade CRM export.');
    if (!confirm(store.mode === 'demo' ? 'Replace everything in this browser with this export?' : `Add ${data.customers.length} customers and their records from this export to your account?`)) return;
    await guard(() => store.replaceAll(data), 'Restored'); B = store.business; await syncAutoTasks(); location.hash = '#/today'; rerender();
  }

  /* ---------------- example data (clearly labeled) ---------------- */
  function photoSVG(label, color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="320" height="220" fill="${color}"/><g fill="rgba(255,255,255,.25)"><rect x="0" y="150" width="320" height="70"/><polygon points="40,150 120,70 200,150"/><polygon points="150,150 230,90 310,150"/></g><text x="16" y="34" font-family="Arial" font-size="20" font-weight="bold" fill="#fff">${label}</text><text x="16" y="206" font-family="Arial" font-size="12" fill="#fff">example photo</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  async function loadExample() {
    const now = Date.now(), ago = (d, hr = 0, m = 0) => new Date(now - d * 864e5 - hr * 36e5 - m * 6e4).toISOString(), day = d => L.isoDate(new Date(now + d * 864e5));
    const id = ST.uuid;
    const C = [
      ['Maria Lopez', '(404) 555-0134', 'maria.lopez@example.com', '1180 Briarcliff Rd NE, Atlanta, GA 30306', 'Google Business Profile', ['repeat'], 'Two-story brick. Side gate code 4412.', day(5), true, true, '2026-03-14: said OK to texts when booking by phone'],
      ['James Carter', '(678) 555-0188', 'jcarter@example.com', '45 Peachtree Pl NW, Atlanta, GA 30309', 'Website form', ['TV mount'], 'Wants wires hidden in wall.', null, true, false, 'Ticked “OK to text me” on website form'],
      ['Priya Shah', '(470) 555-0102', 'priya.shah@example.com', '2210 Lavista Rd, Decatur, GA 30033', 'Referral', ['referral: Maria'], 'Big oak over driveway. Dog in yard.', day(-2), true, true, 'Verbal OK on site visit'],
      ['Derek Nguyen', '(404) 555-0170', '', '890 Ponce de Leon Ave, Atlanta, GA 30306', 'Nextdoor', [], 'Junk haul: old couch + fridge.', null, false, false, ''],
      ['Lisa Morgan', '(770) 555-0151', 'lisa.m@example.com', '312 Oak Grove Dr, Marietta, GA 30064', 'Google', ['commercial'], 'Office building: power wash every spring.', day(40), true, true, 'Signed service agreement'],
      ['Tom Becker', '(678) 555-0199', 'tbecker@example.com', '77 Maple St, Smyrna, GA 30080', 'Repeat customer', [], '', null, false, false, '2026-09-02: replied STOP'],
      ['Angela Brooks', '(404) 555-0123', 'angela.b@example.com', '1500 Cascade Ave SW, Atlanta, GA 30311', 'Facebook', [], 'Panel upgrade quote.', null, true, true, 'OK to text on first call']
    ].map(([name, phone, email, address, source, tags, notes, next, sms, mail, log], i) => ({ id: id(), business_id: 'demo', name, phone, email, address, source, tags, notes, next_service_due: next, sms_ok: sms, email_ok: mail, consent_log: log, opted_out: i === 5, opted_out_at: i === 5 ? ago(56) : null, created_at: ago(200 - i * 20) }));
    const cid = n => C.find(c => c.name.startsWith(n)).id;
    const leads = [
      ['Kevin Price', '(404) 555-0111', '', 'Mount 75" TV over fireplace', 'Website form', 'new', 0, 0, 7, 'Need it done this weekend if possible', true],
      ['Rachel Kim', '(678) 555-0142', 'rkim@example.com', 'Pressure wash driveway + deck', 'Website form', 'new', 0, 0, 27, 'About 1,200 sq ft of concrete', true],
      ['Marcus Hill', '(470) 555-0163', '', 'Junk removal: garage cleanout', 'Google', 'new', 0, 2, 10, '', false],
      ['James Carter', '(678) 555-0188', 'jcarter@example.com', 'TV mount + hide wires', 'Website form', 'quote', 5, 0, 0, '', true],
      ['Sofia Ramirez', '(404) 555-0190', 'sofia.r@example.com', 'Tree trimming', 'Referral', 'contacted', 1, 3, 0, 'Two pines near the roof', false],
      ['Brian Ellis', '(770) 555-0177', '', 'Outlet not working', 'Phone call', 'lost', 12, 0, 0, 'Went with someone else', false],
      ['Priya Shah', '(470) 555-0102', 'priya.shah@example.com', 'Oak trimming', 'Referral', 'won', 20, 0, 0, '', true]
    ].map(([name, phone, email, service, source, status, d, hr, m, message, sms]) => ({ id: id(), business_id: 'demo', name, phone, email, service, source, status, message, sms_ok: sms, created_at: ago(d, hr, m), contacted_at: status === 'new' ? null : ago(d, hr, m - 12), customer_id: C.find(c => c.name === name) ? cid(name) : null }));
    const jobs = [
      [cid('Maria'), 'House wash + driveway', day(0), 425, 'scheduled', 'Bring surface cleaner. Gate code 4412.', []],
      [cid('Derek'), 'Junk haul: couch + fridge', day(0), 260, 'scheduled', 'Fridge needs dolly. 2nd floor walk-up.', []],
      [cid('Lisa'), 'Office front walk + entry wash', day(3), 680, 'scheduled', '', []],
      [cid('Maria'), 'Gutter clean + roof soft wash', day(-180), 540, 'done', 'Moss on north side, told her to watch it.', [{ path: photoSVG('Before', '#7c6f57'), caption: 'Before' }, { path: photoSVG('After', '#2f7d4f'), caption: 'After' }]],
      [cid('Priya'), 'Trim oak over driveway', day(-18), 950, 'done', 'Hauled 2 loads. Stump left per customer.', [{ path: photoSVG('Before', '#556b2f'), caption: 'Before' }, { path: photoSVG('After', '#4a7ba6'), caption: 'After' }, { path: photoSVG('Cleanup', '#8a8a8a'), caption: 'Cleanup' }]],
      [cid('Tom'), 'Deck wash + seal', day(-60), 720, 'done', '', []]
    ].map(([customer_id, title, date, price, status, notes, photos]) => ({ id: id(), business_id: 'demo', customer_id, title, date, price, status, notes, photos: photos.map(p => Object.assign(p, { added_at: ago(10) })), created_at: ago(30) }));
    const item = (desc, qty, price) => ({ desc, qty, price });
    const docs = [
      { kind: 'quote', number: 'Q-1007', customer_id: cid('James'), status: 'sent', sent_at: ago(4), items: [item('Mount 65" TV on drywall (low-profile mount)', 1, 149), item('In-wall wire concealment kit + install', 1, 129), item('Soundbar bracket', 1, 45)], tax_rate: 8.9, deposit: 50, pay_link: 'https://buy.stripe.com/example-deposit', notes: 'Price includes mount. 1-year workmanship warranty.', due_date: day(10) },
      { kind: 'quote', number: 'Q-1006', customer_id: cid('Angela'), status: 'sent', sent_at: ago(1), items: [item('200A panel upgrade (permit included)', 1, 2450), item('Whole-home surge protector', 1, 285)], tax_rate: 0, deposit: 500, pay_link: '', notes: '', due_date: day(20) },
      { kind: 'quote', number: 'Q-1005', customer_id: cid('Priya'), status: 'accepted', sent_at: ago(22), accepted_name: 'Priya Shah', accepted_at: ago(21), accepted_via: 'Customer typed name on share link', items: [item('Trim oak over driveway', 1, 850), item('Haul-away (2 loads)', 2, 50)], tax_rate: 0, deposit: 0, pay_link: '' },
      { kind: 'quote', number: 'Q-1004', customer_id: cid('Lisa'), status: 'accepted', sent_at: ago(9), accepted_name: 'Lisa Morgan', accepted_at: ago(8), accepted_via: 'Typed in person on the business\'s device', items: [item('Front walk + entry pressure wash', 1, 680)], tax_rate: 0, deposit: 0 },
      { kind: 'invoice', number: 'INV-1012', customer_id: cid('Priya'), status: 'sent', sent_at: ago(9), items: [item('Trim oak over driveway', 1, 850), item('Haul-away (2 loads)', 2, 50)], tax_rate: 0, deposit: 0, pay_link: 'https://square.link/u/example', due_date: day(-2) },
      { kind: 'invoice', number: 'INV-1011', customer_id: cid('Tom'), status: 'paid', sent_at: ago(58), paid_at: ago(55), items: [item('Deck wash + seal (320 sq ft)', 1, 720)], tax_rate: 0, deposit: 200 },
      { kind: 'invoice', number: 'INV-1010', customer_id: cid('Maria'), status: 'sent', sent_at: ago(2), items: [item('House wash', 1, 325), item('Driveway surface clean', 1, 100)], tax_rate: 0, deposit: 0, pay_link: 'https://paypal.me/example', due_date: day(12) },
      { kind: 'invoice', number: 'INV-1009', customer_id: cid('Lisa'), status: 'paid', sent_at: ago(25), paid_at: ago(20), items: [item('Parking lot stripe touch-up wash', 1, 1150)], tax_rate: 0, deposit: 0 }
    ].map(d => Object.assign({ id: id(), business_id: 'demo', share_token: id(), created_at: d.sent_at || ago(1) }, d));
    docs.find(d => d.number === 'INV-1012').from_quote_id = docs.find(d => d.number === 'Q-1005').id;
    const tasks = [
      { title: 'Call Sofia back with tree trimming price', due: day(0), customer_id: null },
      { title: 'Order wire kit for James Carter job', due: day(1), customer_id: cid('James') },
      { title: 'Renew general liability insurance', due: day(9), customer_id: null }
    ].map(t => Object.assign({ id: id(), business_id: 'demo', done: false, created_at: ago(1) }, t));
    const reviews = [{ id: id(), business_id: 'demo', customer_id: cid('Priya'), channel: 'sms', kind: 'first', created_at: ago(15) }];
    await store.replaceAll({
      business: { name: 'Peachtree Home Services', accent: '#ea580c', phone: '(404) 555-0100', email: 'hello@peachtree-example.com', postal_address: '123 Example St, Atlanta, GA 30303',
        google_review_link: 'https://g.page/r/EXAMPLE/review', tax_rate: 8.9, lead_form_enabled: true, review_sms: L.DEFAULT_TEMPLATES.review_sms, review_email: L.DEFAULT_TEMPLATES.review_email, review_followup: L.DEFAULT_TEMPLATES.review_followup, example: true },
      customers: C, leads, jobs, documents: docs, tasks, review_requests: reviews
    });
    B = store.business; S = store.state; await syncAutoTasks(); applyBrand();
  }

  /* ---------------- installable app (PWA) ---------------- */
  const PWA = (() => {
    let deferred = null;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const showInstallBtn = () => { const b = $('#installBtn'); if (b) b.hidden = !deferred; };
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; showInstallBtn(); });
    window.addEventListener('appinstalled', () => { deferred = null; showInstallBtn(); toast('App installed. Find it on your home screen.'); });
    function updateBanner(reg) {
      if ($('#updateBar')) return;
      const bar = document.createElement('div'); bar.id = 'updateBar'; bar.className = 'update-bar';
      bar.innerHTML = '<span>Update available</span><button class="btn sm primary" type="button">Reload</button>';
      bar.querySelector('button').onclick = () => { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); else location.reload(); };
      document.body.appendChild(bar);
    }
    function register() {
      if (!('serviceWorker' in navigator) || !secure) return;
      let reloading = false;
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
      navigator.serviceWorker.register('sw.js').then(reg => {
        if (reg.waiting && navigator.serviceWorker.controller) updateBanner(reg);
        reg.addEventListener('updatefound', () => { const w = reg.installing; if (!w) return;
          w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) updateBanner(reg); }); });
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);   // check for a new version hourly
      }).catch(() => {});
    }
    return {
      register,
      canPrompt: () => !!deferred,
      installed: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
      swActive: () => !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      prompt: async () => { if (!deferred) return; deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; showInstallBtn(); if (r && r.outcome === 'accepted') toast('Installing…'); }
    };
  })();
  window.addEventListener('load', () => PWA.register());

  /* ---------------- boot ---------------- */
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
  async function boot() {
    const check = L.checkConfig(CFG);
    if (check.mode === 'cloud' && check.ok && typeof supabase === 'undefined') { try { await loadScript('vendor/supabase.js'); } catch (e) { view.innerHTML = `<div class="card empty">${h(e.message)}</div>`; return; } }
    store = ST.createStore(CFG, { logic: L });
    window.CRM = { get store() { return store; }, loadExample: () => loadExample().then(route), logic: L };
    if (params.has('login')) { await store.init(); applyBrand(); return renderLogin(params.get('login') || 'signin'); }
    if (store.mode === 'cloud') {
      store.client.auth.onAuthStateChange(evt => { if (evt === 'PASSWORD_RECOVERY') setTimeout(() => { const pw = prompt('Choose a new password (8+ characters)'); if (pw && pw.length >= 8) guard(() => store.updatePassword(pw), 'Password updated'); }, 300); });
      const { user } = await guard(() => store.init()).catch(() => ({}));
      if (!user) { applyBrand(); return renderLogin(); }
      return afterLogin();
    }
    const firstRun = (() => { try { return !localStorage.getItem(ST.DEMO_KEY); } catch (e) { return false; } })();
    await store.init(); B = store.business; S = store.state;
    if (firstRun) await loadExample();   // demo only: show clearly-labeled example data on first visit
    setChrome(true); await syncAutoTasks(); applyBrand();
    if (!location.hash || location.hash === '#/') location.hash = '#/today'; else route();
    if (store.configError) toast(store.configError, 8000);
  }
  // refresh "no reply yet" timers and pull changes from other phones every minute
  setInterval(async () => { if (!S || !$('#modal').hidden || document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (store.mode === 'cloud') { try { await store.loadAll(); } catch (e) { return; } } const p = location.hash; if (/^#\/(today|leads)?$/.test(p) || p === '') route(); }, 60000);
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && S && store.mode === 'cloud') { try { await store.loadAll(); await syncAutoTasks(); route(); } catch (e) {} } });
  // back online after a dead zone: refresh from the server
  window.addEventListener('online', async () => { if (S && store && store.mode === 'cloud' && store.user) { try { await store.init(); await store.loadAll(); await syncAutoTasks(); setChrome(true); route(); toast('Back online. Synced.'); } catch (e) {} } });
    // demo: pick up changes made in another tab (e.g. customer accepting on doc.html, website lead form)
  window.addEventListener('storage', async e => { if (store && store.mode === 'demo' && e.key === ST.DEMO_KEY && S) { await store.reload(); if ($('#modal').hidden && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) route(); } });
  boot();
})();
