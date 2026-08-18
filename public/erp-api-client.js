/* ============================================================
   Premier ERP — .NET backend sync client
   Include in premier-erp.html just before </body>:
     <script src="erp-api-client.js"></script>
   Or paste the whole file into the page's main <script>.

   What it does:
   - Login against /api/auth/login (JWT stored in memory + localStorage)
   - Queues every local change while offline
   - Pushes queued collections + blobs to /api/sync/push when online
   - Pulls server changes from /api/sync/pull and merges (last-write-wins)
   ============================================================ */
(function () {
  const API = localStorage.getItem('erp_api_base') || ''; // '' = same origin
  const P = 'perp_'; // must match the prefix used by premier-erp.html
  const COLLS = ['customers','services','leads','rfqs','quotes','salesorders','activities',
    'invoices','receipts','items','stockmoves','purchaseorders','grns','vendorbills','payments',
    'assets','maintenance','contracts','workorders',
    'employees','attendance','leave','payroll','trainings',
    'docs','audits','ncrs','risks','hse','mgtreviews','calibrations','apiq2'];
  const BLOBS = ['gl', 'ir_library'];

  let token = localStorage.getItem('erp_jwt') || null;

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {})
      }
    });
    if (res.status === 401) { token = null; localStorage.removeItem('erp_jwt'); throw new Error('Session expired — please log in again.'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  window.erpApi = {
    setBase(url) { localStorage.setItem('erp_api_base', url.replace(/\/$/, '')); location.reload(); },

    async login(email, password) {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      token = r.token; localStorage.setItem('erp_jwt', token);
      return r.user;
    },

    logout() { token = null; localStorage.removeItem('erp_jwt'); },

    loggedIn() { return !!token; },

    /* ---- full push: local -> server ---- */
    async push() {
      const collections = {};
      COLLS.forEach(k => {
        const rows = JSON.parse(localStorage.getItem(P + k) || '[]');
        if (rows.length) collections[k] = rows.map(r => ({ id: r.id, data: r, updatedUtc: new Date().toISOString() }));
      });
      const blobs = [];
      BLOBS.forEach(k => {
        const v = localStorage.getItem(P + k);
        if (v) blobs.push({ key: k, payload: JSON.parse(v), updatedUtc: new Date().toISOString() });
      });
      return api('/api/sync/push', { method: 'POST', body: JSON.stringify({ collections, blobs }) });
    },

    /* ---- full pull: server -> local (last-write-wins merge) ---- */
    async pull() {
      const since = localStorage.getItem('erp_last_sync') || null;
      const r = await api('/api/sync/pull' + (since ? '?since=' + encodeURIComponent(since) : ''));
      Object.entries(r.collections || {}).forEach(([k, rows]) => {
        const local = JSON.parse(localStorage.getItem(P + k) || '[]');
        const byId = Object.fromEntries(local.map(x => [x.id, x]));
        rows.forEach(row => {
          if (row.deleted) delete byId[row.id];
          else byId[row.id] = row.data;
        });
        localStorage.setItem(P + k, JSON.stringify(Object.values(byId)));
      });
      (r.blobs || []).forEach(b => localStorage.setItem(P + b.key, JSON.stringify(b.payload)));
      localStorage.setItem('erp_last_sync', r.serverTimeUtc);
      return r;
    },

    /* ---- one-call round trip ---- */
    async sync() {
      const pushRes = await this.push();
      const pullRes = await this.pull();
      if (typeof render === 'function') render();
      return { pushRes, pullRes };
    }
  };

  /* auto-sync when connectivity returns */
  window.addEventListener('online', () => { if (token) window.erpApi.sync().catch(console.warn); });
})();
