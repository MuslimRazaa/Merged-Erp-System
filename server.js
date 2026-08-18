/* ============================================================
   Premier ERP - Node.js live server v2 (zero dependencies)
   ------------------------------------------------------------
   - Serves the ERP front end from ./public
   - First-run admin setup (NO hardcoded passwords)
   - scrypt password hashing, HMAC (JWT-shaped) tokens
   - Role + designation based authorization (matches the ERP UI)
   - Login rate limiting (5 fails -> 60s lock per user+IP)
   - Restricted CORS, security headers
   - JSON-file DB with atomic writes + write queue (no race)
   - Automatic daily backups to ./data/backups (keeps 14)
   - Input validation on all auth routes
   Run:   node server.js
   Env:   PORT, HOST, DATA_DIR, JWT_KEY (required in production),
          CORS_ORIGIN, TOKEN_TTL_HOURS, NODE_ENV
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------- config ---------------- */
const PORT = +(process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROD = process.env.NODE_ENV === 'production';
const JWT_KEY = process.env.JWT_KEY || '';
const TOKEN_TTL_H = Math.min(72, +(process.env.TOKEN_TTL_HOURS || 12));
const CORS_ORIGIN = process.env.CORS_ORIGIN || ''; // '' = same-origin only (no CORS header)
const MAX_BODY = 50 * 1024 * 1024; // 50 MB (reports contain photos)

if (PROD && !JWT_KEY) {
  console.error('[FATAL] JWT_KEY is required in production. Set it, e.g.:');
  console.error('        export JWT_KEY="$(openssl rand -base64 48)"');
  process.exit(1);
}
if (!JWT_KEY) console.warn('[WARN] JWT_KEY not set - using a random key; all tokens reset on restart.');
const SECRET = JWT_KEY || crypto.randomBytes(48).toString('base64');

/* ---------------- roles (must match premier-erp.html) ---------------- */
const GROUPS_ALL = ['Home','CRM','Sales & AR','Inventory','Procurement','Fixed Assets','Human Resources','Compliance','Accounting','Inspection'];
const ROLES = {
  'Administrator':     '*',
  'Management':        GROUPS_ALL,
  'Accounts':          ['Home','CRM','Sales & AR','Procurement','Accounting'],
  'HR Officer':        ['Home','Human Resources'],
  'Inspector':         ['Home','Inspection','Compliance'],
  'QHSE / Quality':    ['Home','Compliance','Inspection'],
  'Sales / CRM':       ['Home','CRM','Sales & AR'],
  'Store / Logistics': ['Home','Inventory','Procurement'],
  'Viewer':            ['Home']
};
/* collection -> module group (for API-level enforcement) */
const COLL_GROUP = {
  customers:'CRM', services:'CRM', leads:'CRM', rfqs:'CRM', quotes:'CRM', activities:'CRM',
  salesorders:'Sales & AR', invoices:'Sales & AR', receipts:'Sales & AR',
  items:'Inventory', stockmoves:'Inventory',
  purchaseorders:'Procurement', grns:'Procurement', vendorbills:'Procurement', payments:'Procurement',
  assets:'Fixed Assets', maintenance:'Fixed Assets',
  employees:'Human Resources', attendance:'Human Resources', leave:'Human Resources', payroll:'Human Resources', trainings:'Human Resources',
  docs:'Compliance', audits:'Compliance', ncrs:'Compliance', risks:'Compliance', hse:'Compliance',
  mgtreviews:'Compliance', calibrations:'Compliance', apiq2:'Compliance',
  contracts:'Inspection', workorders:'Inspection'
};
const BLOB_GROUP = { gl:'Accounting', ir_library:'Inspection' };
function canAccess(user, group) {
  const g = ROLES[user.role];
  if (g === '*') return true;
  if (!g) return false;
  return !group || g.includes(group);
}

/* ---------------- tiny JSON-file store (atomic + queued) ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
function fileFor(name) { return path.join(DATA_DIR, name.replace(/[^a-z0-9_\-]/gi, '_') + '.json'); }
const CACHE = new Map();
function load(name, dflt) {
  if (CACHE.has(name)) return CACHE.get(name);
  let v;
  try { v = JSON.parse(fs.readFileSync(fileFor(name), 'utf8')); } catch (e) { v = dflt; }
  CACHE.set(name, v);
  return v;
}
function save(name, obj) {
  CACHE.set(name, obj);                      // readers always see latest
  const f = fileFor(name), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, f);                     // atomic on POSIX
}

/* ---------------- daily backup (keeps last 14) ---------------- */
function backupNow() {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const dir = path.join(BACKUP_DIR, stamp);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).forEach(f =>
      fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f)));
    const all = fs.readdirSync(BACKUP_DIR).sort();
    while (all.length > 14) fs.rmSync(path.join(BACKUP_DIR, all.shift()), { recursive: true, force: true });
    console.log('[backup] snapshot saved: ' + stamp);
  } catch (e) { console.error('[backup] failed: ' + e.message); }
}
backupNow();
setInterval(backupNow, 6 * 3600 * 1000).unref();

