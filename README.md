# Premier ERP — Node.js Live Server v2 (secured)

Zero-dependency Node.js backend (built-in http + crypto only, no external
packages required) that serves the Premier ERP front end and provides
authentication, role/designation-based authorization, per-module CRUD,
offline sync, blobs, dashboard, audit trail and automatic backups.

## Security hardening in v2
| Issue (previous review)          | Fix in v2 |
|----------------------------------|-----------|
| Hardcoded default admin password | Removed. First run has no users; the first account created via POST /api/auth/setup becomes Administrator. Setup locks itself afterwards. |
| Random JWT fallback              | JWT_KEY is required when NODE_ENV=production — the server refuses to start without it. |
| Wildcard CORS                    | No CORS header by default (same-origin only). Set CORS_ORIGIN=https://erp.premiertubular.com to allow specific origins (comma-separated). |
| No login rate limiting           | 5 failed attempts per user+IP -> 60-second lock (HTTP 429). |
| JSON-file race conditions        | In-memory cache + atomic rename writes; the single-threaded event loop serializes all writes. |
| No automated backups             | Daily snapshot to data/backups/YYYY-MM-DD (keeps 14). Manual: POST /api/backup (admin). |
| No schema validation             | Email/username check, password policy (8+ chars, letters+numbers), role whitelist, record-shape checks. |
| No role-based API control        | Every collection/blob is mapped to a module group; the API enforces the same 9 roles as the ERP UI. Viewer is read-only. Sync push/pull filters by role. |
| Token theft after password change| Tokens carry a password version — any password change/reset invalidates old tokens. |
| Admin foot-guns                  | Cannot delete/deactivate/demote your own account; cannot delete the last administrator. |

## Roles (matching the ERP login page)
Administrator · Management · Accounts · HR Officer · Inspector ·
QHSE / Quality · Sales / CRM · Store / Logistics · Viewer (read-only)

## Run
```bash
node server.js                         # dev  -> http://localhost:5000
```
Production:
```bash
export NODE_ENV=production
export JWT_KEY="$(openssl rand -base64 48)"     # required
export PORT=5000
# export CORS_ORIGIN=https://erp.premiertubular.com   # only if front end is on another origin
node server.js
```
Or: docker compose up -d  ·  pm2 start ecosystem.config.js  ·  systemd unit premier-erp.service.

Always deploy behind HTTPS (nginx/Caddy reverse proxy or a PaaS with TLS).
HSTS is sent automatically in production.

## First run
1. Start the server — no accounts exist yet (GET /api/health -> "setup": false).
2. Create the administrator:
```bash
curl -X POST http://localhost:5000/api/auth/setup \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"za.khan@premiertubular.com\",\"name\":\"Zamir Ahmed Khan\",\"desig\":\"General Manager\",\"password\":\"<strong password>\"}"
```
3. Sign in and create users with their role + designation via /api/auth/register.

## API
| Route | Method | Access | Purpose |
|---|---|---|---|
| /api/health | GET | public | liveness + setup flag |
| /api/auth/setup | POST | public, first run only | create Administrator |
| /api/auth/login | POST | public (rate-limited) | sign in -> token |
| /api/auth/me | GET | signed in | current user |
| /api/auth/roles | GET | public | list of valid roles |
| /api/auth/register | POST | admin | create user (email, name, desig, role, password) |
| /api/auth/users | GET | admin | list users |
| /api/auth/users/:id/role | POST | admin | change role / designation |
| /api/auth/users/:id/password | POST | admin | reset password (invalidates their tokens) |
| /api/auth/users/:id/active | POST | admin | activate / deactivate |
| /api/auth/users/:id | DELETE | admin | delete user |
| /api/auth/change-password | POST | signed in | change own password |
| /api/records/:coll | GET/POST | role-checked | list / upsert records |
| /api/records/:coll/:id | DELETE | role-checked | delete record |
| /api/sync/push  /api/sync/pull | POST/GET | role-filtered | offline sync |
| /api/blobs/:key | GET/PUT | role-checked | GL / inspection library blobs |
| /api/dashboard | GET | signed in | KPI counts |
| /api/audit | GET | admin | last 500 audit entries |
| /api/backup | POST | admin | manual snapshot |

## Files
```
node-erp/
  server.js               the whole backend (single file, zero dependencies)
  public/                 premier-erp.html + index.html + erp-api-client.js
  Dockerfile, docker-compose.yml, ecosystem.config.js (pm2), premier-erp.service (systemd)
  data/                   created at runtime (JSON DB + backups/)
```
