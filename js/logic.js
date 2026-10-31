/* Trade CRM v2: pure business logic (no DOM, no network). Works in the browser (window.CRMLogic) and Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CRMLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);
  const parseDay = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const money = n => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const LEAD_STATUSES = [
    { id: 'new', name: 'New' }, { id: 'contacted', name: 'Contacted' }, { id: 'quote', name: 'Quote sent' },
    { id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }];
  const DOC_STATUSES = ['draft', 'sent', 'accepted', 'paid'];

  /* ---------- quotes & invoices ---------- */
  function docTotals(doc) {
    const items = Array.isArray(doc && doc.items) ? doc.items : [];
    const subtotal = round2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0));
    const rate = Math.max(0, Number(doc && doc.tax_rate) || 0);
    const tax = round2(subtotal * rate / 100);
    const total = round2(subtotal + tax);
    const deposit = Math.min(round2(doc && doc.deposit), total);
    const paid = doc && doc.status === 'paid';
    const balance = paid ? 0 : round2(total - deposit);
    return { subtotal, rate, tax, total, deposit, balance, paid };
  }
  /* Amount still owed on an invoice (not counting drafts). */
  function amountOwed(doc) {
    if (!doc || doc.kind !== 'invoice' || doc.status === 'draft' || doc.status === 'paid' || doc.status === 'void') return 0;
    return docTotals(doc).total;
  }
  function nextNumber(docs, kind) {
    const prefix = kind === 'invoice' ? 'INV-' : 'Q-';
    let max = 1000;
    (docs || []).filter(d => d.kind === kind).forEach(d => { const n = parseInt(String(d.number).replace(/\D/g, ''), 10); if (n > max) max = n; });
    return prefix + (max + 1);
  }
  function quoteToInvoice(quote, docs, now) {
    return {
      kind: 'invoice', number: nextNumber(docs, 'invoice'), status: 'draft', customer_id: quote.customer_id,
      items: JSON.parse(JSON.stringify(quote.items || [])), tax_rate: quote.tax_rate, deposit: quote.deposit,
      pay_link: quote.pay_link || '', notes: quote.notes || '', due_date: isoDate(addDays(now || new Date(), 7)),
      from_quote_id: quote.id
    };
  }
  function safePayLink(url) {
    url = String(url || '').trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
  }

  /* ---------- leads: "not contacted yet" badge ---------- */
  // Speed-to-lead timer for leads still marked New with no first contact. Levels (unchanged): fresh < 15 min,
  // amber from 15 min, red from 1 hour (overdue). Prospects found by Rex/Webster (source starts with their name)
  // never asked for a quote, so the 15-minute rule doesn't apply: they get a calm grey "prospect" badge.
  /* ---------- lead source: which bot found it (display/filter only; stored data untouched) ---------- */
  // A source part counts as a bot when it is exactly the bot's name or starts with it followed by a
  // non-letter (e.g. "Rex - unanswered reviews", "rex-2", " REX "). "Rexford Plumbing" / "Websterville" don't.
  // A source can list several finders separated by ; | or , ("Webster - no website; Rex - unanswered reviews").
  const BOT_RE = { Rex: /^\s*rex(?![a-z0-9_])/i, Webster: /^\s*webster(?![a-z0-9_])/i };
  const LEAD_SOURCE_FILTERS = [{ id: 'all', name: 'All' }, { id: 'rex', name: 'Rex' }, { id: 'webster', name: 'Webster' }, { id: 'own', name: 'My own' }];
  function leadBots(lead) {
    const parts = String((lead && lead.source) || '').split(/[;|,]/);
    return Object.keys(BOT_RE).filter(b => parts.some(p => BOT_RE[b].test(p)));
  }
  function leadSourceMatch(lead, filter) {
    const bots = leadBots(lead);
    if (filter === 'rex') return bots.includes('Rex');
    if (filter === 'webster') return bots.includes('Webster');
    if (filter === 'own') return !bots.length;
    return true;
  }
  const normSourceFilter = f => LEAD_SOURCE_FILTERS.some(x => x.id === f) ? f : 'all';
  function leadSourceCounts(leads) {
    const c = { all: 0, rex: 0, webster: 0, own: 0 };
    (leads || []).forEach(l => { const b = leadBots(l); c.all++; if (b.includes('Rex')) c.rex++; if (b.includes('Webster')) c.webster++; if (!b.length) c.own++; });
    return c;
  }
  const isProspect = lead => leadBots(lead).length > 0;
  /* ---------- lead email: has a usable address or not (display/filter only; stored data untouched) ---------- */
  // "No email" = empty, only spaces, or not a plausible address (same rule the email composer uses to allow sending:
  // something@domain.tld, no spaces). "abc", "n/a", "none", "a@b" all count as no email.
  const LEAD_EMAIL_FILTERS = [{ id: 'all', name: 'All' }, { id: 'has', name: 'Has email' }, { id: 'no', name: 'No email' }];
  const leadHasEmail = lead => isEmail(lead && lead.email);
  function leadEmailMatch(lead, filter) {
    if (filter === 'has') return leadHasEmail(lead);
    if (filter === 'no') return !leadHasEmail(lead);
    return true;
  }
  const normEmailFilter = f => LEAD_EMAIL_FILTERS.some(x => x.id === f) ? f : 'all';
  function leadEmailCounts(leads) {
    const c = { all: 0, has: 0, no: 0 };
    (leads || []).forEach(l => { c.all++; if (leadHasEmail(l)) c.has++; else c.no++; });
    return c;
  }
  function leadAge(lead, now) {
    now = now ? new Date(now) : new Date();
    if (!lead || lead.status !== 'new' || lead.contacted_at) return { level: 'none', minutes: 0, label: '' };
    const minutes = Math.max(0, Math.floor((now - new Date(lead.created_at)) / 60000));
    const span = minutes < 1 ? 'just now' : (minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr` : `${Math.floor(minutes / 1440)} d`) + ' ago';
    if (isProspect(lead)) return { level: 'prospect', minutes, label: `New, not contacted yet · ${span}` };
    if (minutes >= 60) return { level: 'red', minutes, label: `Overdue, not contacted yet · ${span}` };
    if (minutes >= 15) return { level: 'amber', minutes, label: `New, not contacted yet · ${span}` };
    return { level: 'fresh', minutes, label: `New · ${span}` };
  }

  /* ---------- lead notes: Rex / Webster prospect notes -> labeled lines (display only) ---------- */
  // Split text into plain-text and link parts. Only http(s) URLs become links; everything else stays text.
  function linkParts(text) {
    text = String(text == null ? '' : text);
    const out = [], re = /https?:\/\/[^\s<>"`]+/gi; let last = 0, m;
    while ((m = re.exec(text))) {
      let url = m[0];
      while (/[.,;:!?]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) url = url.slice(0, -1);
      const href = safeHttpUrl(url);
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      if (href) out.push({ text: shortUrl(href), href }); else out.push({ text: url });
      last = m.index + url.length; re.lastIndex = last;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out.reduce((a, p) => { const z = a[a.length - 1]; if (z && !z.href && !p.href) z.text += p.text; else a.push(p); return a; }, []);
  }
  function safeHttpUrl(url) {
    try { const u = new URL(String(url).trim()); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.href : ''; } catch (e) { return ''; }
  }
  function shortUrl(href) {
    try { const u = new URL(href); const host = u.hostname.replace(/^www\./i, '');
      if (/(^|\.)google\.[a-z.]+$/i.test(host) && /^\/maps/.test(u.pathname)) return 'Google Maps link';
      return host + ((u.pathname && u.pathname !== '/') || u.search ? '/…' : ''); } catch (e) { return String(href); }
  }
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const trimSep = s => String(s || '').replace(/^[\s;.,]+|[\s;,]+$/g, '').replace(/\s*;\s*(;\s*)+/g, '; ').trim();
  // Returns null when the text isn't a Rex/Webster note (show it as normal text), else
  // { from: 'Rex'|'Webster', rows: [{ label, parts }] }. Tolerant: any missing piece is just left out.
  function parseLeadNote(text) {
    const raw = String(text == null ? '' : text).trim();
    const pm = /^(rex|webster)\s*:\s*/i.exec(raw);
    if (!pm || raw.length > 5000) return null;
    const from = pm[1].toLowerCase() === 'rex' ? 'Rex' : 'Webster';
    let s = ' ' + raw.slice(pm[0].length) + ' ';
    const rows = []; let rating = null, unanswered = null, website = null, maps = null;
    const take = (re, fn) => { const m = re.exec(s); if (!m) return; fn(m); s = s.slice(0, m.index) + ' ; ' + s.slice(m.index + m[0].length); };
    take(/[\s;.]Maps:\s*(https?:\/\/[^\s<>"`]+)/i, m => { maps = safeHttpUrl(m[1].replace(/[.,;]+$/, '')); if (!maps) maps = null; });
    take(/\brating:?\s+([0-9](?:\.[0-9])?)\s*(?:stars?\s*)?(?:\(\s*([0-9][0-9,]*)\s+reviews?\s*\))?/i, m => {
      rating = m[1] + (m[2] ? ` (${m[2]} review${m[2] === '1' ? '' : 's'})` : ''); });
    take(/\bunanswered reviews?(?: est(?:imate[d]?)?\.?)?:?\s+([^;]*?)(?=\s*;|\.\s|\.?\s*$)/i, m => {
      let v = m[1].trim().replace(/~\s*/g, 'about ');
      if (v && !/^about\b/i.test(v) && !/^0\b/.test(v) && /^[0-9]/.test(v)) v = 'about ' + v;
      unanswered = v || null; });
    take(/\bwebsite:?\s+(?!(?:is|was)\b)([^;]*?)(?=\s*;|\.\s|\.?\s*$)/i, m => {
      const v = m[1].trim(), um = /^(https?:\/\/\S+)/i.exec(v);
      if (um) { const href = safeHttpUrl(um[1].replace(/[.,]+$/, '')); website = href ? [{ text: shortUrl(href).replace(/\/…$/, ''), href }] : linkParts(v); const extra = v.slice(um[1].length).trim(); if (href && extra) website.push({ text: ' ' + extra }); }
      else if (v) website = linkParts(cap(v.replace(/^has site\b/i, 'has a site'))); });
    if (rating) rows.push({ label: 'Rating', parts: [{ text: rating }] });
    if (unanswered) rows.push({ label: 'Reviews without a reply', parts: linkParts(unanswered) });
    if (website) rows.push({ label: 'Website', parts: website });
    // what's left: split out "Note:" / "Outreach:" sections, anything else goes under "Notes"
    const rest = trimSep(s.replace(/(\s*;\s*)+/g, '; ').replace(/;\s*\./g, '.').replace(/\.\s*;/g, '.'));
    const sec = rest.split(/(?:^|[\s;.])\s*(Note|Notes|Outreach):\s*/i);
    const other = trimSep(sec[0]);
    const notes = [];
    if (other) notes.push({ label: 'Notes', text: other });
    for (let i = 1; i < sec.length; i += 2) {
      const t = trimSep(sec[i + 1]); if (!t) continue;
      const label = /^outreach$/i.test(sec[i]) ? 'Outreach' : 'Notes';
      const ex = notes.find(n => n.label === label); if (ex) ex.text += ' ' + t; else notes.push({ label, text: t });
    }
    notes.forEach(n => rows.push({ label: n.label, parts: linkParts(cap(n.text)) }));
    if (maps) rows.push({ label: 'Google Maps', parts: [{ text: 'Open map', href: maps }] });
    if (!rows.length) return null;
    return { from, rows };
  }
  // One-line summary for compact rows (Today page)
  function leadNoteSummary(text) {
    const n = parseLeadNote(text); if (!n) return String(text == null ? '' : text);
    return n.rows.filter(r => r.label !== 'Google Maps').slice(0, 2).map(r => r.label + ': ' + r.parts.map(p => p.text).join('')).join(' · ');
  }

  /* ---------- automatic reminder tasks ---------- */
  // Returns task objects that should exist but don't yet (dedupe by auto_key, including done ones).
  function generateAutoTasks(state, now) {
    now = now ? new Date(now) : new Date();
    const today = parseDay(isoDate(now));
    const have = new Set((state.tasks || []).map(t => t.auto_key).filter(Boolean));
    const custName = id => ((state.customers || []).find(c => c.id === id) || {}).name || 'customer';
    const out = [];
    const add = t => { if (!have.has(t.auto_key)) { have.add(t.auto_key); out.push(t); } };
    (state.documents || []).forEach(d => {
      if (!d.sent_at) return;
      const sent = new Date(d.sent_at);
      if (d.kind === 'quote' && d.status === 'sent' && now - sent >= 3 * DAY)
        add({ auto_key: `quote:${d.id}:3d`, title: `Follow up on quote ${d.number} for ${custName(d.customer_id)} (${money(docTotals(d).total)})`, due: isoDate(addDays(sent, 3)), customer_id: d.customer_id || null, done: false });
      if (d.kind === 'invoice' && d.status === 'sent' && now - sent >= 7 * DAY)
        add({ auto_key: `invoice:${d.id}:7d`, title: `Invoice ${d.number} unpaid 7+ days: ${custName(d.customer_id)} owes ${money(docTotals(d).total)}`, due: isoDate(addDays(sent, 7)), customer_id: d.customer_id || null, done: false });
    });
    (state.customers || []).forEach(c => {
      if (!c.next_service_due) return;
      const due = parseDay(c.next_service_due);
      if (due - today <= 7 * DAY)
        add({ auto_key: `service:${c.id}:${String(c.next_service_due).slice(0, 10)}`, title: `Service due for ${c.name}: book the next visit`, due: String(c.next_service_due).slice(0, 10), customer_id: c.id, done: false });
    });
    return out;
  }
  // Open automatic tasks whose reason went away (quote accepted, invoice paid, service date moved).
  function obsoleteAutoTasks(state) {
    const docs = new Map((state.documents || []).map(d => [d.id, d]));
    const custs = new Map((state.customers || []).map(c => [c.id, c]));
    return (state.tasks || []).filter(t => {
      if (!t.auto_key || t.done) return false;
      const [kind, id, extra] = t.auto_key.split(':');
      if (kind === 'quote' || kind === 'invoice') { const d = docs.get(id); return !d || d.status !== 'sent'; }
      if (kind === 'service') { const c = custs.get(id); return !c || String(c.next_service_due || '').slice(0, 10) !== extra; }
      return false;
    });
  }

  /* ---------- dashboard numbers ---------- */
  function stats(state, now) {
    now = now ? new Date(now) : new Date();
    const weekAgo = now - 7 * DAY, monthAgo = now - 30 * DAY;
    const docs = state.documents || [];
    const quotes30 = docs.filter(d => d.kind === 'quote' && d.status !== 'draft' && new Date(d.sent_at || d.created_at) >= monthAgo);
    const won = quotes30.filter(d => d.status === 'accepted' || d.status === 'paid');
    return {
      newLeadsWeek: (state.leads || []).filter(l => new Date(l.created_at) >= weekAgo).length,
      untouchedLeads: (state.leads || []).filter(l => leadAge(l, now).level === 'red' || leadAge(l, now).level === 'amber').length,
      quotesSent30: quotes30.length,
      quotesWon30: won.length,
      quotesWonValue30: round2(won.reduce((s, d) => s + docTotals(d).total, 0)),
      openQuotesValue: round2(docs.filter(d => d.kind === 'quote' && d.status === 'sent').reduce((s, d) => s + docTotals(d).total, 0)),
      invoicesSent30: docs.filter(d => d.kind === 'invoice' && d.status !== 'draft' && new Date(d.sent_at || d.created_at) >= monthAgo).length,
      moneyOwed: round2(docs.reduce((s, d) => s + amountOwed(d), 0)),
      paid30: round2(docs.filter(d => d.kind === 'invoice' && d.status === 'paid' && new Date(d.paid_at || d.created_at) >= monthAgo).reduce((s, d) => s + docTotals(d).total, 0))
    };
  }

  /* ---------- review requests, texting & email links ---------- */
  const DEFAULT_TEMPLATES = {
    review_sms: 'Hi {first}, thanks for choosing {business}! If you have a minute, a quick Google review helps a small local business a lot: {link}',
    review_email: 'Hi {first},\n\nThank you for choosing {business}. If you were happy with the work, would you leave us a short Google review? It takes about a minute and really helps a small local business:\n{link}\n\nThank you!\n{business}',
    review_followup: 'Hi {first}, just a friendly reminder from {business}: if you have a moment, we would really appreciate a quick review: {link} (this is our only reminder)'
  };
  const STOP_WORDS = ['STOP', 'STOPALL', 'QUIT', 'END', 'REVOKE', 'OPT OUT', 'OPTOUT', 'CANCEL', 'UNSUBSCRIBE'];
  const isStopReply = text => STOP_WORDS.includes(String(text || '').trim().toUpperCase().replace(/[.!]+$/, ''));
  const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'there';
  const fillTemplate = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  const digits = p => String(p || '').replace(/[^\d+]/g, '');

  function smsLink(phone, body) { return `sms:${digits(phone)}?&body=${encodeURIComponent(body || '')}`; }
  function mailtoLink(email, subject, body) {
    return `mailto:${encodeURIComponent(String(email || '').trim()).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
  }
  function telLink(phone) { return `tel:${digits(phone)}`; }
  function mapLink(address) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || '')}`; }

  // Can we message this customer on this channel? Returns {ok, reason, warn}
  function contactCheck(customer, channel) {
    if (!customer) return { ok: false, reason: 'No customer' };
    if (customer.opted_out) return { ok: false, reason: 'Customer opted out (replied STOP or asked not to be contacted).' };
    if (channel === 'sms' && !customer.phone) return { ok: false, reason: 'No phone number on file.' };
    if (channel === 'email' && !customer.email) return { ok: false, reason: 'No email on file.' };
    const consent = channel === 'sms' ? customer.sms_ok : customer.email_ok;
    return { ok: true, warn: consent ? '' : `No ${channel === 'sms' ? 'text' : 'email'} consent recorded. Ask first, then tick it on the customer card.` };
  }

  function reviewRequest(business, customer, kind, channel) {
    business = business || {}; kind = kind === 'followup' ? 'followup' : 'first';
    const vars = { first: firstName(customer && customer.name), business: business.name || 'our team', link: business.google_review_link || '[add your Google review link in Settings]' };
    const tpl = kind === 'followup' ? (business.review_followup || DEFAULT_TEMPLATES.review_followup)
      : channel === 'email' ? (business.review_email || DEFAULT_TEMPLATES.review_email) : (business.review_sms || DEFAULT_TEMPLATES.review_sms);
    let body = fillTemplate(tpl, vars);
    const check = contactCheck(customer, channel);
    if (channel === 'sms') {
      body += ' Reply STOP to opt out.';
      return { channel, kind, body, href: check.ok ? smsLink(customer.phone, body) : '', check, missingLink: !business.google_review_link };
    }
    const subject = kind === 'followup' ? `Quick reminder from ${vars.business}` : `Thanks from ${vars.business}`;
    const footer = `\n\n--\n${vars.business}${business.postal_address ? '\n' + business.postal_address : ''}\nDon't want these emails? Reply "unsubscribe" and we won't email you again.`;
    body += footer;
    return { channel, kind, subject, body, href: check.ok ? mailtoLink(customer.email, subject, body) : '', check, missingLink: !business.google_review_link, missingAddress: !business.postal_address };
  }
  // Has a review been asked, and is a follow-up due (>= 3 days after the first, only one follow-up)?
  function reviewStatus(requests, customerId, now) {
    now = now ? new Date(now) : new Date();
    const mine = (requests || []).filter(r => r.customer_id === customerId).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const first = mine.find(r => r.kind === 'first'), follow = mine.find(r => r.kind === 'followup');
    return { asked: !!first, firstAt: first ? first.created_at : null, followedUp: !!follow, followupDue: !!first && !follow && now - new Date(first.created_at) >= 3 * DAY };
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    text = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }
  const csvCell = v => {
    let s = Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;   // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCSV = (head, rows) => [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  // Map a CSV (header row + rows) to customer objects. Recognises common column names.
  function csvToCustomers(text) {
    const rows = parseCSV(text); if (rows.length < 2) return [];
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = (...names) => head.findIndex(h => names.includes(h));
    const ix = { name: col('name', 'full name', 'customer', 'contact'), phone: col('phone', 'mobile', 'cell', 'phone number'), email: col('email', 'e-mail', 'email address'),
      address: col('address', 'street', 'service address'), source: col('source', 'lead source', 'how found'), tags: col('tags', 'tag'), notes: col('notes', 'note'), next: col('next service due', 'next_service_due', 'next service') };
    return rows.slice(1).map(r => {
      const g = k => (ix[k] >= 0 ? String(r[ix[k]] || '').trim().replace(/^'(?=[=+\-@])/, '') : '');
      return { name: g('name'), phone: g('phone'), email: g('email'), address: g('address'), source: g('source'),
        tags: g('tags') ? g('tags').split(/[;,]/).map(s => s.trim()).filter(Boolean) : [], notes: g('notes'),
        next_service_due: /^\d{4}-\d{2}-\d{2}$/.test(g('next')) ? g('next') : null };
    }).filter(c => c.name);
  }

  /* ---------- config / key safety ---------- */
  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    if (typeof atob === 'function') return atob(s);
    return Buffer.from(s, 'base64').toString('binary');
  }
  // Returns {ok, mode:'demo'|'cloud', error}. Refuses service_role / secret keys so they never get used in a browser.
  function checkConfig(cfg) {
    cfg = cfg || {};
    const url = String(cfg.SUPABASE_URL || '').trim(), key = String(cfg.SUPABASE_ANON_KEY || '').trim();
    if (!url && !key) return { ok: true, mode: 'demo' };
    if (!url || !key) return { ok: false, mode: 'demo', error: 'config.js needs both SUPABASE_URL and SUPABASE_ANON_KEY (or leave both empty for Demo mode).' };
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url) && !/^https:\/\//i.test(url)) return { ok: false, mode: 'demo', error: 'SUPABASE_URL must start with https://' };
    if (/^sb_secret_/i.test(key)) return { ok: false, mode: 'demo', error: 'That is a SECRET key. Never put it in config.js. Use the publishable/anon key.' };
    if (/^eyJ/.test(key)) {
      try {
        const payload = JSON.parse(b64urlDecode(key.split('.')[1] || ''));
        if (payload.role === 'service_role') return { ok: false, mode: 'demo', error: 'That is the service_role key. Never put it in config.js. Use the anon key.' };
        if (payload.role !== 'anon') return { ok: false, mode: 'demo', error: 'Key role must be "anon".' };
      } catch (e) { return { ok: false, mode: 'demo', error: 'Could not read the anon key. Copy it again from Supabase > Project Settings > API.' }; }
    } else if (!/^sb_publishable_/i.test(key)) return { ok: false, mode: 'demo', error: 'Unrecognised key. Use the anon (eyJ...) or publishable (sb_publishable_...) key.' };
    return { ok: true, mode: 'cloud' };
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Validate + clean a public lead-form submission. Returns {ok, spam, lead, error}
  function cleanLead(form, businessId) {
    form = form || {};
    if (String(form.website || '').trim() || String(form.company_fax || '').trim()) return { ok: true, spam: true };   // honeypot filled = bot
    if (form.started_at && Date.now() - Number(form.started_at) < 2500) return { ok: true, spam: true };            // submitted faster than a human
    const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const lead = { business_id: businessId, name: t(form.name, 200), phone: t(form.phone, 40), email: t(form.email, 200), address: t(form.address, 300), service: t(form.service, 200), message: t(form.message, 2000), sms_ok: form.sms_ok === true || form.sms_ok === 'on' || form.sms_ok === 'yes' };
    if (!uuidRe.test(String(businessId || '')) && businessId !== 'demo') return { ok: false, error: 'This form is not set up yet (missing business id).' };
    if (!lead.name) return { ok: false, error: 'Please enter your name.' };
    if (!lead.phone && !lead.email) return { ok: false, error: 'Please enter a phone number or email so we can reply.' };
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return { ok: false, error: 'That email address looks incomplete.' };
    if (lead.phone && digits(lead.phone).replace('+', '').length < 7) return { ok: false, error: 'That phone number looks too short.' };
    Object.keys(lead).forEach(k => { if (lead[k] === '') delete lead[k]; });
    if (!lead.phone) lead.sms_ok = false;
    return { ok: true, spam: false, lead };
  }


  /* ---------------- Email composer (drafts locally; the CRM never sends email itself) ---------------- */
  const OPT_OUT_LINE = 'Not interested? Reply "no thanks" and I won\'t email you again.';
  const MAILTO_MAX = 1900;    // longer mailto: links get cut off by some phones / mail apps
  const GMAIL_MAX = 7500;     // Gmail compose links stop working well past ~8k characters
  const EMAIL_TEMPLATES = [
    { id: 'intro', name: 'First outreach / intro', outreach: true,
      subject: '{business}: about {service}',
      body: 'Hi {name},\n\nThis is {business}. I\'m reaching out about {service}.\n\nIf it would help, I\'m happy to talk it over. Just reply to this email{callClause}.\n\nThanks,\n{signature}' },
    { id: 'followup', name: 'Follow-up after no reply', outreach: true,
      subject: 'Following up: {service}',
      body: 'Hi {name},\n\nJust following up on my earlier email about {service}. If now isn\'t a good time, no problem.\n\nIf you would like to talk, reply here{callClause}.\n\nThanks,\n{signature}' },
    { id: 'quote', name: 'Quote ready', outreach: false,
      subject: 'Your quote from {business}',
      body: 'Hi {name},\n\nYour quote for {service} is ready.\n\n{quoteLine}\n\nAny questions, just reply here{callClause}.\n\nThanks,\n{signature}' },
    { id: 'review', name: 'Review request', outreach: true,
      subject: 'Thanks from {business}, one quick favor?',
      body: 'Hi {name},\n\nThank you for choosing {business}. If you have a minute, would you leave a short review? It really helps a small business.\n\n{reviewLine}\n\nThanks,\n{signature}' },
    { id: 'thanks', name: 'Thank you after job', outreach: false,
      subject: 'Thank you from {business}',
      body: 'Hi {name},\n\nThank you for having {business} out for {service}. If anything needs a second look, just reply here{callClause}.\n\nThanks,\n{signature}' }
  ];
  const isEmail = e => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(String(e || '').trim());
  // "Hi Sam" for people, "Hi Castle Painting team" for businesses found by Rex/Webster
  function greetingName(person) {
    const n = String((person && person.name) || '').trim();
    if (!n) return 'there';
    return isProspect(person) ? `${n} team` : firstName(n);
  }
  function emailVars(business, person, extra) {
    business = business || {}; person = person || {}; extra = extra || {};
    const biz = String(business.name || '').trim() || 'our business';
    const phone = String(business.phone || '').trim();
    const quote = safeHttpUrl(extra.quoteLink || '');
    const review = safeHttpUrl(business.google_review_link || '');
    return {
      name: greetingName(person), fullName: String(person.name || '').trim(),
      service: String(extra.service || person.service || '').trim() || 'your project',
      business: biz, phone, address: String(business.postal_address || '').trim(),
      reviewLink: review,
      callClause: phone ? ` or call ${phone}` : '',
      signature: biz + (phone ? `\n${phone}` : ''),
      quoteLine: quote ? `You can view it here: ${quote}` : '[Paste your quote link here, or attach the PDF]',
      reviewLine: review || '[Add your Google review link in Settings]'
    };
  }
  // The footer every outreach / marketing email gets (CAN-SPAM: postal address + a plain way to opt out).
  function complianceFooter(business) {
    const addr = String((business && business.postal_address) || '').trim();
    const name = String((business && business.name) || '').trim();
    return `\n\n--\n${[name, addr].filter(Boolean).join('\n')}${name || addr ? '\n\n' : ''}${OPT_OUT_LINE}`;
  }
  const hasOptOut = body => /reply\s*["“]?no thanks["”]?/i.test(String(body || ''));
  function buildEmail(templateId, business, person, extra) {
    const t = EMAIL_TEMPLATES.find(x => x.id === templateId) || EMAIL_TEMPLATES[0];
    const vars = emailVars(business, person, extra);
    let body = fillTemplate(t.body, vars);
    if (t.outreach) body += complianceFooter(business);
    return { template: t.id, outreach: t.outreach, to: String((person && person.email) || '').trim(),
      subject: fillTemplate(t.subject, vars), body, missingAddress: !vars.address };
  }
  // Pre-send checks. errors block the send buttons; warnings are shown but can be overridden.
  function checkEmail(email, business) {
    email = email || {}; business = business || {};
    const errors = [], warnings = [];
    const to = String(email.to || '').trim(), body = String(email.body || '');
    if (!to) errors.push('No email address yet, copy the text or call instead.');
    else if (!isEmail(to)) errors.push('That email address does not look right.');
    if (!String(email.subject || '').trim()) warnings.push('The subject is empty.');
    if (!body.trim()) errors.push('The email is empty.');
    const addr = String(business.postal_address || '').trim();
    if (email.outreach) {
      if (!addr) warnings.push('Your postal address is missing. Outreach email must include a real postal address (US CAN-SPAM law). Add it in Settings before sending.');
      else if (!body.includes(addr)) warnings.push('Your postal address is not in this email. Outreach email must include it. Tap "Add footer".');
      if (!hasOptOut(body)) warnings.push('The opt-out line ("Reply no thanks and I won\'t email you again") is missing. Tap "Add footer".');
    }
    if (/\[[^\]\n]{3,}\]/.test(body)) warnings.push('Fill in the [bracketed] part before sending.');
    return { ok: !errors.length, errors, warnings };
  }
  function gmailLink(to, subject, body) {
    return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(String(to || '').trim()).replace(/%40/g, '@') +
      '&su=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || '');
  }
  function emailLinks(to, subject, body) {
    const mailto = mailtoLink(to, subject, body), gmail = gmailLink(to, subject, body);
    return { mailto, gmail, mailtoOk: mailto.length <= MAILTO_MAX, gmailOk: gmail.length <= GMAIL_MAX };
  }
  const emailWhen = e => e.sent_at || e.created_at;
  function emailHistory(emails, ref) {
    ref = ref || {};
    return (emails || []).filter(e => (ref.leadId && e.lead_id === ref.leadId) || (ref.customerId && e.customer_id === ref.customerId))
      .slice().sort((a, b) => new Date(emailWhen(b)) - new Date(emailWhen(a)));
  }
  // Has this lead / address already been emailed (or contacted)? Shown before the send buttons.
  function emailDuplicate(emails, ref) {
    ref = ref || {};
    const to = String(ref.to || '').trim().toLowerCase(), lead = ref.lead || null;
    const sent = (emails || []).filter(e => e.status === 'sent' && e.id !== ref.excludeId &&
      ((to && String(e.to_email || '').trim().toLowerCase() === to) || (lead && e.lead_id === lead.id) || (ref.customerId && e.customer_id === ref.customerId)))
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
    if (sent.length) return { dup: true, kind: 'emailed', date: sent[0].sent_at, email: sent[0], count: sent.length };
    if (lead && (lead.status === 'contacted' || lead.contacted_at)) return { dup: true, kind: 'contacted', date: lead.contacted_at || lead.updated_at || null };
    return { dup: false };
  }
  // Reply tracking: a lead counts as "Replied" once any sent email to it is marked replied.
  function replyState(emails, leadId) {
    const mine = (emails || []).filter(e => e.lead_id === leadId && e.status === 'sent');
    const replied = mine.filter(e => e.replied_at).sort((a, b) => new Date(b.replied_at) - new Date(a.replied_at));
    return { sent: mine.length, canMarkReplied: mine.some(e => !e.replied_at), replied: !!replied.length, repliedAt: replied.length ? replied[0].replied_at : null };
  }
  // Lead patch after "Yes, I sent it" or "They replied": new -> contacted (quote/won/lost are left alone)
  function contactedPatch(lead, now) {
    const p = { status: lead && lead.status === 'new' ? 'contacted' : (lead ? lead.status : 'contacted') };
    if (!lead || !lead.contacted_at) p.contacted_at = new Date(now || Date.now()).toISOString();
    return p;
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return { DAY, LEAD_STATUSES, DOC_STATUSES, DEFAULT_TEMPLATES, STOP_WORDS, round2, isoDate, addDays, parseDay, money, esc,
    docTotals, amountOwed, nextNumber, quoteToInvoice, safePayLink, leadAge, isProspect, leadBots, leadSourceMatch, leadSourceCounts, normSourceFilter, LEAD_SOURCE_FILTERS, leadHasEmail, leadEmailMatch, leadEmailCounts, normEmailFilter, LEAD_EMAIL_FILTERS, linkParts, safeHttpUrl, shortUrl, parseLeadNote, leadNoteSummary, generateAutoTasks, obsoleteAutoTasks, stats,
    fillTemplate, firstName, isStopReply, smsLink, mailtoLink, telLink, mapLink, contactCheck, reviewRequest, reviewStatus,
    parseCSV, csvCell, toCSV, csvToCustomers, checkConfig, cleanLead,
    OPT_OUT_LINE, MAILTO_MAX, GMAIL_MAX, EMAIL_TEMPLATES, isEmail, greetingName, emailVars, complianceFooter, hasOptOut, buildEmail, checkEmail,
    gmailLink, emailLinks, emailHistory, emailDuplicate, replyState, contactedPatch };
});
