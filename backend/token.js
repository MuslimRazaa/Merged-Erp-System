/* Minimal HMAC (JWT-shaped) token, zero extra dependency — same approach
   erp-ptis-complete/server.js used before. Kept self-contained here since
   this backend intentionally has no code dependency on iso-server-backend-PTIS. */
'use strict';
const crypto = require('crypto');
require('dotenv').config();

const JWT_KEY = process.env.JWT_KEY || '';
if (process.env.NODE_ENV === 'production' && !JWT_KEY) {
  console.error('[FATAL] JWT_KEY is required in production. Set it, e.g.: export JWT_KEY="$(openssl rand -base64 48)"');
  process.exit(1);
}
const SECRET = JWT_KEY || crypto.randomBytes(48).toString('base64');
if (!JWT_KEY) console.warn('[WARN] JWT_KEY not set - using a random key; all ERP sessions reset on restart.');

const TOKEN_TTL_H = Math.min(72, +(process.env.TOKEN_TTL_HOURS || 12));

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

function issue(sub, extra) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_H * 3600;
  return { token: sign({ sub, exp, ...extra }), expires: new Date(exp * 1000).toISOString() };
}

module.exports = { sign, verify, issue };
