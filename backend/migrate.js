/* ============================================================
   Premier ERP — additive-only migration.

   IMPORTANT: this script never runs ALTER TABLE / DROP on anything that
   belongs to the ISO/LMS backend (employees, departments, locations, ...).
   It only CREATE TABLE IF NOT EXISTS's brand-new erp_-prefixed tables that
   nothing else in the codebase knows about, so iso-server-backend-PTIS is
   guaranteed to be unaffected by running (or re-running) this.

   Safe to run any number of times.
   ============================================================ */
'use strict';
const pool = require('./db');

async function migrate() {
  // Generic key/value store — backs the ERP front end's existing offline
  // sync engine (public/index.html's syncNow(), which POSTs {keys:{...}})
  // for every ERP-only module (CRM, Sales, Inventory, Procurement, Fixed
  // Assets, Compliance, Accounting, Inspection). Replaces the old
  // JSON-file storage in erp-ptis-complete/server.js with real MySQL rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_kv_store (
      \`key\`       VARCHAR(190) PRIMARY KEY,
      value         LONGTEXT,
      ts            BIGINT NOT NULL,
      updated_by    VARCHAR(255) NULL,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Grants an ISO employee access to the ERP and which ERP role they hold.
  // Deliberately a NEW table (not a column on `employees`) so the shared
  // `employees` table's schema is never touched by ERP work.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_employee_roles (
      employee_id   INT PRIMARY KEY,
      role          VARCHAR(50) NOT NULL,
      desig         VARCHAR(120) NULL,
      active        TINYINT(1) NOT NULL DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_erp_employee_roles_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE CASCADE
    )
  `);

  // ERP-side audit trail (mirrors what erp-ptis-complete/server.js used to
  // keep in data/audit.json).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_audit (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      by_employee   VARCHAR(255) NULL,
      action        VARCHAR(100) NOT NULL,
      target        VARCHAR(500) NULL,
      INDEX idx_erp_audit_at (at)
    )
  `);

  // Raw punches pushed by the ZKTeco K70 polling agent (attendance-agent/,
  // running on the office VM). device_user_id is matched against
  // employees.employee_id (employees are enrolled on the device using the
  // same ID) — employee_id is filled in at ingest time when it matches, so
  // rows with no match are still kept (visible as "unmapped" in the UI)
  // instead of silently dropped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_attendance_logs (
      id               BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_user_id   VARCHAR(50) NOT NULL,
      device_user_name VARCHAR(255) NULL,
      employee_id      INT NULL,
      punch_time       DATETIME NOT NULL,
      verify_mode      INT NULL,
      in_out_mode      INT NULL,
      source           VARCHAR(50) NOT NULL DEFAULT 'zkteco-k70',
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_punch (device_user_id, punch_time),
      INDEX idx_attendance_employee (employee_id, punch_time),
      INDEX idx_attendance_time (punch_time)
    )
  `);
  // Additive column for tables created before device_user_name existed —
  // idempotent, same pattern iso-server-backend-PTIS's own migrate-add-*
  // scripts use.
  try { await pool.query('ALTER TABLE erp_attendance_logs ADD COLUMN device_user_name VARCHAR(255) NULL AFTER device_user_id'); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  // Per-employee shift start time, for "Late" calculation on the
  // Attendance screen. Same additive-table pattern as erp_employee_roles —
  // no column added to `employees`. Missing row = default 09:00 + 15 min
  // grace (i.e. late after 09:15), same as the company-wide default.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_employee_shifts (
      employee_id    INT PRIMARY KEY,
      shift_start    TIME NOT NULL DEFAULT '09:00:00',
      grace_minutes  INT NOT NULL DEFAULT 15,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_erp_employee_shifts_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE CASCADE
    )
  `);

  // role used to only ever hold one of the 9 named presets (fits
  // VARCHAR(50)) — the Employees form now also allows picking a raw
  // comma-separated list of modules directly, which can run longer.
  try { await pool.query('ALTER TABLE erp_employee_roles MODIFY COLUMN role VARCHAR(255) NOT NULL'); }
  catch (e) { console.warn('[erp-migrate] could not widen erp_employee_roles.role (non-fatal):', e.message); }

  // Shift end time, alongside the existing shift_start — additive column
  // on ERP's own table, not on `employees`.
  try { await pool.query("ALTER TABLE erp_employee_shifts ADD COLUMN shift_end TIME NULL AFTER shift_start"); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  // Everything the HR "Employee" form asks for that has no home anywhere
  // else: personal details, bank info, reference and next-of-kin, plus
  // salary (moved here from the old browser-only localStorage copy so it's
  // an actual queryable/backed-up DB column instead of an opaque blob).
  // One row per employee, all optional. Brand-new ERP-only table — no ISO
  // table is touched.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_employee_profile (
      employee_id        INT PRIMARY KEY,
      first_name          VARCHAR(120) NULL,
      last_name           VARCHAR(120) NULL,
      designation         VARCHAR(150) NULL,
      gender              VARCHAR(20) NULL,
      marital_status      VARCHAR(20) NULL,
      cost_center         VARCHAR(100) NULL,
      join_date           DATE NULL,
      job_end_date        DATE NULL,
      nationality         VARCHAR(100) NULL,
      visa_number         VARCHAR(100) NULL,
      visa_expiry         DATE NULL,
      home_address        TEXT NULL,
      mailing_address     TEXT NULL,
      bank_name           VARCHAR(100) NULL,
      iban                VARCHAR(50) NULL,
      account_no          VARCHAR(50) NULL,
      account_title       VARCHAR(150) NULL,
      blood_group         VARCHAR(10) NULL,
      appraisal_date      DATE NULL,
      confirmation_date   DATE NULL,
      rejoin_date         DATE NULL,
      rejoin_reason       TEXT NULL,
      ref_name            VARCHAR(150) NULL,
      ref_contact         VARCHAR(50) NULL,
      ref_email           VARCHAR(150) NULL,
      ref_office          VARCHAR(150) NULL,
      kin_name            VARCHAR(150) NULL,
      kin_relation        VARCHAR(50) NULL,
      kin_contact         VARCHAR(50) NULL,
      kin_nic             VARCHAR(50) NULL,
      kin_email           VARCHAR(150) NULL,
      salary              DECIMAL(14,2) NULL,
      utility_allowance   DECIMAL(14,2) NULL,
      hra                 DECIMAL(14,2) NULL,
      field_allowance     DECIMAL(14,2) NULL,
      currency            VARCHAR(10) NULL DEFAULT 'AED',
      updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_erp_employee_profile_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE CASCADE
    )
  `);
  // join_date / designation were added after the table may have already existed elsewhere — idempotent add.
  try { await pool.query('ALTER TABLE erp_employee_profile ADD COLUMN join_date DATE NULL AFTER cost_center'); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try { await pool.query('ALTER TABLE erp_employee_profile ADD COLUMN designation VARCHAR(150) NULL AFTER last_name'); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  console.log('[erp-migrate] erp_kv_store, erp_employee_roles, erp_audit, erp_attendance_logs, erp_employee_shifts, erp_employee_profile ready (no ISO tables were altered).');
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[erp-migrate] failed:', e.message); process.exit(1); });
}
