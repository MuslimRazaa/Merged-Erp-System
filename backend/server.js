/* ============================================================
   Premier ERP backend v3 — Express, MySQL-backed, shares the ISO/LMS
   database (ptis_erp_db) for logins/employees/departments/locations.

   Runs as its own process on its own port (PORT env, default 5050),
   completely separate from iso-server-backend-PTIS's process. It only
   talks to MySQL — never imports or requires anything from
   iso-server-backend-PTIS — so nothing here can crash or block ISO, and
   nothing here alters an ISO table's schema (see migrate.js).

   Routes:
     GET  /api/health
     /api/auth/*      -> routes/auth.js   (shared login against `employees`)
     /api/shared/*    -> routes/shared.js (employees / departments / locations)
     /api/sync/*  and  /sync/*  -> routes/sync.js (generic KV store the
                                    existing front-end sync engine expects)
     /api/attendance/*-> routes/attendance.js (ZKTeco K70 agent ingest + HR view)
   ============================================================ */
'use strict';
// Express 4's own error middleware (below) only catches errors passed via
// next(err) or thrown synchronously — an unhandled rejection inside one of
// this codebase's many `async (req, res) => {...}` route handlers (no
// try/catch, no next(err)) bypasses it entirely and, left unguarded, takes
// the whole process down for every signed-in user, not just the one bad
// request. These two handlers are the safety net: log it, keep serving.
process.on('unhandledRejection', (err) => { console.error('[unhandled-rejection]', err); });
process.on('uncaughtException', (err) => { console.error('[uncaught-exception]', err); });

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const migrate = require('./migrate');
const { router: authRouter, requireAuth } = require('./routes/auth');
const sharedRouter = require('./routes/shared');
const syncRouter = require('./routes/sync');
const attendanceRouter = require('./routes/attendance');
const leaveRouter = require('./routes/leave');
const holidaysRouter = require('./routes/holidays');
const loansRouter = require('./routes/loans');
const payrollRouter = require('./routes/payroll');
const crmRouter = require('./routes/crm');
const recordsRouter = require('./routes/records');
const notificationsRouter = require('./routes/notifications');
const employeeFilesRouter = require('./routes/employeeFiles');
const poApprovalsRouter = require('./routes/poApprovals');

const PORT = +(process.env.PORT || 5050);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '25mb' }));

// serverUtcOffsetMinutes / serverLocalTime: the clock this process uses for
// "late" (shift start + grace) and day boundaries. Attendance and payroll
// compare punch times against the shift in THIS timezone, so it should read
// +300 (Pakistan, UTC+5) — anything else means Late/Absent are being judged on
// the wrong clock.
app.get('/api/health', (req, res) => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  res.json({
    ok: true, time: now.toISOString(), node: process.version,
    serverUtcOffsetMinutes: -now.getTimezoneOffset(),
    serverLocalTime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  });
});