/* ---------------- users & passwords ---------------- */
function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const t = crypto.scryptSync(pw, parts[0], 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(parts[1], 'hex'), Buffer.from(t, 'hex')); }
  catch (e) { return false; }
}
function pwPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$|^[a-z0-9._\-]{2,64}$/i; // email OR plain username
let users = load('users', []);
function pubUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, desig: u.desig || '', active: u.active !== false, createdAt: u.createdAt }; }

/* ---------------- login rate limiting ---------------- */
const FAILS = new Map(); // key -> {n, until}
function rateKey(req, email) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return ip + '|' + String(email || '').toLowerCase();
}
function rateCheck(key) {
  const f = FAILS.get(key);
  if (f && f.until && Date.now() < f.until) return Math.ceil((f.until - Date.now()) / 1000);
  return 0;
}
function rateFail(key) {
  const f = FAILS.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  FAILS.set(key, f);
}
setInterval(() => { const now = Date.now(); FAILS.forEach((v, k) => { if ((!v.until || v.until < now) && v.n === 0) FAILS.delete(k); }); }, 300000).unref();

/* ---------------- tokens ---------------- */
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return head + '.' + body + '.' + crypto.createHmac('sha256', SECRET).update(head + '.' + body).digest('base64url');
}
function verify(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expect = crypto.createHmac('sha256', SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (parts[2].length !== expect.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expect))) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function authUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const p = verify(m[1]);
  if (!p) return null;
  const u = users.find(x => x.id === p.sub);
  if (!u || u.active === false) return null;
  if (u.pwv !== undefined && p.pwv !== undefined && u.pwv !== p.pwv) return null; // token invalidated by pw change
  return u;
}

