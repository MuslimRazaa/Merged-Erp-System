# ERP ↔ ISO database integration — what changed

## Summary
The ERP now shares the ISO/LMS backend's MySQL database (`ptis_erp_db`,
`iso-server-backend-PTIS/.env`) instead of the old flat-JSON-file store.
It runs as its **own Express process** on its **own port** (`5050` by
default) — it does not import, require, or share a process with
`iso-server-backend-PTIS`, so nothing here can crash or slow down ISO.

**Zero ISO impact, verified:** this backend never runs `ALTER TABLE` /
`DROP` on any table ISO owns. `migrate.js` only creates three brand-new
`erp_`-prefixed tables. `employees`/`departments`/`locations` are read (and,
for departments/locations, written) using the exact same columns ISO's own
models already use. Tested live against the real local database — inserted
temporary test rows, verified full login/sync/shared-data flow end to end,
then deleted the test rows and re-confirmed `employees` (4 rows) and
`departments` (2 rows) were back to their exact original state.

## What's shared now
| Data | How |
|---|---|
| **Logins** | ERP's `/api/auth/login` checks the same `employees.employee_id` + bcrypt `password` ISO uses. One password, both apps. |
| **Employees** | `GET/POST/PUT /api/shared/employees` reads/writes the same `employees` rows (name, department, location, status only — ISO's own permission flags like `lms_access` etc. are left alone so the two apps never fight over access control). The ERP front end's HR module now pulls these in automatically after login/sync (matched by Employee ID) without erasing ERP-only fields like salary/passport/shift. |
| **Departments / Locations** | `GET/POST/DELETE /api/shared/departments` and `/locations` — same tables ISO's Department/Location models use. Edits from either app show up in both (as requested). The ERP HR module's Department field is now a dropdown fed from this shared list instead of free text. |
| **ERP role access** | New table `erp_employee_roles` (employee_id → ERP role). An ISO employee has no ERP access until an ERP Administrator grants one on the "Users & Roles" screen — no separate ERP-only accounts exist anymore. |
| **ERP module data** (CRM, Sales, Inventory, Procurement, Fixed Assets, Compliance, Accounting, Inspection) | Still ERP-only — no ISO equivalent exists for these. Now stored in MySQL (`erp_kv_store`) instead of JSON files, via the exact `{keys:{...}}` sync contract the shipped front end (`public/index.html`) already called — that contract was previously mismatched against the old `server.js`, so sync silently did nothing before. It now actually works. |

## Running it
```bash
cd erp-ptis-complete/backend
npm install
npm run migrate   # idempotent, safe to re-run
npm start         # http://localhost:5050 — serves the API AND the existing public/ front end
```
Edit `.env` for `DB_*`, `JWT_KEY` (set a real random value in production),
`PORT`, and `CORS_ORIGIN` (needed once the ERP front end moves to its own
separate domain and calls this API cross-origin).

## First run
No ERP Administrator exists yet. Open the app, the login screen shows a
"claim administrator" form — sign in with **any existing ISO/LMS employee's
Employee ID + password** to become the first ERP Administrator. From there,
use **Users & Roles** to grant ERP roles to other existing employees.

## Still outstanding (next steps, not done in this pass)
- The old `erp-ptis-complete/server.js` (root), `Dockerfile`,
  `docker-compose.yml`, `ecosystem.config.js`, `premier-erp.service` still
  point at the OLD JSON-file backend. They need to be swapped to point at
  `backend/server.js` before deploying for real — left alone for now since
  deployment/domain setup was explicitly parked for later.
- Employee create/edit from the ERP side only touches
  name/department/location/status — nothing else in `employees` (by
  design, to not collide with ISO's access-control columns). If richer
  two-way HR sync is wanted later (e.g. shift/salary flowing to ISO), that
  needs its own decision since ISO has no columns for those today.
- No automated tests yet — this was verified manually against the live
  local database plus a Node syntax check on the front end's inline JS.
  A real browser click-through pass is worth doing before this goes to
  users.
