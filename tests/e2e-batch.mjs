/**
 * Browser end-to-end tests, driven with Puppeteer against a running app.
 *
 * Prerequisites:
 *   1. the dev server is running (npm run dev) with a valid ANTHROPIC_API_KEY
 *   2. Google Chrome is installed (override path with CHROME_PATH env var)
 *
 * Run with: npm run test:e2e   (this file)
 *           npm run test:e2e:batch   (all 7 samples through batch mode)
 *
 * These make real API calls, so they are not part of `npm test` or CI.
 */
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL ?? "http://localhost:3000";

const LABELS = fileURLToPath(new URL("../test-labels", import.meta.url));
const SHOTS = fileURLToPath(new URL("./screenshots", import.meta.url));

const EXPECTED = {
  "old-tom-good.png": "Passed",
  "old-tom-bad.png": "Issues found",
  "old-tom-titlecase.png": "Issues found",
  "old-tom-no-warning.png": "Issues found",
  "old-tom-reserve.png": "Needs review",
  "chateau-riviere.png": "Passed",
  "hop-canyon.png": "Passed",
};

mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1600 });
await page.goto(`${APP}/batch`, { waitUntil: "networkidle0" });

const inputs = await page.$$('input[type="file"]');
await inputs[0].uploadFile(`${LABELS}/applications.csv`);
await page.waitForFunction(() =>
  document.body.textContent.includes("7 applications loaded")
);
await inputs[1].uploadFile(...Object.keys(EXPECTED).map((f) => `${LABELS}/${f}`));
await page.waitForFunction(() =>
  document.body.textContent.includes("7 of 7 applications have a matching photo")
);

const start = Date.now();
await page.click(".verify-button");
await page.waitForSelector(".banner", { timeout: 180000 });
const wall = ((Date.now() - start) / 1000).toFixed(1);

const rows = await page.$$eval("table.checks tbody tr", (trs) =>
  trs.map((tr) => ({
    file: tr.querySelector("td")?.textContent.trim(),
    status: tr.querySelector(".status")?.textContent.trim(),
    details: tr.querySelectorAll("td")[3]?.textContent.trim(),
  }))
);

let failures = 0;
for (const [file, expected] of Object.entries(EXPECTED)) {
  const row = rows.find((r) => r.file === file);
  const ok = row?.status === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${file}: ${row?.status} (expected ${expected})  ${row?.details?.slice(0, 70) ?? ""}`);
}
const banner = await page.$eval(".banner", (el) => el.textContent);
console.log(`\nbanner: ${banner.trim().replace(/\s+/g, " ").slice(0, 80)}`);
console.log(`wall time for 7 labels: ${wall}s`);

await page.screenshot({ path: `${SHOTS}/e2e-batch7.png`, fullPage: true });
await browser.close();
console.log(failures === 0 ? "\nBATCH E2E: ALL 7 AS EXPECTED" : `\nBATCH E2E: ${failures} UNEXPECTED`);
process.exit(failures === 0 ? 0 : 1);
