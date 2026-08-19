# Attendance Agent — setup on the office Windows VM

Bridges the ZKTeco K70 (office LAN, `192.168.30.64:4370`, no cloud/ADMS) to
the Premier ERP backend. Runs only on this VM — never on cPanel, and never
exposes the K70 to the internet.

## 1. Install Node.js on the VM
Download the **LTS** installer from https://nodejs.org and run it (Windows
installer, default options are fine). Confirm in PowerShell:
```powershell
node -v
```

## 2. Copy this folder to the VM
Copy the whole `attendance-agent/` folder to somewhere permanent on the VM,
e.g. `C:\erp-attendance-agent\`.

## 3. Configure
```powershell
cd C:\erp-attendance-agent
copy .env.example .env
notepad .env
```
Fill in:
- `DEVICE_IP` / `DEVICE_PORT` — already set correctly for the K70 (`192.168.30.64:4370`)
- `BACKEND_URL` — the ERP backend's URL, e.g. `https://erp.ptis.co`
- `AGENT_KEY` — must be the **exact same value** as `ATTENDANCE_AGENT_KEY` in
  `backend/.env` (or the cPanel Node.js App's environment variables once deployed there)

## 4. Install dependencies and test it once, manually
```powershell
npm install
node agent.js
```
You should see it connect to the K70 and log either "No new punches" or
"First run — baseline set to ...". Ask someone to punch the K70, wait one
poll interval (default 20s), and confirm a "Pushed 1 punch(es)" line
appears. Press `Ctrl+C` to stop this manual test run once confirmed.

## 5. Install as a Windows Service (so it survives reboots)
Using [NSSM](https://nssm.cc/download) (free, the standard way to run a
Node script as a Windows Service):

1. Download NSSM, extract it, e.g. to `C:\nssm\`.
2. Open PowerShell **as Administrator**:
   ```powershell
   cd C:\nssm\win64
   .\nssm.exe install ERP-Attendance-Agent
   ```
3. A GUI opens:
   - **Path**: `C:\Program Files\nodejs\node.exe` (wherever `node.exe` actually is — check with `(Get-Command node).Source`)
   - **Startup directory**: `C:\erp-attendance-agent`
   - **Arguments**: `agent.js`
   - Go to the **Details** tab, set a description if you like.
   - Go to the **I/O** tab and set stdout/stderr log files (e.g.
     `C:\erp-attendance-agent\agent.log`) so you can check what it's doing later.
   - Click **Install service**.
4. Start it:
   ```powershell
   nssm start ERP-Attendance-Agent
   ```
5. Confirm it's running:
   ```powershell
   Get-Service ERP-Attendance-Agent
   ```
   It will now start automatically on every VM reboot, with no manual steps.

## Updating later
```powershell
nssm stop ERP-Attendance-Agent
# replace agent.js / pull latest code
nssm start ERP-Attendance-Agent
```

## Uninstalling
```powershell
nssm stop ERP-Attendance-Agent
nssm remove ERP-Attendance-Agent confirm
```

## Notes
- `state.json` (created automatically next to `agent.js`) remembers the
  last punch time already sent, so restarting the agent never re-sends
  everything — it only ever asks the backend to save what's new (and the
  backend itself also de-duplicates, as a second safety net).
- On the very first run, existing history already stored on the K70 is
  **not** imported by default (to avoid flooding the backend on day one).
  To import full history once, set `BACKFILL_ALL=true` in `.env`, delete
  `state.json` if it exists, and run the agent once.
- Employees must be enrolled on the K70 using the **same ID** as their
  `employee_id` in the ERP/ISO system (e.g. `1878`) — that's how a punch
  gets matched to the right person. A punch from an unrecognised ID still
  gets saved (visible as "Unmapped" in the ERP), it just isn't linked to
  anyone until the ID matches.
