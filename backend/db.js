/* ============================================================
   Premier ERP backend — MySQL connection pool.

   Deliberately points at the SAME database as iso-server-backend-PTIS
   (ptis_erp_db) so employees/departments/locations/logins are shared.
   This file only ever SELECTs from ISO's existing tables, or
   INSERT/UPDATEs into them using the exact columns ISO's own models
   already write (see routes/shared.js) — no schema changes are made
   here. All new storage this backend needs lives in its own
   erp_-prefixed tables created by migrate.js.
   ============================================================ */
'use strict';
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
