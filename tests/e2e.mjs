// Author: Dr. Ousmane Barry
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

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  [" + detail + "]" : ""}`);
  if (!ok) failures++;
}

mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1400 });

/* ────────────── Scenario 1: single label, passing ────────────── */
await page.goto(APP, { waitUntil: "networkidle0" });

check("page title", (await page.title()).includes("LabelProof"));
check(
  "masthead renders",
  (await page.$eval(".masthead-text h1", (el) => el.textContent)) === "LabelProof"
);

await page.type("#brand", "OLD TOM DISTILLERY");
await page.type("#abv", "45");
await page.type("#class", "Kentucky Straight Bourbon Whiskey");
await page.type("#net", "750 mL");
await page.type("#bottler", "Old Tom Distillery, Louisville, KY");

const btnDisabledBefore = await page.$eval(".verify-button", (b) => b.disabled);
check("button disabled before photo", btnDisabledBefore === true);

const fileInput = await page.$('input[type="file"]');
await fileInput.uploadFile(`${LABELS}/old-tom-good.png`);
await page.waitForSelector(".preview img");
check("photo preview appears", true);

await page.waitForFunction(() => !document.querySelector(".verify-button").disabled);
await page.click(".verify-button");
await page.waitForSelector(".banner", { timeout: 30000 });

const banner1 = await page.$eval(".banner", (el) => el.className);
const bannerText1 = await page.$eval(".banner", (el) => el.textContent);
check("good label → green pass banner", banner1.includes("pass"), bannerText1.trim().slice(0, 60));

const statuses1 = await page.$$eval("table.checks .status", (els) =>
  els.map((e) => e.textContent.trim())
);
check(
  "all 6 checks show Matches",
  statuses1.length === 6 && statuses1.every((s) => s === "Matches"),
  statuses1.join(", ")
);
const timeChip = await page.$eval(".time-chip", (el) => el.textContent);
const seconds = parseFloat(timeChip);
check("under 5 seconds", seconds > 0 && seconds < 5, timeChip.trim());

await page.screenshot({ path: `${SHOTS}/e2e-1-single-pass.png` });

/* ────────────── Scenario 2: single label, failing ────────────── */
await page.goto(APP, { waitUntil: "networkidle0" });
await page.type("#brand", "OLD TOM DISTILLERY");
await page.type("#abv", "45");
const fileInput2 = await page.$('input[type="file"]');
await fileInput2.uploadFile(`${LABELS}/old-tom-bad.png`);
await page.waitForFunction(() => !document.querySelector(".verify-button").disabled);
await page.click(".verify-button");
await page.waitForSelector(".banner", { timeout: 30000 });

const banner2 = await page.$eval(".banner", (el) => el.className);
check("bad label → red fail banner", banner2.includes("fail"));
const rows2 = await page.$$eval("table.checks tbody tr", (trs) =>
  trs.map((tr) => ({
    label: tr.querySelector("td strong")?.textContent,
    status: tr.querySelector(".status")?.textContent.trim(),
  }))
);
const abvRow = rows2.find((r) => r.label === "Alcohol content");
const warnRow = rows2.find((r) => r.label === "Government warning");
check("ABV mismatch shown in UI", abvRow?.status === "Does not match", abvRow?.status);
check("warning mismatch shown in UI", warnRow?.status === "Does not match", warnRow?.status);

await page.screenshot({ path: `${SHOTS}/e2e-2-single-fail.png` });

/* ────────────── Scenario 3: batch flow ────────────── */
await page.goto(`${APP}/batch`, { waitUntil: "networkidle0" });

const inputs = await page.$$('input[type="file"]');
// Photos FIRST, CSV second: this order used to silently discard the photos.
await inputs[1].uploadFile(
  `${LABELS}/old-tom-good.png`,
  `${LABELS}/old-tom-bad.png`
);
await page.waitForFunction(() =>
  document.body.textContent.includes("2 photos added. Now add the application list")
);
check("photos kept while CSV not yet added", true);

await inputs[0].uploadFile(`${LABELS}/applications.csv`);
await page.waitForFunction(() =>
  document.body.textContent.includes("7 applications loaded")
);
check("CSV parsed: 7 applications loaded", true);

await page.waitForFunction(() =>
  document.body.textContent.includes("2 of 7 applications have a matching photo")
);
check("photos paired to CSV rows by filename", true);

await page.click(".verify-button");
await page.waitForSelector(".banner", { timeout: 90000 });

const batchBannerText = await page.$eval(".banner", (el) => el.textContent);
check(
  "batch summary reports 1 label with issues",
  batchBannerText.includes("1 label with issues"),
  batchBannerText.trim().slice(0, 60)
);

const batchRows = await page.$$eval("table.checks tbody tr", (trs) =>
  trs.map((tr) => ({
    file: tr.querySelector("td")?.textContent,
    status: tr.querySelector(".status")?.textContent.trim(),
    details: tr.querySelectorAll("td")[3]?.textContent,
  }))
);
const goodRow = batchRows.find((r) => r.file === "old-tom-good.png");
const badRow = batchRows.find((r) => r.file === "old-tom-bad.png");
check("batch: good label passed", goodRow?.status === "Passed", goodRow?.status);
check("batch: bad label flagged", badRow?.status === "Issues found", badRow?.status);
check(
  "batch: bad label details name the problems",
  (badRow?.details ?? "").includes("Alcohol content") &&
    (badRow?.details ?? "").includes("Government warning"),
  (badRow?.details ?? "").slice(0, 80)
);

// Export button present after run
const exportBtn = await page.$$eval(".link-button", (els) =>
  els.some((e) => e.textContent.includes("Download results"))
);
check("results CSV export offered", exportBtn);

await page.screenshot({ path: `${SHOTS}/e2e-3-batch.png` });

await browser.close();
console.log(failures === 0 ? "\nE2E: ALL SCENARIOS PASSED" : `\nE2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
