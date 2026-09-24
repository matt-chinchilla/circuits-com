// The /viewer guide's captures, taken from PRODUCTION so the BOM shows the
// catalog as buyers see it. Read-only: it opens the committed example project
// ("Try the example project") and never signs in. Run it through the
// Playwright MCP (`browser_run_code_unsafe` with `filename` pointing here); it
// writes raw screenshots to OUT, and `encode.py` turns them into the WebP files
// under public/viewer-guide/. See README.md beside this file.
//
// One selection, followed across every view: U30, the example's iCE40 FPGA.
// The window is 1600x1000 at deviceScaleFactor 3, so every frame the guide
// shows carries at least twice the device pixels of the box it is drawn in
// (the 3D view renders at min(dpr, 2) — its crop is sized for that). Reduced
// motion is on so the 3D view does not auto-orbit: the camera is where this
// script put it, every time.
async (page) => {
  const OUT = '/tmp/viewer-guide-raw/';
  const ctx = await page
    .context()
    .browser()
    .newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 3, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  const stage = p.locator('[class^="_stage_"]:visible').first();
  const drawer = p.locator('[class^="_drawer_"]:visible').first();
  const show = (label) =>
    p.locator('[class^="_drawer_"] [role="group"][aria-label="Show on"] button', { hasText: new RegExp(`^${label}$`) });
  const clipOf = async (loc) => {
    const box = await loc.boundingBox();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const shoot = async (name, loc) => p.screenshot({ path: OUT + name, clip: await clipOf(loc) });
  const log = [];
  try {
    await p.goto('https://circuitcenter.ai/viewer', { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Try the example project' }).first().click();
    await p.getByRole('tab', { name: 'Schematic' }).waitFor({ timeout: 60000 });
    await p.waitForTimeout(8000);
    await shoot('sch-root.png', stage);

    // Price the BOM first, so the part panel carries its catalog match.
    await p.getByRole('tab', { name: 'BOM' }).click();
    await p.getByText(/lines priced/).first().waitFor({ timeout: 60000 });
    await p.waitForTimeout(20000);
    log.push(await p.getByText(/lines priced/).first().evaluate((el) => el.parentElement?.textContent ?? ''));

    // The schematic: typing the reference focuses its unit.
    await p.getByRole('tab', { name: 'Schematic' }).click();
    await p.waitForTimeout(5000);
    const find = p.getByPlaceholder('Find a reference, e.g. U30');
    await find.fill('U30');
    await find.press('Enter');
    await p.waitForTimeout(5000);
    await shoot('sch.png', stage);

    // The part panel, from its designator down to the "Show on" row. The Sheet
    // row is hidden for this one frame: it names the example's root sheet (the
    // project's own name), and the guide shows no project-specific names.
    const panel = await drawer.evaluate((d) => {
      const sheet = [...d.querySelectorAll('dl dt')].find((dt) => dt.textContent === 'Sheet');
      if (sheet) {
        sheet.style.display = 'none';
        sheet.nextElementSibling.style.display = 'none';
      }
      const head = d.querySelector('[class^="_ref_"]').parentElement.getBoundingClientRect();
      const row = d.querySelector('[role="group"][aria-label="Show on"]').getBoundingClientRect();
      const pad = 14;
      return { x: head.left - pad, y: head.top - pad, width: head.width + 2 * pad, height: row.bottom - head.top + 2 * pad };
    });
    await p.screenshot({ path: OUT + 'panel.png', clip: panel });
    await drawer.evaluate((d) => d.querySelectorAll('dl dt, dl dd').forEach((el) => (el.style.display = '')));

    // "Show on Board" is the gesture that ZOOMS to the footprint.
    await show('Board').click();
    await p.waitForTimeout(8000);
    await shoot('brd.png', stage);

    await p.getByRole('tab', { name: 'Stackup' }).click();
    await p.waitForTimeout(3000);
    await shoot('stackup.png', stage);

    // 3D: the part lights up with its label. One frame as the view frames the
    // whole board, then one dollied in so the chip reads.
    await show('3D').click();
    await p.waitForTimeout(15000);
    const canvas = p.locator('canvas:visible').first();
    const cb = await clipOf(canvas);
    await p.screenshot({ path: OUT + '3d-fit.png', clip: cb });
    await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    for (let i = 0; i < 6; i++) {
      await p.mouse.wheel(0, -400);
      await p.waitForTimeout(250);
    }
    await p.waitForTimeout(4000);
    await p.screenshot({ path: OUT + '3d.png', clip: cb });

    // The BOM gets the full stage once the drawer is closed; closing it re-lays
    // the bench, so the viewport is the stable frame.
    await p.getByRole('tab', { name: 'BOM' }).click();
    await p.waitForTimeout(3000);
    await p.locator('[class^="_drawer_"] button[aria-label="Close panel"]').click();
    await p.waitForTimeout(2000);
    await p.screenshot({ path: OUT + 'bom.png' });
  } catch (err) {
    log.push(String(err));
    await p.screenshot({ path: OUT + 'error.png' });
  }
  await ctx.close();
  return log;
}