app.use('/api/auth', authRouter);
app.use('/api/shared', sharedRouter);
app.use('/api/sync', syncRouter);
app.use('/sync', syncRouter); // alias — matches the front end's existing cfg.url + '/sync/pull' calls verbatim
app.use('/api/attendance', attendanceRouter);
app.use('/api/leave', leaveRouter);
app.use('/api/holidays', holidaysRouter);
app.use('/api/loans', loansRouter);
app.use('/api/payroll', payrollRouter);
app.use('/api/crm', crmRouter);
app.use('/api/records', recordsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/employee-files', employeeFilesRouter);
app.use('/api/po-approvals', poApprovalsRouter);

// public/index.html, premier-erp.html (2MB+ hand-rolled SPA files, no build
// step) and public/ir-drawings.js (~4MB) are all large enough that serving
// them uncompressed from the live site has been observed being cut off
// mid-response by whatever sits in front of this app (Apache + Phusion
// Passenger) — the connection gets closed partway through, truncating
// whichever file mid-statement. For the HTML files that means NOTHING in
// their one big inline <script> ever becomes defined (every onclick handler
// throws "X is not defined"); for ir-drawings.js it's a straight
// "SyntaxError: Invalid or unexpected token" on the truncated file itself.
// Pre-gzipping these ONCE at startup and serving the compressed bytes
// directly cuts the transfer to a fraction of the size. Deliberately uses
// Node's built-in zlib, not the `compression` npm package — a prior attempt
// with that package risked crashing the whole app if a deploy's
// `npm install` step didn't run, which zlib (always present in Node core)
// can't.
// Re-gzipped when the file on disk changes, not only at startup. Caching it
// once meant an edited front end kept being served as it was when the
// process started: the page looked unchanged, which reads as "the change
// didn't work" rather than "the server is still holding the old copy" — a
// whole afternoon can go into chasing that. A stat() per request on three
// files costs nothing next to gzipping two megabytes, and the gzip only
// happens again when the bytes actually differ.
/* ============================================================
   THE INSTALLED APP — service worker, manifest, and which build is live

   An inspector's machine runs whatever build it installed, and goes on
   running it until somebody here decides otherwise. Two things make that
   work:

   The build id comes from the BYTES of the files the service worker
   caches. A service worker is an update when its own bytes differ, so
   deriving the id from a date or a hand-bumped counter gets it wrong in
   both directions - a redeploy of identical files looks like an update,
   and an edited front end can look like nothing happened. Hashing the
   files cannot be wrong about it.

   And the build the field may move to is written down, not inferred from
   a deploy. /api/app-version reports what is on disk and what has been
   released; the app only offers an update when the build waiting on the
   machine is the released one. Rolling back is naming the earlier build
   again.
   ============================================================ */
const crypto = require('crypto');
// the files whose contents decide what "this build" means
const BUILD_FILES = ['index.html', 'ir-drawings.js', 'pdf-lib.min.js', 'sw.js', 'manifest.webmanifest'];
let BUILD_CACHE = null;   // { id, stamp, at }
/* The memo exists only to avoid rehashing a few megabytes during a burst
   of requests, and it must not be able to MISS a change - which the obvious
   version of it could. A stamp of size and whole-millisecond mtime calls
   two different files identical when they happen to be the same length and
   were written inside the same millisecond, which a deploy script does
   routinely; some filesystems are coarser than that still. That is exactly
   the mistake hashing the bytes was chosen to avoid, so:
   nanosecond mtimes, and the memo is only trusted for a moment. */
const BUILD_MEMO_MS = 1000;
function buildId() {
  const stamp = BUILD_FILES.map((f) => {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, f), { bigint: true });
      return f + ':' + st.size + ':' + st.mtimeNs;
    } catch (e) { return f + ':-'; }
  }).join('|');
  if (BUILD_CACHE && BUILD_CACHE.stamp === stamp &&
      Date.now() - BUILD_CACHE.at < BUILD_MEMO_MS) return BUILD_CACHE.id;
  const h = crypto.createHash('sha256');
  for (const f of BUILD_FILES) {
    try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch (e) { h.update('missing:' + f); }
  }
  const id = h.digest('hex').slice(0, 12);
  const changed = !BUILD_CACHE || BUILD_CACHE.id !== id;
  BUILD_CACHE = { id, stamp, at: Date.now() };
  if (changed) console.log('[app] build ' + id);
  return id;
}

