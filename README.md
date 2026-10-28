# Trade CRM v2

A phone-first CRM for 1–5 person trade shops (handyman, junk removal, pressure washing, electrical, lawn/tree, TV mounting). Plain HTML/CSS/JS, no build step. It runs in two modes:

- **Demo mode** (default, `config.js` empty): everything is saved in this browser only (localStorage). It loads clearly labeled example data on first visit.
- **Cloud mode** (Supabase URL + anon key in `config.js`): email/password login, one business per account, data synced across phones, private job-photo storage, a public website lead form, and customer share links for quotes and invoices.

Status (Oct 28, 2026): **built and tested locally only. Nothing is deployed and no Supabase project exists yet.** See "What is NOT tested" below.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The app: Today, Leads, Customers (+ detail), Money (+ quote/invoice editor), Settings, Login |
| `config.js` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPPORT_EMAIL`, `SUPPORT_NAME`, optional `APP_NAME`. **Never put a service_role / secret key here** (the app refuses to start cloud mode with one). |
| `js/logic.js` | Pure logic: totals, money owed, lead age badges, automatic reminder tasks, review templates + STOP handling, CSV, config check, lead-form validation |
| `js/store.js` | Data layer. `DemoStore` (localStorage) and `SupabaseStore` share one interface. Also has the public lead/document helpers. |
| `lead-form.html` | Public "request a quote" form to link to or embed on the client's website (`?b=<business id>`) |
| `doc.html` | Customer-facing quote/invoice page (`?t=<share token>`): print/PDF, pay button, "type your name to accept" |
| `supabase/schema.sql` | Tables, strict RLS, grants, lead-form insert-only policy + rate limit, share-link functions, `job-photos` storage bucket + policies. Safe to re-run. |
| `supabase/isolation_test.sql` | Proves business A can't see/change business B (and anon can only add leads). Runs in a transaction that rolls back. |
| `supabase/test/` | Runs schema + isolation test locally in PGlite (no account needed), plus a mutation check |
| `tests/` | Unit tests for logic + sync layer against a mocked Supabase client (`node --test tests/`) |
| `test_screens.py` | Headless Chromium end-to-end test + 1280x800 screenshots → `screenshots/` |
| `vendor/supabase.js` | supabase-js 2.109.0 UMD build (MIT, see `vendor/supabase-LICENSE`). Only loaded in cloud mode. |
| `manifest.webmanifest`, `icons/` | Makes it installable as a phone app (name "Trade CRM", full-screen, blue theme). Icons: 192, 512, maskable 512, apple-touch 180, favicon. |
| `sw.js` | Service worker: keeps the app's own files on the phone so it opens offline. **Never stores any customer data, logins or Supabase responses.** |
| `tools/make_icons.py` | Re-draws the icons (PIL) in a new color: `python3 tools/make_icons.py` |
| `_headers` | Cloudflare Pages header rules so app updates reach phones promptly |
| `v1-backup/` | The previous version, untouched |

## Features

- **Today:** new-lead count, money owed, quotes won (30 days), jobs today; new leads with Call/Text; tasks due (manual + automatic); today's and upcoming jobs.
- **Leads:** inbox filtered by New / Contacted / Quote sent / Won / Lost. "New" turns amber **"No reply yet"** at 15 minutes and red at 1 hour. Tapping Call/Text/Email marks it contacted. One tap to "Make customer" or start a quote. The "Text OK" chip shows the lead ticked the consent box.
- **Customers:** searchable cards with one-tap call, text and map (Google Maps). Each card shows lead source, address, notes, tags and next-service-due. The detail page has job history with **photo upload** (shrunk on the phone first) and job notes, plus quotes/invoices and tasks.
- **Quotes & invoices:** line items, tax, deposit, status (draft/sent/accepted/paid, plus void), due date, notes, and a pasted **payment link** (Stripe, Square or PayPal; https only). The share link opens a printable page with a Pay button. The customer can **type their name to accept**: the name and timestamp are saved and labeled *an acceptance record, not a legal e-signature*. You can also record acceptance in person, turn a quote into an invoice, or mark paid.
- **Automatic reminder tasks:** follow up on quotes still open after 3 days, invoices unpaid after 7 days, and next-service-due within 7 days. They close themselves when the quote/invoice moves on.
- **Review requests:** SMS and email templates with the business's own Google review link and **one** follow-up (offered after 3 days). They open your own Messages/Email app (`sms:` / `mailto:`), so **nothing is sent automatically**. SMS adds "Reply STOP to opt out." Email adds the postal address + unsubscribe line. Opted-out customers are blocked. Each customer has a consent log, OK-to-text / OK-to-email switches and a "They replied STOP" button.
- **Website lead form:** honeypot fields + a minimum fill time, an optional "OK to text me" box, 30 submissions per business per hour, and an on/off switch in Settings.
- **Settings:** business name, color, phone, email, postal address, tax rate, review link + templates, support email; CSV export (customers, leads, jobs, quotes/invoices, tasks), CSV import (customers); **full JSON export** and restore; **delete all my data** (type DELETE).
- **Installable app (PWA, free):** opens full screen from a home-screen icon like a normal app, with no app store. Settings → "Install app on your phone" shows the steps and an **Install app** button where the browser supports it (Android/desktop Chrome). Offline: **demo mode** works fully offline. **Cloud mode** opens and shows the last saved copy (an "Offline · saved copy" label appears). Adding or changing things needs signal, because there's no offline save queue yet. Signing out clears the saved copy from that phone. When a new version is deployed, an "Update available, Reload" bar appears.
- **Support:** set `SUPPORT_EMAIL` in `config.js` (or per business in Settings). A "Contact support" link appears in the top bar, on the login screen and in Settings. It's a `mailto:` with the business name in the subject.

## Install it on a phone (after it's deployed on https)

Installing needs https, so it works once the app is on Cloudflare Pages (or `http://localhost` for testing).
- **iPhone / iPad:** open the app link in **Safari** → tap **Share** (square with an arrow) → **Add to Home Screen** → **Add**. On iPhone the home-screen app has its own storage, so sign in once inside it.
- **Android:** open the link in **Chrome** → tap **Install app** in Settings, or use the **⋮** menu → **Install app** / **Add to Home screen** → **Install**.
- **Desktop Chrome/Edge:** the install icon in the address bar, or Settings → Install app.

