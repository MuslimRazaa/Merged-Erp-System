/* ============================================================
   ERP Attendance Agent — bridges a ZKTeco K70 (office LAN only, no cloud)
   to the Premier ERP backend (internet-hosted).

   Runs on the office VM (same LAN as the K70), NOT on cPanel. Every
   POLL_INTERVAL_SECONDS it:
     1. connects to the K70 over the LAN (node-zklib, TCP port 4370)
     2. reads all punches currently stored on the device
     3. keeps only the ones newer than the last successful sync
        (state.json, next to this file)
     4. POSTs those to the ERP backend's /api/attendance/ingest
     5. only advances the "last synced" mark once the backend confirms —
        so a failed request is retried next poll instead of losing data

   The K70 is never exposed to the internet; only this agent talks to it,
   and only over the office LAN. See README-SETUP.md for how to install
   this as a Windows Service so it survives reboots.
   ============================================================ */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ZKLib = require('node-zklib');

const DEVICE_IP = process.env.DEVICE_IP || '192.168.30.64';
const DEVICE_PORT = +(process.env.DEVICE_PORT || 4370);
const POLL_INTERVAL_MS = Math.max(5, +(process.env.POLL_INTERVAL_SECONDS || 20)) * 1000;
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';
const BACKFILL_ALL = String(process.env.BACKFILL_ALL || '').toLowerCase() === 'true';

if (!BACKEND_URL || !AGENT_KEY) {
  console.error('[FATAL] BACKEND_URL and AGENT_KEY must be set in .env (see .env.example).');
  process.exit(1);
}

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { lastSyncTime: null }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function pollOnce(state) {
  const zk = new ZKLib(DEVICE_IP, DEVICE_PORT, 10000, 4000);
  try {
    await zk.createSocket();
  } catch (e) {
    log(`Could not reach the K70 at ${DEVICE_IP}:${DEVICE_PORT} — ${e.message}. Will retry next poll.`);
    return;
  }

  try {
    const { data: records, err } = await zk.getAttendances();
    if (err) log(`Device reported a partial-read warning: ${err.message || err}`);

    // First-ever run: establish a baseline instead of flooding the backend
    // with the device's entire history (unless BACKFILL_ALL=true).
    if (!state.lastSyncTime && !BACKFILL_ALL) {
      const latest = records.reduce((max, r) => (r.recordTime > max ? r.recordTime : max), new Date(0));
      state.lastSyncTime = (records.length ? latest : new Date()).toISOString();
      saveState(state);
      log(`First run — baseline set to ${state.lastSyncTime} (existing ${records.length} punches on the device were NOT imported). Set BACKFILL_ALL=true and delete state.json to import full history instead.`);
      return;
    }

    const since = state.lastSyncTime ? new Date(state.lastSyncTime) : new Date(0);
    const fresh = records.filter((r) => r.recordTime > since);
    if (!fresh.length) { log(`No new punches (device has ${records.length} total).`); return; }

    const punches = fresh.map((r) => ({
      deviceUserId: r.deviceUserId,
      timestamp: r.recordTime.toISOString(),
    }));

    const res = await fetch(`${BACKEND_URL}/api/attendance/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_KEY },
      body: JSON.stringify({ punches }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { log(`Backend rejected the push (HTTP ${res.status}): ${body.error || res.statusText}. Will retry next poll.`); return; }

    const latest = fresh.reduce((max, r) => (r.recordTime > max ? r.recordTime : max), since);
    state.lastSyncTime = latest.toISOString();
    saveState(state);
    log(`Pushed ${fresh.length} punch(es) — saved=${body.saved} skipped(duplicates)=${body.skipped}.`);
  } catch (e) {
    log(`Poll failed: ${e.message}. Will retry next poll.`);
  } finally {
    try { await zk.disconnect(); } catch (e) { /* already gone */ }
  }
}

async function loop() {
  const state = loadState();
  await pollOnce(state);
  setTimeout(loop, POLL_INTERVAL_MS);
}

log(`ERP Attendance Agent starting — device ${DEVICE_IP}:${DEVICE_PORT}, backend ${BACKEND_URL}, polling every ${POLL_INTERVAL_MS / 1000}s.`);
loop();
