#!/usr/bin/env node
//
// Captures screenshots of the Delegate app for the README using mock data.
//
// Prerequisites:
//   - Vite dev server running: cd app && pnpm dev
//   - Playwright installed: npm install -g playwright
//
// Usage:
//   node scripts/screenshots.mjs

import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "..", "docs");
const url = "http://localhost:1430/?mock=true";

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 580 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await context.newPage();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(outDir, "job-list.png") });
console.log("Saved job-list.png");

await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(outDir, "settings.png") });
console.log("Saved settings.png");

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const firstJob = page.locator("li").first();
if (await firstJob.isVisible()) {
  await firstJob.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(outDir, "job-detail.png") });
  console.log("Saved job-detail.png");
}

await browser.close();
console.log("Done.");