**Service worker rules** (in the header comment of `sw.js`, and covered by `tests/sw.test.js`): it only handles same-origin GET requests for a fixed list of app files. It skips anything with an Authorization header or a query string, and anything on another origin, which includes all Supabase API, auth, storage and RPC calls. It never touches `lead-form.html` or `doc.html` and never caches form posts. It loads from the network first and only falls back to the saved files when offline. It only registers on https or localhost. **To release an update:** change `VERSION` in `sw.js` (e.g. `v2.1.1`) each time you deploy. Phones then show the Update bar, and the old cache is deleted.

**App Store / Google Play:** not needed for now. Listing it there would need paid developer accounts (Apple Developer Program **US$99/year**, Google Play Console **US$25 one-time**; both checked on the providers' pages Oct 28, 2026) plus a native wrapper such as Capacitor, store review, and store listings. See PLAN.md §6.

## Run it locally

```bash
cd crm-app && python3 -m http.server 8080   # open http://localhost:8080
```
`index.html?login` previews the login screen in demo mode.

## Tests

```bash
node --test tests/                      # 31 unit tests: logic, sync layer vs mocked Supabase client, service-worker rules
python3 test_screens.py                 # 55 browser checks + screenshots, incl. PWA: installable, offline reload, update flow
# SQL / RLS isolation, locally in PGlite (no Supabase account):
mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite
cp <crm-app>/supabase/test/*.mjs . && SQL_DIR=<crm-app>/supabase/ node run_pglite.mjs && SQL_DIR=<crm-app>/supabase/ node mutation_check.mjs
```

## What is NOT tested (no live Supabase was used)

The SQL ran in PGlite (real Postgres 17 in WASM) with **stub** `auth`/`storage` schemas. The sync layer ran against a **mocked** supabase-js client. These have never run against real Supabase:
1. Real sign-up / confirmation email / password-reset email and the `PASSWORD_RECOVERY` redirect.
2. Storage uploads, signed photo URLs and Supabase's real `storage.foldername()` policy behavior.
3. PostgREST specifics: the `upsert(..., {onConflict:'business_id,auto_key', ignoreDuplicates:true})` path, `.single()` errors, and RPC argument names over HTTP.
4. The lead-form rate limit and insert-only policy under a real anon key over the network.
5. Cloudflare Pages hosting, the service worker over real https, and `sms:`/`mailto:`/`tel:` links on real iPhones and Androids (only headless desktop Chromium was used).
6. **Real phone installs:** iPhone "Add to Home Screen", the iOS status bar and notch/home-bar safe areas, and the Android install prompt on a real device. Only desktop headless Chromium was used. It reported the app installable with no errors and it opened offline.
7. Two phones editing the same record: last save wins; there's no live push (the app refreshes every minute and when you reopen it).

Run `supabase/isolation_test.sql` in the real project's SQL Editor right after `schema.sql` (step 3 below). It must print `ALL ISOLATION TESTS PASSED`.

## Go-live steps (needs Mashad's OK: creates accounts)

1. **Create a Supabase project** (supabase.com → New project; pick a US region; save the database password in a password manager).
2. **Auth settings:** Authentication → Providers → Email on (keep "Confirm email" on). Authentication → URL Configuration → set **Site URL** to the final app URL (e.g. `https://yourcrm.pages.dev`) and add it to Redirect URLs. Set up **custom SMTP** before real customers sign up: Supabase's built-in email is for testing only and is heavily limited.
3. **Run the schema:** SQL Editor → paste all of `supabase/schema.sql` → Run. Then paste `supabase/isolation_test.sql` → Run → confirm `ALL ISOLATION TESTS PASSED` (it rolls back, leaving no test data). Check Storage shows a private `job-photos` bucket.
4. **Configure the app:** Project Settings → API → copy the **Project URL** and the **anon / publishable** key (NOT service_role / secret) into `config.js`. Set `SUPPORT_EMAIL`.
5. **Deploy on Cloudflare Pages:** dash.cloudflare.com → Workers & Pages → Create → Pages → upload the `crm-app` folder (direct upload; no build command, output = the folder). Leave out `v1-backup/`, `tests/`, `supabase/test/`, `screenshots/`, `tools/`, `test_screens.py`. Keep `_headers`, `sw.js`, `manifest.webmanifest` and `icons/`. If you change the brand color or name for everyone, re-run `tools/make_icons.py` and edit `manifest.webmanifest`. Optionally connect a custom domain.
6. **Smoke test on a real phone:** create an account, confirm the email, name the business, add a customer + job + photo, create and send a quote, open the share link on a second phone and accept it, submit `lead-form.html?b=<business id>` (the link is in Leads → Website form link), and check that it shows up. Install it on the home screen (iPhone + Android), turn on airplane mode and confirm it still opens with the saved copy. Then sign up a second test account and confirm it sees nothing from the first.
7. **Each new client:** they sign up at the app URL (one account = one business), set their name/color/review link/postal address in Settings, and paste the lead-form iframe on their website.