const RELEASE_FILE = path.join(__dirname, '..', 'data', 'app-release.json');
function releaseRead() {
  try { return JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function releaseWrite(rec) {
  fs.mkdirSync(path.dirname(RELEASE_FILE), { recursive: true });
  fs.writeFileSync(RELEASE_FILE, JSON.stringify(rec, null, 2));
}
/* ---- keeping each build, so a rollback can be a real one -------------
   The files that make up a build are copied aside when they change. The
   last few are kept: enough to go back from a bad release, not so many
   that the disk fills with front ends. */
const BUILDS_DIR = path.join(__dirname, '..', 'data', 'builds');
const BUILDS_KEEP = 5;
function buildDir(id) { return path.join(BUILDS_DIR, id); }
function buildArchived(id) {
  if (!/^[0-9a-f]{12}$/.test(id || '')) return false;
  return BUILD_FILES.every((f) => { try { fs.accessSync(path.join(buildDir(id), f)); return true; } catch (e) { return false; } });
}
function buildsList() {
  let names = [];
  try { names = fs.readdirSync(BUILDS_DIR); } catch (e) { return []; }
  return names
    .filter((n) => /^[0-9a-f]{12}$/.test(n) && buildArchived(n))
    .map((n) => {
      let at = 0;
      try { at = fs.statSync(buildDir(n)).mtimeMs; } catch (e) {}
      return { build: n, at: new Date(at).toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
/* Copy what is on disk into its own directory, once. Called whenever the
   build id is wanted, which is cheap because it returns immediately for a
   build already there. */
function buildArchive() {
  const id = buildId();
  if (buildArchived(id)) return id;
  try {
    fs.mkdirSync(buildDir(id), { recursive: true });
    for (const f of BUILD_FILES) {
      const from = path.join(PUBLIC_DIR, f);
      try { fs.copyFileSync(from, path.join(buildDir(id), f)); } catch (e) { /* absent on disk */ }
    }
    console.log('[app] archived build ' + id);
  } catch (e) { console.warn('[app] could not archive build ' + id + ': ' + e.message); return id; }
  // the oldest beyond what we keep
  const all = buildsList();
  const rel = releaseRead().build;
  all.slice(BUILDS_KEEP).forEach((b) => {
    if (b.build === id || b.build === rel) return;      // never the live ones
    try { fs.rmSync(buildDir(b.build), { recursive: true, force: true }); }
    catch (e) {}
  });
  return id;
}
/* Which build this server actually serves: the released one, or - before
   anything has been released, and on a development machine - whatever is
   on disk. */
function activeBuild() {
  const rel = releaseRead().build;
  if (rel && buildArchived(rel)) return rel;
  return buildArchive();
}
/* Where a file of the serving build lives. */
function activeFile(name) {
  const id = activeBuild();
  const archived = path.join(buildDir(id), name);
  try { fs.accessSync(archived); return archived; } catch (e) {}
  return path.join(PUBLIC_DIR, name);
}

/* The service worker, with this build's id written into it. Served from
   here rather than as a static file for exactly one reason: its bytes have
   to carry the id, because that is what makes the browser treat it as a
   new worker. */
app.get('/sw.js', (req, res) => {
  const id = activeBuild();
  let src;
  try { src = fs.readFileSync(activeFile('sw.js'), 'utf8'); }
  catch (e) { return res.status(404).type('application/javascript').send('/* no service worker on this server */'); }
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  // the worker script must never be served from a stale HTTP cache
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  /* The id of the build being SERVED, which is the released one. This is
     what makes releasing - and rolling back to - a build reach the field:
     the bytes of this file change, so the browser installs a new worker,
     and the app offers it. */
  res.send(src.replace(/__BUILD__/g, id));
});

app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  try { res.send(fs.readFileSync(activeFile('manifest.webmanifest'))); }
  catch (e) { res.status(404).json({ error: 'No manifest on this server.' }); }
});

/* What is on disk, and what the field has been told it may run. Left
   unauthenticated like /api/health: it is the app's own version number,
   and it is needed before anybody has signed in. */
app.get('/api/app-version', (req, res) => {
  const staged = buildArchive();          // what is on disk, kept aside
  const serving = activeBuild();          // what this server hands out
  const rel = releaseRead();
  res.json({
    // `build` is what a browser will be given, which is what the app has to
    // compare itself against
    build: serving,
    staged,
    // the staged build is waiting to be released when it is not the one
    // being served
    stagedPending: staged !== serving,
    released: rel.build || null,
    releasedAt: rel.at || null,
    releasedBy: rel.by || null,
    previous: rel.previous || null,
    note: rel.note || '',
    current: serving === staged,
    builds: buildsList(),
  });
});

/* Releasing a build, and rolling one back, are the same act: naming the
   build the field may run. Administrator only - this decides what twenty
   people in the field are running. */
app.post('/api/app-version/release', requireAuth, (req, res) => {
  if (req.erpUser.role !== 'Administrator') {
    return res.status(403).json({ error: 'Administrator only.' });
  }
  const build = String((req.body && req.body.build) || '').trim();
  if (!/^[0-9a-f]{12}$/.test(build)) {
    return res.status(400).json({ error: 'A build id is twelve hex characters.' });
  }
  buildArchive();                         // make sure what is on disk is kept
  /* Releasing a build the server cannot produce would take the whole field
     offline at its next update check. */
  if (!buildArchived(build)) {
    return res.status(404).json({ error: 'That build is not kept on this server, so it cannot be served.' });
  }
  const rec = {
    build,
    at: new Date().toISOString(),
    by: req.erpUser.employeeId,
    note: String((req.body && req.body.note) || '').slice(0, 500),
    // what it replaced, so an administrator can see what to go back to
    previous: releaseRead().build || null,
  };
  releaseWrite(rec);
  console.log('[app] released ' + build + ' by ' + rec.by);
  res.json(rec);
});

const ASSET_TYPES = [
  ['index.html', 'text/html; charset=UTF-8'],
  ['premier-erp.html', 'text/html; charset=UTF-8'],
  ['ir-drawings.js', 'application/javascript; charset=UTF-8'],
];
const GZIPPED_ASSETS = new Map(); // relative filename -> {raw, gzipped, contentType, mtimeMs, size}
function loadGzippedAsset(name, contentType) {
  /* From the build being served, not from whatever is on disk: deploying
     the next front end must not change what the field is running. */
  const abs = activeFile(name);
  let st;
  try { st = fs.statSync(abs); } catch (e) { return null; }
  const have = GZIPPED_ASSETS.get(name);
  // the path is part of the identity now: a rollback changes it, and the
  // gzipped copy in hand belongs to the build it came from
  if (have && have.abs === abs && have.mtimeMs === st.mtimeMs && have.size === st.size) return have;
  const raw = fs.readFileSync(abs);
  const entry = { raw, gzipped: zlib.gzipSync(raw), contentType, abs,
                  mtimeMs: st.mtimeMs, size: st.size };
  GZIPPED_ASSETS.set(name, entry);
  if (have) console.log('[assets] re-read ' + name + ' (' + raw.length + ' bytes)');
  return entry;
}
for (const [name, contentType] of ASSET_TYPES) loadGzippedAsset(name, contentType);
function serveGzippedAsset(name) {
  const contentType = (ASSET_TYPES.find((a) => a[0] === name) || [])[1];
  return (req, res) => {
    // If the file has been deleted since startup, the copy in hand still works.
    const entry = loadGzippedAsset(name, contentType) || GZIPPED_ASSETS.get(name);
    res.setHeader('Content-Type', entry.contentType);
    if ((req.headers['accept-encoding'] || '').includes('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.send(entry.gzipped);
    } else {
      res.send(entry.raw);
    }
  };
}
if (GZIPPED_ASSETS.has('index.html')) {
  app.get('/', serveGzippedAsset('index.html'));
  app.get('/index.html', serveGzippedAsset('index.html'));
}
if (GZIPPED_ASSETS.has('premier-erp.html')) {
  app.get('/premier-erp.html', serveGzippedAsset('premier-erp.html'));
}
if (GZIPPED_ASSETS.has('ir-drawings.js')) {
  app.get('/ir-drawings.js', serveGzippedAsset('ir-drawings.js'));
}

// Serve the existing HTML/JS front end unchanged.
app.use(express.static(PUBLIC_DIR));

app.use((req, res) => res.status(404).json({ error: 'Unknown route.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error.' }); });

migrate()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Premier ERP backend v3 running at http://${HOST}:${PORT}`);
      console.log(`Sharing database "${process.env.DB_NAME}" with the ISO/LMS backend — read-only on employees/departments/locations except where explicitly noted in routes/shared.js.`);
    });
  })
  .catch((e) => {
    // mysql2 connection failures (e.g. ECONNREFUSED) arrive as an AggregateError
    // with an empty .message — fall back to the code / inner errors so the cause is visible.
    const detail = e.message || e.code || (e.errors || []).map((x) => x.message).join('; ') || String(e);
    console.error('[FATAL] migration failed, not starting:', detail);
    if (!process.env.DB_HOST || !process.env.DB_NAME) console.error('[FATAL] DB_HOST / DB_NAME not set — create backend/.env (see .env.example).');
    process.exit(1);
  });
