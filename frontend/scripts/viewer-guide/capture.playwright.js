// The /viewer guide's captures, taken from PRODUCTION so the BOM shows the
// catalog as buyers see it. Read-only: it opens the committed example project
// ("Try the example project") and never signs in. Run it through the
// Playwright MCP (`browser_run_code_unsafe` with `filename` pointing here); it
// writes raw element screenshots to OUT, and `encode.py` turns them into the
// WebP files under public/viewer-guide/. See README.md beside this file.
async (page) => {
  const OUT = '/tmp/viewer-guide-raw/';
  const ctx = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const stage = p.locator('[class^="_stage_"]:visible').first();
  const drawer = p.locator('[class^="_drawer_"]:visible').first();
  const log = [];
  try {
    await p.goto('https://circuitcenter.ai/viewer', { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Try the example project' }).click();
    await p.getByRole('tab', { name: 'Schematic' }).waitFor({ timeout: 60000 });
    await p.waitForTimeout(8000);
    await stage.screenshot({ path: OUT + 'sch-stage.png' });

    // One selection, followed across every view: U30, the iCE40 FPGA.
    const find = p.getByPlaceholder('Find a reference, e.g. U30');
    await find.fill('U30');
    await find.press('Enter');
    await p.waitForTimeout(5000);
    await stage.screenshot({ path: OUT + 'sch-u30-stage.png' });

    // "Show on Board" is the gesture that ZOOMS to the footprint.
    await p.locator('[class^="_drawer_"] button', { hasText: /^Board$/ }).click();
    await p.waitForTimeout(8000);
    await stage.screenshot({ path: OUT + 'board-u30-stage.png' });

    await p.getByRole('tab', { name: 'Stackup' }).click();
    await p.waitForTimeout(3000);
    await stage.screenshot({ path: OUT + 'stackup-stage.png' });

    await p.getByRole('tab', { name: '3D' }).click();
    await p.waitForTimeout(14000);
    await stage.screenshot({ path: OUT + '3d-stage.png' });

    await p.getByRole('tab', { name: 'BOM' }).click();
    await p.getByText(/lines priced/).first().waitFor({ timeout: 60000 });
    await p.waitForTimeout(20000);
    log.push(await p.getByText(/lines priced/).first().evaluate((el) => el.parentElement?.textContent ?? ''));
    await drawer.screenshot({ path: OUT + 'panel-drawer.png' });
    // The table gets the full stage once the drawer is closed.
    await p.locator('[class^="_drawer_"] button[aria-label="Close panel"]').click();
    await p.waitForTimeout(1500);
    // Closing the drawer re-lays the bench; the viewport is the stable frame.
    await p.screenshot({ path: OUT + 'bom-viewport.png' });
  } catch (err) {
    log.push(String(err));
    await p.screenshot({ path: OUT + 'error.png' });
  }
  await ctx.close();
  return log;
}
