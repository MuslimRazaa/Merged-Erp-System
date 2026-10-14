const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1366, height: 900 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  await page.goto('http://localhost:5050/', { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    applySession({ token: 'zztest-fake-token', user: { id: 999999, employeeId: 'ZZTEST', name: 'ZZTEST User', role: 'Administrator', desig: '' } });
  });
  await new Promise(r => setTimeout(r, 300));

  function hitTestPanel(selector, pg) {
    pg = pg || page;
    return pg.evaluate((sel) => {
      const pan = document.querySelector(sel);
      if (!pan) return { found: false };
      const r = pan.getBoundingClientRect();
      const midX = r.left + r.width / 2;
      const midY = r.top + Math.min(r.height - 5, 40);
      const hit = document.elementFromPoint(midX, midY);
      return {
        found: true,
        hitIsInsidePanel: !!(hit && pan.contains(hit)),
        position: getComputedStyle(pan).position,
        zIndex: getComputedStyle(pan).zIndex,
        rect: { top: r.top, left: r.left, bottom: r.bottom, width: r.width, height: r.height },
        withinViewportY: r.top >= 0 && r.bottom <= window.innerHeight
      };
    }, selector);
  }

  // --- Test 1: EXACT reported scenario — fresh PO form, row 1, Item dropdown ---
  await page.evaluate(() => go('m_purchaseorders'));
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => { document.querySelector('#selx-po-item-0 .selx-btn').click(); });
  await new Promise(r => setTimeout(r, 100));
  const t1 = await hitTestPanel('#selx-po-item-0 .selx-pan');
  console.log('Test 1 — PO row 1 Item dropdown (the reported bug):', JSON.stringify(t1, null, 2));
  await page.evaluate(() => document.querySelectorAll('.selx.open').forEach(e => e.classList.remove('open')));

  // --- Test 2: dropdown opened INSIDE a modal still renders above the modal backdrop ---
  await page.evaluate(() => go('m_items'));
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => {
    document.getElementById('f-name').value = 'ZZTEST Modal Dropdown Item';
    selxPick('f-cat', 'Tool');
    selxPick('f-unit', 'EA');
    saveRec();
  });
  const modalTest = await page.evaluate(() => {
    const rec = coll('items').find(r => r.name === 'ZZTEST Modal Dropdown Item');
    editRecModal(rec.id);
    return { modalOpen: document.getElementById('recimodal').classList.contains('open'), id: rec.id };
  });
  await new Promise(r => setTimeout(r, 150));
  await page.evaluate(() => { document.querySelector('#selx-mf-cat .selx-btn').click(); });
  await new Promise(r => setTimeout(r, 100));
  const t2 = await hitTestPanel('#selx-mf-cat .selx-pan');
  console.log('Test 2 — dropdown inside edit modal (must clear modal backdrop):', JSON.stringify({ modalTest, t2 }, null, 2));
  await page.evaluate(() => { closeModal('recimodal'); document.querySelectorAll('.selx.open').forEach(e => e.classList.remove('open')); });

  // --- Test 3: flip-up still works for a row near the bottom of a short viewport ---
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1366, height: 700 });
  await page2.goto('http://localhost:5050/', { waitUntil: 'networkidle2' });
  await page2.evaluate(() => {
    applySession({ token: 'zztest-fake-token', user: { id: 999999, employeeId: 'ZZTEST', name: 'ZZTEST User', role: 'Administrator', desig: '' } });
  });
  await new Promise(r => setTimeout(r, 300));
  await page2.evaluate(() => go('m_purchaseorders'));
  await new Promise(r => setTimeout(r, 200));
  await page2.evaluate(() => { for (let n = 0; n < 8; n++) POL.push({}); poRefresh(); });
  // Realistic flow: a real user can only click a button that's actually on
  // screen, so scroll it into view first (as a human would have to) rather
  // than reaching it blind via the DOM — then check whether it sits close
  // enough to the bottom edge for the flip-up logic to matter.
  const lastIdxInfo = await page2.evaluate(() => {
    const lastIdx = POL.length - 1;
    const btn = document.querySelector('#selx-po-item-' + lastIdx + ' .selx-btn');
    btn.scrollIntoView({ block: 'end' });
    const r = btn.getBoundingClientRect();
    btn.click();
    return { lastIdx, spaceBelow: window.innerHeight - r.bottom, spaceAbove: r.top };
  });
  await new Promise(r => setTimeout(r, 100));
  const t3 = await hitTestPanel('#selx-po-item-' + lastIdxInfo.lastIdx + ' .selx-pan', page2);
  console.log('Test 3 — flip-up, realistic (button scrolled to bottom edge, spaceBelow=' + lastIdxInfo.spaceBelow + ', spaceAbove=' + lastIdxInfo.spaceAbove + '):', JSON.stringify(t3, null, 2));

  // --- Test 3b: the unrealistic "button fully off-screen" edge case — the new
  //     safety clamp should still keep the panel on-screen rather than lost ---
  const t3b_setup = await page2.evaluate(() => {
    document.querySelectorAll('.selx.open').forEach(e => { e.classList.remove('open'); const p = e.querySelector('.selx-pan'); if (p) p.style.cssText = ''; });
    window.scrollTo(0, 0);
    const lastIdx = POL.length - 1;
    const btn = document.querySelector('#selx-po-item-' + lastIdx + ' .selx-btn');
    const r = btn.getBoundingClientRect();
    btn.click();
    return { spaceBelow: window.innerHeight - r.bottom };
  });
  await new Promise(r => setTimeout(r, 100));
  const t3b = await hitTestPanel('#selx-po-item-' + lastIdxInfo.lastIdx + ' .selx-pan', page2);
  console.log('Test 3b — safety clamp, button fully off-screen (spaceBelow=' + t3b_setup.spaceBelow + '):', JSON.stringify(t3b, null, 2));

  await page2.close();

  // --- Test 4: outside click still closes the panel (back on the PO page) ---
  await page.evaluate(() => go('m_purchaseorders'));
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => { document.querySelector('#selx-po-item-0 .selx-btn').click(); });
  await new Promise(r => setTimeout(r, 100));
  const beforeClose = await page.evaluate(() => document.getElementById('selx-po-item-0').classList.contains('open'));
  await page.mouse.click(5, 5);
  await new Promise(r => setTimeout(r, 100));
  const afterClose = await page.evaluate(() => document.getElementById('selx-po-item-0').classList.contains('open'));
  console.log('Test 4 — outside click closes dropdown:', JSON.stringify({ beforeClose, afterClose }));

  console.log('PAGE ERRORS:', JSON.stringify(errors));

  // cleanup
  const cleanup = await page.evaluate(() => {
    let items = coll('items');
    items = items.filter(r => !(r.name && r.name.indexOf('ZZTEST') === 0));
    lsSet('items', items);
    return { itemsAfter: items.length };
  });
  console.log('CLEANUP:', JSON.stringify(cleanup));

  await browser.close();
})();