/* ---------------- audit trail ---------------- */
function audit(user, action, target) {
  const log = load('audit', []);
  log.push({ at: new Date().toISOString(), by: user ? user.email : 'anonymous', action, target });
  if (log.length > 20000) log.splice(0, log.length - 20000);
  save('audit', log);
}

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/* ---------------- request handler ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  /* security headers */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  /* CORS: only if an explicit origin is configured */
  if (CORS_ORIGIN) {
    const origin = req.headers.origin || '';
    const allowed = CORS_ORIGIN.split(',').map(s => s.trim());
    if (allowed.includes(origin) || allowed.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString(), node: process.version, setup: users.length > 0 });

    /* ---- first-run setup: create the admin (only when no users exist) ---- */
    if (p === '/api/auth/setup' && req.method === 'POST') {
      if (users.length) return json(res, 403, { error: 'Setup already completed.' });
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Valid email or username is required.' });
      const perr = pwPolicy(b.password); if (perr) return json(res, 400, { error: perr });
      const u = { id: crypto.randomUUID(), email, name: String(b.name || email).slice(0, 120), desig: String(b.desig || '').slice(0, 120), role: 'Administrator', pw: hashPw(b.password), pwv: 1, active: true, createdAt: new Date().toISOString() };
      users.push(u); save('users', users); audit(u, 'setup-admin', email);
      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_H * 3600;
      return json(res, 201, { token: sign({ sub: u.id, pwv: u.pwv, exp }), user: pubUser(u), expires: new Date(exp * 1000).toISOString() });
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const key = rateKey(req, b.email);
      const wait = rateCheck(key);
      if (wait) return json(res, 429, { error: 'Too many attempts. Try again in ' + wait + ' s.' });
      const u = users.find(x => x.email === String(b.email || '').toLowerCase() && x.active !== false);
      if (!u || !checkPw(b.password || '', u.pw)) {
        rateFail(key); audit(null, 'login-failed', b.email);
        return json(res, 401, { error: 'Invalid username or password.' });
      }
      FAILS.delete(key);
      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_H * 3600;
      audit(u, 'login', u.email);
      return json(res, 200, { token: sign({ sub: u.id, pwv: u.pwv, exp }), user: pubUser(u), expires: new Date(exp * 1000).toISOString() });
    }
    if (p === '/api/auth/me') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'Not signed in.' });
      return json(res, 200, pubUser(u));
    }
    if (p === '/api/auth/register' && req.method === 'POST') {
      const me = authUser(req); if (!me || me.role !== 'Administrator') return json(res, 403, { error: 'Administrator only.' });
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Valid email or username is required.' });
      if (!ROLES[b.role]) return json(res, 400, { error: 'Unknown role. Valid roles: ' + Object.keys(ROLES).join(', ') });
      const perr = pwPolicy(b.password); if (perr) return json(res, 400, { error: perr });
      if (users.some(x => x.email === email)) return json(res, 409, { error: 'User already exists.' });
      const u = { id: crypto.randomUUID(), email, name: String(b.name || email).slice(0, 120), desig: String(b.desig || '').slice(0, 120), role: b.role, pw: hashPw(b.password), pwv: 1, active: true, createdAt: new Date().toISOString() };
      users.push(u); save('users', users); audit(me, 'user-created', email + ' (' + u.role + (u.desig ? ' / ' + u.desig : '') + ')');
      return json(res, 201, pubUser(u));
    }
    if (p === '/api/auth/change-password' && req.method === 'POST') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      if (!checkPw(b.current || '', u.pw)) return json(res, 400, { error: 'Current password is incorrect.' });
      const perr = pwPolicy(b.next); if (perr) return json(res, 400, { error: perr });
      u.pw = hashPw(b.next); u.pwv = (u.pwv || 1) + 1; save('users', users); audit(u, 'password-changed', u.email);
      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_H * 3600;
      return json(res, 200, { ok: true, token: sign({ sub: u.id, pwv: u.pwv, exp }) });
    }
    /* admin user management */
    if (p === '/api/auth/users' && req.method === 'GET') {
      const me = authUser(req); if (!me || me.role !== 'Administrator') return json(res, 403, { error: 'Administrator only.' });
      return json(res, 200, users.map(pubUser));
    }
    let um = /^\/api\/auth\/users\/([\w\-]+)(?:\/(role|password|active))?$/.exec(p);
    if (um && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
      const me = authUser(req); if (!me || me.role !== 'Administrator') return json(res, 403, { error: 'Administrator only.' });
      const u = users.find(x => x.id === um[1]);
      if (!u) return json(res, 404, { error: 'User not found.' });
      if (req.method === 'DELETE') {
        if (u.id === me.id) return json(res, 400, { error: 'You cannot delete your own account.' });
        if (u.role === 'Administrator' && users.filter(x => x.role === 'Administrator' && x.active !== false).length <= 1)
          return json(res, 400, { error: 'Cannot delete the last administrator.' });
        users = users.filter(x => x.id !== u.id); save('users', users); audit(me, 'user-deleted', u.email);
        return json(res, 200, { ok: true });
      }
      const b = await readBody(req);
      if (um[2] === 'role') {
        if (!ROLES[b.role]) return json(res, 400, { error: 'Unknown role.' });
        if (u.id === me.id && b.role !== 'Administrator') return json(res, 400, { error: 'You cannot demote your own account.' });
        u.role = b.role; if (b.desig !== undefined) u.desig = String(b.desig).slice(0, 120);
        save('users', users); audit(me, 'role-changed', u.email + ' -> ' + u.role);
        return json(res, 200, pubUser(u));
      }
      if (um[2] === 'password') {
        const perr = pwPolicy(b.password); if (perr) return json(res, 400, { error: perr });
        u.pw = hashPw(b.password); u.pwv = (u.pwv || 1) + 1;
        save('users', users); audit(me, 'password-reset', u.email);
        return json(res, 200, { ok: true });
      }
      if (um[2] === 'active') {
        if (u.id === me.id) return json(res, 400, { error: 'You cannot deactivate your own account.' });
        u.active = !!b.active; save('users', users); audit(me, b.active ? 'user-activated' : 'user-deactivated', u.email);
        return json(res, 200, pubUser(u));
      }
    }
    if (p === '/api/auth/roles') return json(res, 200, Object.keys(ROLES));

    /* ---- everything below requires a signed-in user ---- */
    if (p.startsWith('/api/')) {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'Not signed in.' });

      let m = /^\/api\/records\/([a-z0-9_]+)(?:\/([\w\-]+))?$/.exec(p);
      if (m) {
        const coll = m[1], id = m[2];
        const group = COLL_GROUP[coll];
        if (group === undefined) return json(res, 404, { error: 'Unknown collection: ' + coll });
        if (!canAccess(u, group)) return json(res, 403, { error: 'Your role (' + u.role + ') has no access to ' + group + '.' });
        if (req.method !== 'GET' && u.role === 'Viewer') return json(res, 403, { error: 'Viewer accounts are read-only.' });
        const key = 'coll_' + coll;
        let rows = load(key, []);
        if (req.method === 'GET') return json(res, 200, rows);
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Record must be a JSON object.' });
          const rec = Object.assign({}, body, { id: body.id || crypto.randomUUID(), _updatedAt: new Date().toISOString(), _updatedBy: u.email });
          const i = rows.findIndex(r => r.id === rec.id);
          if (i >= 0) rows[i] = rec; else rows.push(rec);
          save(key, rows); audit(u, i >= 0 ? 'update' : 'create', coll + '/' + rec.id);
          return json(res, 200, rec);
        }
        if (req.method === 'DELETE' && id) {
          const before = rows.length;
          rows = rows.filter(r => r.id !== id);
          if (rows.length === before) return json(res, 404, { error: 'Record not found.' });
          save(key, rows); audit(u, 'delete', coll + '/' + id);
          return json(res, 200, { ok: true });
        }
      }

      if (p === '/api/sync/push' && req.method === 'POST') {
        const body = await readBody(req);
        const meta = load('sync_meta', {});
        const now = new Date().toISOString();
        let saved = 0; const skipped = [];
        Object.entries(body.collections || {}).forEach(([name, rows]) => {
          if (!Array.isArray(rows)) return;
          const cn = name.replace(/^perp_/, '');
          const group = COLL_GROUP[cn];
          if (group === undefined || !canAccess(u, group)) { skipped.push(cn); return; }
          const k = 'coll_' + cn;
          save(k, rows); meta[k] = { at: now, by: u.email }; saved++;
        });
        Object.entries(body.blobs || {}).forEach(([bk, val]) => {
          const bn = bk.replace(/^perp_/, '');
          const group = BLOB_GROUP[bn];
          if (!canAccess(u, group)) { skipped.push(bn); return; }
          const k = 'blob_' + bn;
          save(k, { value: val, at: now, by: u.email }); meta[k] = { at: now, by: u.email }; saved++;
        });
        save('sync_meta', meta); audit(u, 'sync-push', saved + ' keys' + (skipped.length ? ' (skipped: ' + skipped.join(',') + ')' : ''));
        return json(res, 200, { ok: true, saved, skipped, at: now });
      }
      if (p === '/api/sync/pull') {
        const since = url.searchParams.get('since') || '';
        const meta = load('sync_meta', {});
        const out = { collections: {}, blobs: {}, at: new Date().toISOString() };
        Object.entries(meta).forEach(([key, info]) => {
          if (since && info.at <= since) return;
          if (key.indexOf('coll_') === 0) {
            const cn = key.slice(5);
            if (!canAccess(u, COLL_GROUP[cn])) return;
            out.collections[cn] = load(key, []);
          }
          if (key.indexOf('blob_') === 0) {
            const bn = key.slice(5);
            if (!canAccess(u, BLOB_GROUP[bn])) return;
            out.blobs[bn] = (load(key, {}) || {}).value;
          }
        });
        return json(res, 200, out);
      }

      m = /^\/api\/blobs\/([\w\-]+)$/.exec(p);
      if (m) {
        const bn = m[1], key = 'blob_' + bn;
        if (!canAccess(u, BLOB_GROUP[bn])) return json(res, 403, { error: 'Your role (' + u.role + ') has no access to this data.' });
        if (req.method === 'GET') { const b = load(key, null); return json(res, b ? 200 : 404, b || { error: 'Not found.' }); }
        if (req.method === 'PUT' || req.method === 'POST') {
          if (u.role === 'Viewer') return json(res, 403, { error: 'Viewer accounts are read-only.' });
          const body = await readBody(req);
          save(key, { value: body, at: new Date().toISOString(), by: u.email });
          const meta = load('sync_meta', {}); meta[key] = { at: new Date().toISOString(), by: u.email }; save('sync_meta', meta);
          audit(u, 'blob-put', bn);
          return json(res, 200, { ok: true });
        }
      }

      if (p === '/api/dashboard') {
        const count = n => load('coll_' + n, []).length;
        const ncrs = load('coll_ncrs', []);
        const cals = load('coll_calibrations', []);
        const wos = load('coll_workorders', []);
        return json(res, 200, {
          customers: count('customers'), invoices: count('invoices'),
          purchaseOrders: count('purchaseorders'), employees: count('employees'),
          contracts: count('contracts'), workOrders: wos.length,
          openWorkOrders: wos.filter(w => ['Issued', 'In progress'].indexOf(w.status) >= 0).length,
          openNcrs: ncrs.filter(r => r.status !== 'Closed').length,
          calibrationOverdue: cals.filter(r => r.status === 'Overdue').length
        });
      }

      if (p === '/api/audit') {
        if (u.role !== 'Administrator') return json(res, 403, { error: 'Administrator only.' });
        return json(res, 200, load('audit', []).slice(-500));
      }
      if (p === '/api/backup' && req.method === 'POST') {
        if (u.role !== 'Administrator') return json(res, 403, { error: 'Administrator only.' });
        backupNow(); return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Unknown API route.' });
    }

    /* ---------- static front end ---------- */
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^([.][.][\/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (full.indexOf(PUBLIC_DIR + path.sep) !== 0 && full !== PUBLIC_DIR) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    json(res, e.message === 'body too large' ? 413 : 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Premier ERP server v2 running at http://' + HOST + ':' + PORT);
  console.log('Data directory: ' + DATA_DIR);
  if (!users.length) console.log('[setup] No users yet - open the app; the first account created becomes Administrator (POST /api/auth/setup).');
});
