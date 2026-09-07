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
      phone_country       VARCHAR(5) NULL DEFAULT 'PK',
      phone_code          VARCHAR(10) NULL DEFAULT '+92',
      phone_number        VARCHAR(30) NULL,
      nic_number          VARCHAR(20) NULL,
      father_husband_name VARCHAR(150) NULL,
      spouse_name         VARCHAR(150) NULL,
      spouse_na           TINYINT(1) NULL DEFAULT 0,
      mother_name         VARCHAR(150) NULL,
      mother_na           TINYINT(1) NULL DEFAULT 0,
      date_of_birth       DATE NULL,
      emergency_country   VARCHAR(5) NULL DEFAULT 'PK',
      emergency_code      VARCHAR(10) NULL DEFAULT '+92',
      emergency_number    VARCHAR(30) NULL,
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
  // Contact / identity fields (phone with country code, NIC, family info, DOB) — idempotent add.
  const personalCols = [
    ["phone_country VARCHAR(5) NULL DEFAULT 'PK'", 'gender'],
    ["phone_code VARCHAR(10) NULL DEFAULT '+92'", 'phone_country'],
    ['phone_number VARCHAR(30) NULL', 'phone_code'],
    ['nic_number VARCHAR(20) NULL', 'phone_number'],
    ['father_husband_name VARCHAR(150) NULL', 'nic_number'],
    ['spouse_name VARCHAR(150) NULL', 'father_husband_name'],
    ['spouse_na TINYINT(1) NULL DEFAULT 0', 'spouse_name'],
    ['mother_name VARCHAR(150) NULL', 'spouse_na'],
    ['mother_na TINYINT(1) NULL DEFAULT 0', 'mother_name'],
    ['date_of_birth DATE NULL', 'mother_na'],
    ["emergency_country VARCHAR(5) NULL DEFAULT 'PK'", 'date_of_birth'],
    ["emergency_code VARCHAR(10) NULL DEFAULT '+92'", 'emergency_country'],
    ['emergency_number VARCHAR(30) NULL', 'emergency_code'],
  ];
  for (const [def, after] of personalCols) {
    try { await pool.query(`ALTER TABLE erp_employee_profile ADD COLUMN ${def} AFTER ${after}`); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }
  // Gross Salary is what HR now types in; basic/hra/utility_allowance are
  // derived from it (see EMP_SALARY_SPLIT in the frontend) and still stored
  // in their existing columns so nothing else that reads them breaks.
  // field_allowance's MEANING changes here too — it is no longer a flat
  // monthly amount, it's a PER-DAY rate multiplied by approved "Field
  // Shift" leave days (computed live, not stored) — same column, no ALTER
  // needed for that part.
  try { await pool.query("ALTER TABLE erp_employee_profile ADD COLUMN gross_salary DECIMAL(14,2) NULL AFTER salary"); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  // Employment Type — set once when the employee is created (Permanent /
  // Probation / Contractual / Part-time). Drives the Saturday weekly-off
  // quota in GET /api/attendance/summary: Permanent gets 2 free Saturdays a
  // month, everyone else (including blank/legacy rows) is treated as having
  // none — every Saturday counts as a normal working day for them unless a
  // leave covers it.
  try { await pool.query("ALTER TABLE erp_employee_profile ADD COLUMN employment_type VARCHAR(20) NULL AFTER designation"); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  // Leave Request / Field Duty module. One row per request; `employee_id` is
  // whose leave it is, `created_by` is who filled the form (an employee filing
  // their own leave, or HR/Admin filing on someone else's behalf — both are
  // the same `employees.id`). `requires_admin_approval` is set the moment a
  // *self-filed* request by an HR-tier employee is released for approval —
  // ordinary HR staff can then see it (read-only) but only an Administrator/
  // Sub Admin can act on it, so HR can't approve its own peers' leave.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_leave_requests (
      id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
      doc_no                  VARCHAR(30) NULL UNIQUE,
      employee_id             INT NOT NULL,
      created_by              INT NOT NULL,
      leave_request_type      VARCHAR(20) NOT NULL DEFAULT 'Full Day',
      leave_type              VARCHAR(40) NOT NULL,
      from_date               DATE NOT NULL,
      to_date                 DATE NOT NULL,
      request_date            DATE NOT NULL,
      purpose                 TEXT NULL,
      remarks                 TEXT NULL,
      status                  VARCHAR(30) NOT NULL DEFAULT 'InProcess',
      requires_admin_approval TINYINT(1) NOT NULL DEFAULT 0,
      hod_status              VARCHAR(30) NULL,
      hod_decided_by          INT NULL,
      hod_decided_at          TIMESTAMP NULL,
      hod_remarks             TEXT NULL,
      decided_by              INT NULL,
      decided_at              TIMESTAMP NULL,
      decision_remarks        TEXT NULL,
      created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_leave_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      CONSTRAINT fk_leave_created_by FOREIGN KEY (created_by) REFERENCES employees(id) ON DELETE CASCADE,
      INDEX idx_leave_employee (employee_id),
      INDEX idx_leave_status (status)
    )
  `);
  // erp_leave_requests may already exist from before decision_remarks was
  // added — idempotent add for that case.
  try { await pool.query('ALTER TABLE erp_leave_requests ADD COLUMN decision_remarks TEXT NULL AFTER decided_at'); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  // Two-stage approval: hod_status/hod_decided_by/hod_decided_at/hod_remarks
  // hold the HOD's own recommendation (a separate, non-final step) —
  // decided_by/decided_at/decision_remarks above are reserved for HR/Admin's
  // FINAL call, which is what actually becomes the request's `status` and
  // what the employee sees as the outcome. See routes/leave.js.
  const leaveCols = [
    ['hod_status VARCHAR(30) NULL', 'requires_admin_approval'],
    ['hod_decided_by INT NULL', 'hod_status'],
    ['hod_decided_at TIMESTAMP NULL', 'hod_decided_by'],
    ['hod_remarks TEXT NULL', 'hod_decided_at'],
  ];
  for (const [def, after] of leaveCols) {
    try { await pool.query(`ALTER TABLE erp_leave_requests ADD COLUMN ${def} AFTER ${after}`); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }

  // Employee loans — HR records a loan (principal + fixed monthly deduction);
  // payments (regular monthly deduction OR a one-off extra payment/waiver)
  // are logged in erp_loan_payments, and the remaining balance is always
  // principal_amount - SUM(payments) for that loan, never stored redundantly.
  // One employee can have more than one loan over time, but only one
  // 'Active' at once (enforced in routes/loans.js, not the schema).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_employee_loans (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id       INT NOT NULL,
      principal_amount  DECIMAL(14,2) NOT NULL,
      monthly_deduction DECIMAL(14,2) NOT NULL,
      currency          VARCHAR(10) NOT NULL DEFAULT 'AED',
      notes             VARCHAR(255) NULL,
      status            VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_by        INT NULL,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at         TIMESTAMP NULL,
      CONSTRAINT fk_loan_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      INDEX idx_loan_employee (employee_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_loan_payments (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      loan_id       BIGINT NOT NULL,
      amount        DECIMAL(14,2) NOT NULL,
      payment_type  VARCHAR(20) NOT NULL DEFAULT 'Monthly',
      payment_date  DATE NOT NULL,
      notes         VARCHAR(255) NULL,
      created_by    INT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_loanpay_loan FOREIGN KEY (loan_id) REFERENCES erp_employee_loans(id) ON DELETE CASCADE,
      INDEX idx_loanpay_loan (loan_id)
    )
  `);

  // HOD / reports-to — who this employee's leave requests route to for
  // approval (see GET/PUT in routes/leave.js). Nullable: an employee with no
  // HOD assigned keeps the original "any HR-access user decides" behaviour.
  try { await pool.query('ALTER TABLE erp_employee_profile ADD COLUMN reports_to INT NULL AFTER employment_type'); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  // Company holiday calendar — replaces manual/bulk attendance entry as the
  // way HR handles Sundays/holidays/one-off office closures: instead of
  // hand-filling attendance rows to paper over a gap, HR declares the date
  // itself as non-working here, and GET /api/attendance/summary applies it
  // to everyone automatically (no deduction, no punch required).
  // type: 'Gazetted' (known-in-advance public holiday), 'Islamic' (moon-
  // sighting dependent — Eid, Muharram — addable at short notice, same
  // effect as Gazetted), 'CompanyOff' (ad-hoc closure — fumigation, weather).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_holidays (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      holiday_date DATE NOT NULL UNIQUE,
      type        VARCHAR(20) NOT NULL DEFAULT 'Gazetted',
      name        VARCHAR(150) NOT NULL,
      created_by  INT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[erp-migrate] erp_kv_store, erp_employee_roles, erp_audit, erp_attendance_logs, erp_employee_shifts, erp_employee_profile, erp_leave_requests, erp_holidays, erp_employee_loans, erp_loan_payments ready (no ISO tables were altered).');
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[erp-migrate] failed:', e.message); process.exit(1); });
}
