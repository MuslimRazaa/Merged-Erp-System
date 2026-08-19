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
      id             BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_user_id VARCHAR(50) NOT NULL,
      employee_id    INT NULL,
      punch_time     DATETIME NOT NULL,
      verify_mode    INT NULL,
      in_out_mode    INT NULL,
      source         VARCHAR(50) NOT NULL DEFAULT 'zkteco-k70',
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_punch (device_user_id, punch_time),
      INDEX idx_attendance_employee (employee_id, punch_time),
      INDEX idx_attendance_time (punch_time)
    )
  `);

  console.log('[erp-migrate] erp_kv_store, erp_employee_roles, erp_audit, erp_attendance_logs ready (no ISO tables were altered).');
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[erp-migrate] failed:', e.message); process.exit(1); });
}
