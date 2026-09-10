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

  // CRM — Customers master list (brand-new ERP-only table; the old
  // localStorage-only "Customers" module is superseded by this, but its
  // data shape is mirrored back into localStorage by the frontend so the
  // still-localStorage Quotations/Sales Orders/Activities screens keep
  // working against the same names until they're migrated too).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_customers (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      code            VARCHAR(50) UNIQUE NOT NULL,
      name            VARCHAR(255) NOT NULL,
      contact_person  VARCHAR(150) NULL,
      email           VARCHAR(255) NULL,
      phone           VARCHAR(50) NULL,
      customer_type   VARCHAR(20) NOT NULL DEFAULT 'Customer',
      tax_reg_no      VARCHAR(100) NULL,
      payment_terms   VARCHAR(100) NULL,
      address         TEXT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_by      INT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  // Extended customer-intake fields (the "Business Partner" onboarding
  // form) — additive columns on top of the original set above. name/phone/
  // email/address/payment_terms are reused as Business Partner Name/
  // Mobile Number/Email/Address/Payment Terms respectively; everything
  // else here is new. bank_address_2 is the form's "Address 1" line — a
  // second line for the bank's address, not the customer's own address.
  for (const col of [
    'telephone_number VARCHAR(50) NULL',
    'country VARCHAR(100) NULL',
    'district VARCHAR(100) NULL',
    'city VARCHAR(100) NULL',
    'cnic VARCHAR(50) NULL',
    'ntn VARCHAR(50) NULL',
    'strn VARCHAR(50) NULL',
    'preferred_currency VARCHAR(10) NULL',
    'bank_name VARCHAR(150) NULL',
    'iban VARCHAR(50) NULL',
    'bank_address VARCHAR(255) NULL',
    'bank_address_2 VARCHAR(255) NULL',
    'bank_account_number VARCHAR(50) NULL',
    'account_type VARCHAR(50) NULL',
    'branch_code VARCHAR(50) NULL',
  ]) {
    try { await pool.query(`ALTER TABLE erp_crm_customers ADD COLUMN ${col}`); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }

  // CRM — RFQs. Every RFQ (however it actually arrived — call/email/PDF)
  // gets one fixed rfq_no the moment a Sales/CRM user enters it, and every
  // Quotation built against it (see erp_crm_rfqs.status) references this
  // row, so a Quotation always traces back to the RFQ (and its line items)
  // it was quoted from, no matter what the original document looked like.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_rfqs (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      rfq_no         VARCHAR(30) UNIQUE NULL,
      received_date  DATE NOT NULL,
      source         VARCHAR(20) NOT NULL DEFAULT 'Email',
      customer_id    INT NOT NULL,
      subject        VARCHAR(255) NULL,
      due_date       DATE NULL,
      status         VARCHAR(20) NOT NULL DEFAULT 'Open',
      notes          TEXT NULL,
      entered_by     INT NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_rfq_customer FOREIGN KEY (customer_id) REFERENCES erp_crm_customers(id),
      INDEX idx_rfq_customer (customer_id)
    )
  `);
  // One row per line item on an RFQ (multi-item RFQs — a single scope/qty
  // line still works fine as a one-item RFQ). scope: is this line actually
  // being quoted ('Scope') or explicitly excluded/flagged as not something
  // we're quoting for ('Out of Scope') — set per line, not per whole RFQ.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_rfq_items (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      rfq_id      INT NOT NULL,
      sort_order  INT NOT NULL DEFAULT 0,
      item_desc   VARCHAR(500) NOT NULL,
      qty         DECIMAL(14,2) NULL,
      unit        VARCHAR(30) NULL,
      spec        VARCHAR(500) NULL,
      scope       VARCHAR(20) NOT NULL DEFAULT 'Scope',
      CONSTRAINT fk_rfqitem_rfq FOREIGN KEY (rfq_id) REFERENCES erp_crm_rfqs(id) ON DELETE CASCADE,
      INDEX idx_rfqitem_rfq (rfq_id)
    )
  `);
  try { await pool.query("ALTER TABLE erp_crm_rfq_items ADD COLUMN scope VARCHAR(20) NOT NULL DEFAULT 'Scope' AFTER spec"); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  // RFQ attachments — the original email/PDF/scanned document, stored
  // as-is (base64 in, BLOB in DB, out again on download) so no separate
  // file-storage/CDN dependency is needed. Multiple per RFQ (an email body
  // plus its PDF attachment, say).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_rfq_attachments (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      rfq_id        INT NOT NULL,
      file_name     VARCHAR(255) NOT NULL,
      mime_type     VARCHAR(150) NULL,
      file_size     INT NOT NULL,
      file_data     LONGBLOB NOT NULL,
      uploaded_by   INT NULL,
      uploaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_rfqatt_rfq FOREIGN KEY (rfq_id) REFERENCES erp_crm_rfqs(id) ON DELETE CASCADE,
      INDEX idx_rfqatt_rfq (rfq_id)
    )
  `);

  // Service Catalogue reference data — Equipment -> Standards -> Item
  // Descriptions, a 3-level cascading hierarchy imported from the
  // company's inspection-services CSV (yellow/green/pink header groups —
  // see routes/crm.js's CSV parser for the exact layout). A Standard only
  // makes sense under its one Equipment, an Item Description only under
  // its one Standard — hence the nested FKs instead of one flat list.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_equipment (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL UNIQUE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_standards (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      equipment_id  INT NOT NULL,
      name          VARCHAR(255) NOT NULL,
      CONSTRAINT fk_std_equipment FOREIGN KEY (equipment_id) REFERENCES erp_crm_equipment(id) ON DELETE CASCADE,
      UNIQUE KEY uniq_std (equipment_id, name)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_item_descriptions (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      standard_id   INT NOT NULL,
      description   TEXT NOT NULL,
      CONSTRAINT fk_itemdesc_standard FOREIGN KEY (standard_id) REFERENCES erp_crm_standards(id) ON DELETE CASCADE,
      INDEX idx_itemdesc_standard (standard_id)
    )
  `);

  // Service Catalogue itself — one priced/quotable line, built by picking
  // an Equipment -> Standard -> Item Description off the reference data
  // above (equipment_id/standard_id kept too, not just item_description_id,
  // so the cascading selection can be reconstructed and re-edited later).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_services (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      code                  VARCHAR(50) UNIQUE NOT NULL,
      equipment_id          INT NULL,
      standard_id           INT NULL,
      item_description_id   INT NULL,
      uom                   VARCHAR(50) NULL,
      standard_rate         DECIMAL(14,2) NULL,
      currency              VARCHAR(10) NULL,
      min_qty               DECIMAL(14,2) NULL,
      status                VARCHAR(20) NOT NULL DEFAULT 'Active',
      created_by            INT NULL,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_equipment FOREIGN KEY (equipment_id) REFERENCES erp_crm_equipment(id),
      CONSTRAINT fk_svc_standard FOREIGN KEY (standard_id) REFERENCES erp_crm_standards(id),
      CONSTRAINT fk_svc_itemdesc FOREIGN KEY (item_description_id) REFERENCES erp_crm_item_descriptions(id)
    )
  `);

  // Quotations — always created against an RFQ (rfq_id), one RFQ can have
  // several over time (revision). The quotation-document fields (service
  // type on the cover page, attention name, subject, client's own PO/ref
  // number, SRB %, and the two editable terms pages) all live here; the
  // priced lines are in erp_crm_quotation_items. See routes/crm.js's
  // combined "RFQ + Quotation" create.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_quotations (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      quotation_no         VARCHAR(30) UNIQUE NULL,
      rfq_id               INT NOT NULL,
      revision             INT NOT NULL DEFAULT 0,
      quotation_date       DATE NOT NULL,
      service_type         VARCHAR(100) NULL,
      client_reference_no  VARCHAR(150) NULL,
      attention_name       VARCHAR(150) NULL,
      subject              VARCHAR(255) NULL,
      currency             VARCHAR(10) NOT NULL DEFAULT 'PKR',
      srb_percent          DECIMAL(6,2) NOT NULL DEFAULT 15.00,
      terms_page4          TEXT NULL,
      terms_page5          TEXT NULL,
      status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
      created_by           INT NULL,
      created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_qtn_rfq FOREIGN KEY (rfq_id) REFERENCES erp_crm_rfqs(id) ON DELETE CASCADE,
      INDEX idx_qtn_rfq (rfq_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_quotation_items (
      id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
      quotation_id         INT NOT NULL,
      sort_order           INT NOT NULL DEFAULT 0,
      equipment_id         INT NULL,
      standard_id          INT NULL,
      item_description_id  INT NULL,
      size                 VARCHAR(120) NULL,
      unit                 VARCHAR(50) NULL,
      qty                  DECIMAL(14,2) NULL,
      rate                 DECIMAL(14,2) NULL,
      CONSTRAINT fk_qtnitem_qtn FOREIGN KEY (quotation_id) REFERENCES erp_crm_quotations(id) ON DELETE CASCADE,
      INDEX idx_qtnitem_qtn (quotation_id)
    )
  `);

  // Soft delete for RFQs/Quotations — a delete moves the record (and its
  // linked counterpart) to the Recycle Bin (deleted_at set) instead of
  // dropping it; the Recycle Bin screen restores or purges.
  for (const [table, col] of [
    ['erp_crm_rfqs', 'deleted_at TIMESTAMP NULL'],
    ['erp_crm_quotations', 'deleted_at TIMESTAMP NULL'],
    ['erp_crm_quotation_items', 'spec VARCHAR(500) NULL'],
    ['erp_crm_quotation_items', "scope VARCHAR(20) NULL"],
  ]) {
    try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col}`); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }

  // One-row CRM config: the running Client Reference No. counter (auto
  // numbering like FOT-100926-1190 -> 1191 -> ...) and the single shared
  // Quotation terms block (rich HTML, edited once, used on every
  // quotation PDF).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_crm_config (
      id                    TINYINT PRIMARY KEY,
      last_client_ref       VARCHAR(100) NULL,
      quotation_terms_html  MEDIUMTEXT NULL,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query('INSERT IGNORE INTO erp_crm_config (id) VALUES (1)');

  console.log('[erp-migrate] erp_kv_store, erp_employee_roles, erp_audit, erp_attendance_logs, erp_employee_shifts, erp_employee_profile, erp_leave_requests, erp_holidays, erp_employee_loans, erp_loan_payments, erp_crm_customers, erp_crm_rfqs, erp_crm_rfq_items, erp_crm_rfq_attachments, erp_crm_equipment, erp_crm_standards, erp_crm_item_descriptions, erp_crm_services, erp_crm_quotations, erp_crm_quotation_items, erp_crm_config ready (no ISO tables were altered).');
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[erp-migrate] failed:', e.message); process.exit(1); });
}
