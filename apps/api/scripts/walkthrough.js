/**
 * Real-product visual walkthrough — signs a fresh user through the actual onboarding UI, sets
 * up a Crew with a second real member, and screenshots the core surfaces at mobile (390x844)
 * and desktop (1440x900), so the "before" state is judged from the rendered product, not JSX.
 * Run with: node scripts/walkthrough.js
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const OUT = '/tmp/claude-0/-home-user-lol/62dce65a-461a-550b-baf4-bbaa1c4187cf/scratchpad/shots';
const BASE = 'http://localhost:3000';
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log('  shot:', name);
}

async function loginFresh(context, email) {
  const page = await context.newPage();
  const res = await page.request.post(`${BASE}/api/auth/magic-link`, { data: { email } });
  const body = await res.json();
  await page.goto(body.devMagicLinkUrl.replace('http://localhost:3000', BASE));
  await page.waitForURL('**/onboarding**', { timeout: 8000 }).catch(() => {});
  return page;
}

async function completeOnboarding(page, name, city, viewportLabel) {
  await page.waitForSelector('input[placeholder="Your name"]', { timeout: 8000 });
  await shoot(page, `onboarding-1-name-${viewportLabel}.png`);
  await page.fill('input[placeholder="Your name"]', name);
  await page.click('button:has-text("Continue")');

  await page.waitForSelector('input[placeholder="Stafford"]', { timeout: 8000 });
  await shoot(page, `onboarding-2-location-${viewportLabel}.png`);
  await page.fill('input[placeholder="Stafford"]', city);
  await page.waitForTimeout(700);
  const firstResult = page.locator('[role="option"], li, button').filter({ hasText: city }).first();
  if (await firstResult.count() > 0) {
    await firstResult.click();
  }
  await page.waitForTimeout(300);
  await page.click('button:has-text("Continue")');

  await page.waitForSelector('text=What are you into?', { timeout: 8000 });
  await shoot(page, `onboarding-3-interests-${viewportLabel}.png`);
  for (const label of ['Live music', 'Pubs & drinks', 'Festivals']) {
    await page.click(`button:has-text("${label}")`);
  }
  await page.click('button:has-text("Let\'s go")');
  await page.waitForURL('**/home**', { timeout: 10000 });
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });

  const only = process.argv[2]; // 'mobile' | 'desktop' | undefined (both)
  const all = [['mobile', MOBILE], ['desktop', DESKTOP]].filter(([l]) => !only || l === only);
  for (const [label, viewport] of all) {
    console.log(`\n=== ${label} (${viewport.width}x${viewport.height}) ===`);
    const context = await browser.newContext({ viewport });
    const email = `walkthrough-${label}-${Date.now()}@plot-test.internal`;
    const page = await loginFresh(context, email);
    await completeOnboarding(page, `Walkthrough ${label}`, 'Birmingham', label);

    // HOME
    await page.waitForTimeout(1200);
    await shoot(page, `home-${label}.png`);

    // Create a Crew via /crews?new=1 directly (avoids ambiguous "Start a Crew" text matches
    // between the Home link and the Crews page's own empty-state button behind the sheet).
    await page.goto(`${BASE}/crews?new=1`);
    await page.waitForSelector('form input[placeholder*="Boys"]', { timeout: 8000 }).catch(() => {});
    await shoot(page, `crew-create-${label}.png`);
    const nameInput = page.locator('form input[placeholder*="Boys"]').first();
    if (await nameInput.count() > 0) {
      await nameInput.fill(`${label} Test Crew`);
      await page.locator('form button[type="submit"]').first().click();
      await page.waitForTimeout(1200);
      await shoot(page, `crew-create-look-${label}.png`);
      // "Give it a look" step -> Continue -> taste step -> Continue -> lands in the Crew.
      const continueBtn = page.locator('button:has-text("Continue")').first();
      if (await continueBtn.count() > 0) { await continueBtn.click(); await page.waitForTimeout(600); }
      await shoot(page, `crew-create-taste-${label}.png`);
      // Expand a territory (progressive disclosure), then tap one real interest chip inside it.
      const territory = page.locator('.v2-sheet-root button', { hasText: 'Music' }).first();
      if (await territory.count() > 0) { await territory.click(); await page.waitForTimeout(300); }
      await shoot(page, `crew-create-taste-expanded-${label}.png`);
      const chip = page.locator('.v2-sheet-root button').filter({ hasText: /^(Live gigs|Indie|Pop|Rock)$/ }).first();
      if (await chip.count() > 0) { await chip.click(); await page.waitForTimeout(300); }
      const tasteContinueBtn = page.locator('button:has-text("Continue")').first();
      if (await tasteContinueBtn.count() > 0) { await tasteContinueBtn.click(); await page.waitForTimeout(600); }
      await shoot(page, `crew-create-invite-${label}.png`);
      const doneBtn = page.locator('button:has-text("Done")').first();
      if (await doneBtn.count() > 0) { await doneBtn.click(); await page.waitForTimeout(1000); }
    }

    await page.goto(`${BASE}/crews`);
    await page.waitForTimeout(800);
    await shoot(page, `crews-list-${label}.png`);

    // Try to open the first crew's chat
    const crewLink = page.locator('a[href^="/crews/"]').first();
    if (await crewLink.count() > 0) {
      await crewLink.click();
      await page.waitForTimeout(1000);
      await shoot(page, `crew-chat-${label}.png`);
    }

    // Explore / Discovery
    await page.goto(`${BASE}/explore`);
    await page.waitForTimeout(1200);
    await shoot(page, `explore-${label}.png`);

    // Profile
    await page.goto(`${BASE}/profile`);
    await page.waitForTimeout(1000);
    await shoot(page, `profile-${label}.png`);

    // Avatar picker (identity picker open)
    const avatarBtn = page.locator('button[aria-label="Change photo"]').first();
    if (await avatarBtn.count() > 0) {
      await avatarBtn.click();
      await page.waitForTimeout(500);
      await shoot(page, `avatar-picker-${label}.png`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    await context.close();
  }

  await browser.close();
  console.log('\nDone. Screenshots in', OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
