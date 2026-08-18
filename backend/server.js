/* ============================================================
   Premier ERP backend v3 — Express, MySQL-backed, shares the ISO/LMS
   database (ptis_erp_db) for logins/employees/departments/locations.

   Runs as its own process on its own port (PORT env, default 5050),
   completely separate from iso-server-backend-PTIS's process. It only
   talks to MySQL — never imports or requires anything from
   iso-server-backend-PTIS — so nothing here can crash or block ISO, and
   nothing here alters an ISO table's schema (see migrate.js).

   Routes:
     GET  /api/health
     /api/auth/*      -> routes/auth.js   (shared login against `employees`)
     /api/shared/*    -> routes/shared.js (employees / departments / locations)
     /api/sync/*  and  /sync/*  -> routes/sync.js (generic KV store the
                                    existing front-end sync engine expects)
   ============================================================ */
'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const migrate = require('./migrate');
const { router: authRouter } = require('./routes/auth');
const sharedRouter = require('./routes/shared');
const syncRouter = require('./routes/sync');

const PORT = +(process.env.PORT || 5050);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), node: process.version }));

app.use('/api/auth', authRouter);
app.use('/api/shared', sharedRouter);
app.use('/api/sync', syncRouter);
app.use('/sync', syncRouter); // alias — matches the front end's existing cfg.url + '/sync/pull' calls verbatim

// Serve the existing HTML/JS front end unchanged.
app.use(express.static(PUBLIC_DIR));

app.use((req, res) => res.status(404).json({ error: 'Unknown route.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error.' }); });

migrate()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Premier ERP backend v3 running at http://${HOST}:${PORT}`);
      console.log(`Sharing database "${process.env.DB_NAME}" with the ISO/LMS backend — read-only on employees/departments/locations except where explicitly noted in routes/shared.js.`);
    });
  })
  .catch((e) => { console.error('[FATAL] migration failed, not starting:', e.message); process.exit(1); });
