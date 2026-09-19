/**
 * Open the WordPress Playground blueprint with Elementor and screenshot the
 * parts stream 4 is about to build: the widget panel (groups + names) and the
 * page-settings panel. Read-only: nothing is published, nothing is saved.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.argv[2] || '.';
const URL = 'https://playground.wordpress.net/#%7B%22landingPage%22%3A%22%2Fwp-admin%2Fpost.php%3Fpost%3D2%26action%3Delementor%22%2C%22login%22%3Atrue%2C%22steps%22%3A%5B%7B%22step%22%3A%22installPlugin%22%2C%22pluginData%22%3A%7B%22resource%22%3A%22wordpress.org%2Fplugins%22%2C%22slug%22%3A%22elementor%22%7D%7D%2C%7B%22step%22%3A%22runPHP%22%2C%22code%22%3A%22%3C%3Fphp%20require%20%27%2Fwordpress%2Fwp-load.php%27%3B%20update_option%28%27elementor_onboarded%27%2C%20true%29%3B%22%7D%5D%7D';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

async function findElementorFrame(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    for (const f of page.frames()) {
      try {
        const n = await f.locator('#elementor-panel').count();
        if (n > 0) return f;
      } catch { /* frame detached mid-boot */ }
    }
    await page.waitForTimeout(3000);
  }
  return null;
}

const frame = await findElementorFrame(240000);
if (!frame) {
  await page.screenshot({ path: `${OUT}/elementor-boot-failed.png`, fullPage: false });
  console.log('NO ELEMENTOR PANEL');
  await browser.close();
  process.exit(1);
}
console.log('panel found');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/elementor-01-widgets.png` });

// The widget panel: every group heading and every widget title, in order.
const panel = await frame.evaluate(() => {
  const out = [];
  document.querySelectorAll('#elementor-panel-category-container, .elementor-panel-category').forEach((cat) => {
    const title = cat.querySelector('.elementor-panel-heading-title')?.textContent?.trim();
    const items = [...cat.querySelectorAll('.elementor-element .title, .elementor-element-wrapper .title')]
      .map((t) => t.textContent.trim());
    if (title || items.length) out.push({ group: title || '(none)', items });
  });
  return out;
});
fs.writeFileSync(`${OUT}/elementor-panel.json`, JSON.stringify(panel, null, 2));
console.log(JSON.stringify(panel, null, 1).slice(0, 4000));

// Page settings: the gear beside the page name in the top bar of the panel.
try {
  await frame.click('#elementor-panel-header-menu-button, #elementor-panel-footer-settings', { timeout: 8000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/elementor-02-pagesettings.png` });
  const settings = await frame.evaluate(() => ({
    header: document.querySelector('#elementor-panel-header-title')?.textContent?.trim(),
    tabs: [...document.querySelectorAll('#elementor-panel-elements-navigation .elementor-component-tab, .elementor-panel-navigation-tab')].map((t) => t.textContent.trim()),
    sections: [...document.querySelectorAll('.elementor-control-type-section .elementor-panel-heading-title')].map((t) => t.textContent.trim()),
    controls: [...document.querySelectorAll('.elementor-control .elementor-control-title')].map((t) => t.textContent.trim()),
  }));
  fs.writeFileSync(`${OUT}/elementor-pagesettings.json`, JSON.stringify(settings, null, 2));
  console.log('PAGE SETTINGS', JSON.stringify(settings).slice(0, 2000));
} catch (e) {
  console.log('page settings click failed:', e.message.slice(0, 120));
}

await browser.close();
