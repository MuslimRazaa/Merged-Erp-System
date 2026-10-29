/* ============================================================
   Notifications — the bell in the top bar.

   An inspector on a rig releases a report for approval and presses Sync
   now. The report reaches the server; the person they report to has to
   find out. "It is in the register somewhere" is not finding out, so a
   row is addressed to that person and counted on their screen until they
   have looked at it.

   The rows are written where the thing actually happened (records.js, on
   the push that released a record). This file only hands them back, and
   marks them read.

   Who gets what: a notification names its recipient, and these routes
   never read anybody else's. There is no "all notifications" here.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const row = (r) => ({
  id: r.id, kind: r.kind, module: r.module, recordId: r.record_id,
  title: r.title, body: r.body, at: r.created_at,
  read: !!r.read_at, actor: r.actor_name || null,
});

/* GET /api/notifications — this person's notices, newest first.
   ?unread=1 for only the ones they have not seen. */
router.get('/', async (req, res) => {
  const only = req.query.unread === '1' ? ' AND n.read_at IS NULL' : '';
  const [rows] = await pool.query(
    `SELECT n.*, a.full_name AS actor_name
       FROM erp_notifications n
       LEFT JOIN employees a ON a.id = n.actor_id
      WHERE n.recipient_id = ?${only}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 50`,
    [req.erpUser.id]
  );
  res.json(rows.map(row));
});

/* GET /api/notifications/count — for the badge, and for whether to show
   the bell at all. isHod says whether anyone reports to this person; the
   front end also uses it to decide who may be offered "Approved". */
router.get('/count', async (req, res) => {
  const [unread] = await pool.query(
    'SELECT COUNT(*) c FROM erp_notifications WHERE recipient_id = ? AND read_at IS NULL',
    [req.erpUser.id]
  );
  const [hod] = await pool.query(
    'SELECT COUNT(*) c FROM erp_employee_profile WHERE reports_to = ?', [req.erpUser.id]
  );
  res.json({ count: unread[0].c, isHod: hod[0].c > 0 });
});

/* POST /api/notifications/read — mark some, or all, as seen. Scoped to
   this person's own rows, so an id from somewhere else changes nothing. */
router.post('/read', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((n) => Number.isInteger(n)) : null;
  if (ids && ids.length) {
    await pool.query(
      'UPDATE erp_notifications SET read_at = NOW() WHERE recipient_id = ? AND read_at IS NULL AND id IN (?)',
      [req.erpUser.id, ids]
    );
  } else {
    await pool.query(
      'UPDATE erp_notifications SET read_at = NOW() WHERE recipient_id = ? AND read_at IS NULL',
      [req.erpUser.id]
    );
  }
  res.json({ ok: true });
});

module.exports = router;
