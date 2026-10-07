/* ============================================================
   Patches a real bug in node-zklib@1.3.x (zklibtcp.js, readWithBuffer()):
   when the device doesn't answer in time, it does
     try { reply = await this.requestData(buf) }
     catch (err) { reject(err) }          // <- no `return` here
     const header = decodeTCPHeader(reply.subarray(0, 16))   // reply is still null
   `reject(err)` does NOT stop execution, so the next line always runs too —
   crashing the whole agent process with "Cannot read properties of null
   (reading 'subarray')" on every device timeout, instead of just letting
   the already-rejected promise (which readWithBuffer's caller already
   handles via pollOnce's try/catch) report the timeout and retry next poll.

   node_modules gets wiped and recreated by every `npm install`, so the fix
   has to be re-applied automatically — see the "postinstall" script in
   package.json, which runs this file after every install.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'node_modules', 'node-zklib', 'zklibtcp.js');
// node-zklib ships this file with CRLF line endings — match either, and
// write back whichever line ending the file already used.
const BROKEN_RE = /(\}\s*catch\s*\(err\)\s*\{\r?\n\s*reject\(err\)\r?\n)(\s*\}\r?\n\r?\n\s*const header = decodeTCPHeader\(reply\.subarray\(0, 16\)\))/;

if (!fs.existsSync(FILE)) {
  console.warn('[patch-node-zklib] node_modules/node-zklib/zklibtcp.js not found — nothing to patch (run npm install first).');
  process.exit(0);
}

const src = fs.readFileSync(FILE, 'utf8');
if (/reject\(err\)\r?\n\s*return\r?\n\s*\}\r?\n\r?\n\s*const header = decodeTCPHeader/.test(src)) {
  console.log('[patch-node-zklib] Already patched.');
} else if (BROKEN_RE.test(src)) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const patched = src.replace(BROKEN_RE, (m, p1, p2) => p1 + '        return' + nl + p2);
  fs.writeFileSync(FILE, patched);
  console.log('[patch-node-zklib] Patched readWithBuffer() — a device timeout no longer crashes the agent.');
} else {
  console.warn('[patch-node-zklib] Expected code not found (node-zklib version changed?) — skipping, please re-check this patch still applies.');
}
