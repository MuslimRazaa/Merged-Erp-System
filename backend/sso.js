/* ============================================================
   Shared sign-in between Premier ERP (erp.ptis.co) and the ISO portal
   (iso.ptis.co, API on iso-server.ptis.co).

   One sign-in, in either app, creates ONE row in `sso_sessions` (in the
   database both backends already share) and hands the browser a cookie,
   `ptis_sso`, scoped to the parent domain .ptis.co so all three hosts see
   it. The other app finds the cookie, looks the row up, and signs the
   person straight in. Signing out in either app revokes the row and clears
   the cookie, so the other app's next check finds nothing and signs out
   too. A different browser has no cookie, so it has to sign in itself.

   - The cookie holds a random 256-bit secret; only its SHA-256 is stored
     (`sid`), so a copy of the table cannot be replayed as cookies.
   - HttpOnly (page scripts never see it) and SameSite=Lax (other sites'
     pages never get it sent along with their requests).
   - Idle timeout: SSO_IDLE_HOURS (default 24) without any activity in
     either app ends the session. Activity slides it forward.
   - SSO_DISABLED=1 turns the whole thing off without a code change.

   THE SAME FILE lives in both backends (Merged-Erp-System/backend/sso.js
   and iso-server-backend-PTIS/utils/ssoSession.js) — only the `db` require
   path differs. Change both together.
   ============================================================ */
'use strict';
const crypto = require('crypto');
const pool = require('./db');

const COOKIE = 'ptis_sso';
const IDLE_H = Math.max(1, +(process.env.SSO_IDLE_HOURS || 24));
const COOKIE_MAX_AGE = 30 * 24 * 3600;      // the row's expiry is the real limit
const TOUCH_EVERY_MIN = 5;                  // slide the expiry at most this often
const enabled = () => process.env.SSO_DISABLED !== '1';

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = pool.query(`CREATE TABLE IF NOT EXISTS sso_sessions (
        sid CHAR(64) NOT NULL PRIMARY KEY,
        employee_pk INT NOT NULL,
        created_by VARCHAR(10) NOT NULL DEFAULT '',
        user_agent VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        INDEX idx_sso_employee (employee_pk)
      )`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

function hostOf(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}

/* On any *.ptis.co host the cookie goes on .ptis.co (shared by erp., iso.
   and iso-server.). Anywhere else (localhost during development) it is a
   host-only cookie — browsers share those across ports, so the two local
   servers still see the same one. */
function cookieAttrs(req) {
  const host = hostOf(req);
  let domain = process.env.SSO_COOKIE_DOMAIN || '';
  if (!domain && (host === 'ptis.co' || host.endsWith('.ptis.co'))) domain = '.ptis.co';
  const https = req.secure || /https/i.test(String(req.headers['x-forwarded-proto'] || ''));
  const secure = https || /ptis\.co$/.test(domain);
  return '; Path=/' + (domain ? '; Domain=' + domain : '') + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
}

function setCookie(req, res, value) {
  res.append('Set-Cookie', `${COOKIE}=${value}; Max-Age=${COOKIE_MAX_AGE}${cookieAttrs(req)}`);
}
function clearCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${cookieAttrs(req)}`);
}

async function revoke(sid) {
  if (!sid) return;
  await ensureTable();
  await pool.query('UPDATE sso_sessions SET revoked_at = NOW() WHERE sid = ? AND revoked_at IS NULL', [sid]);
}

/* A fresh sign-in. Whoever was signed in on this browser before is signed
   out first — one browser, one person, in both apps. Returns the sid. */
async function create(req, res, employeePk, app) {
  if (!enabled()) return null;
  await ensureTable();
  const prev = readCookie(req);
  if (prev) await revoke(hash(prev));
  const secret = crypto.randomBytes(32).toString('base64url');
  const sid = hash(secret);
  await pool.query(
    `INSERT INTO sso_sessions (sid, employee_pk, created_by, user_agent, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [sid, employeePk, app || '', String(req.headers['user-agent'] || '').slice(0, 255), IDLE_H]
  );
  setCookie(req, res, secret);
  if (Math.random() < 0.05) {
    pool.query('DELETE FROM sso_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 30 DAY)').catch(() => {});
  }
  return sid;
}

/* Is this sid still a live session for this employee? Counts as activity. */
async function isActive(sid, employeePk) {
  if (!sid) return false;
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT s.employee_pk FROM sso_sessions s JOIN employees e ON e.id = s.employee_pk
     WHERE s.sid = ? AND s.revoked_at IS NULL AND s.expires_at > NOW()
       AND (e.status IS NULL OR e.status <> 'Inactive')`,
    [sid]
  );
  if (!rows.length || (employeePk != null && +rows[0].employee_pk !== +employeePk)) return false;
  pool.query(
    `UPDATE sso_sessions SET last_seen = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR)
     WHERE sid = ? AND last_seen < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [IDLE_H, sid, TOUCH_EVERY_MIN]
  ).catch(() => {});
  return true;
}

/* The live session behind this request's cookie: { sid, employeePk } or null. */
async function fromRequest(req) {
  if (!enabled()) return null;
  const secret = readCookie(req);
  if (!secret) return null;
  const sid = hash(secret);
  await ensureTable();
  const [rows] = await pool.query('SELECT employee_pk FROM sso_sessions WHERE sid = ?', [sid]);
  if (!rows.length || !(await isActive(sid, rows[0].employee_pk))) return null;
  return { sid, employeePk: +rows[0].employee_pk };
}

/* Sign out everywhere: revoke this browser's session (and `alsoSid`, the
   one an app's own token points at, in case they differ) and drop the cookie. */
async function logout(req, res, alsoSid) {
  const secret = readCookie(req);
  try {
    if (secret) await revoke(hash(secret));
    if (alsoSid) await revoke(alsoSid);
  } finally {
    clearCookie(req, res);
  }
}

module.exports = { enabled, create, isActive, fromRequest, logout, revoke, ensureTable, COOKIE };
