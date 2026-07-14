/**
 * tests/verification.test.mts — unit tests for the comparison logic.
 *
 * Run with: npm test
 * (Plain Node, no test framework: Node 22+ strips TypeScript types
 * natively, so this file runs directly against lib/verification.ts.)
 *
 * Each case asserts a verdict the discovery interviews called out:
 * the STONE'S THROW near-match, the rejected title-case warning, unit
 * variations, accent folding, and so on. Exit code 0 = all passed.
 */
import {
  verifyAgainstApplication,
  GOVERNMENT_WARNING_TEXT,
  type LabelExtraction,
} from "../lib/verification.ts";

const goodExtraction: LabelExtraction = {
  brand_name: "Old Tom Distillery",
  product_class: "Kentucky Straight Bourbon Whiskey",
  alcohol_content_raw: "ALC. 45% BY VOL.",
  abv_percent: 45,
  net_contents: "750ML",
  bottler_info: "BOTTLED BY OLD TOM DISTILLERY, LOUISVILLE, KY",
  country_of_origin: null,
  government_warning_present: true,
  government_warning_text: GOVERNMENT_WARNING_TEXT,
  government_warning_bold: true,
  image_quality_issue: null,
};

const app = {
  brandName: "Old Tom Distillery",
  abv: "45",
  productClass: "Kentucky Straight Bourbon Whiskey",
  netContents: "750 mL",
};

let failures = 0;
function expect(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// 1. everything matches
const r1 = verifyAgainstApplication(goodExtraction, app);
expect("all-match overall", r1.overall, "pass");
expect("all-match statuses", r1.checks.map(c => c.status), ["match","match","match","match","match"]);

// 2. ABV mismatch
const r2 = verifyAgainstApplication({ ...goodExtraction, abv_percent: 40, alcohol_content_raw: "ALC. 40% BY VOL." }, app);
expect("abv mismatch overall", r2.overall, "fail");
expect("abv mismatch status", r2.checks.find(c => c.id === "abv")!.status, "mismatch");

// 3. missing warning
const r3 = verifyAgainstApplication({ ...goodExtraction, government_warning_present: false, government_warning_text: null }, app);
expect("missing warning", r3.checks.find(c => c.id === "warning")!.status, "not_found");
expect("missing warning overall", r3.overall, "fail");

// 4. warning wording altered
const r4 = verifyAgainstApplication({ ...goodExtraction, government_warning_text: GOVERNMENT_WARNING_TEXT.replace("birth defects", "health issues") }, app);
expect("altered warning", r4.checks.find(c => c.id === "warning")!.status, "mismatch");

// 5. warning in title case "Government Warning" → rejected (Jenny's case)
const r5 = verifyAgainstApplication({ ...goodExtraction, government_warning_text: GOVERNMENT_WARNING_TEXT.replace("GOVERNMENT WARNING", "Government Warning") }, app);
expect("title-case warning → mismatch", r5.checks.find(c => c.id === "warning")!.status, "mismatch");
expect("title-case warning overall", r5.overall, "fail");

// 5b. warning correct but heading not bold → review
const r5b = verifyAgainstApplication({ ...goodExtraction, government_warning_bold: false }, app);
expect("non-bold warning → review", r5b.checks.find(c => c.id === "warning")!.status, "review");

// 5c. boldness unclear (null) → does not penalize
const r5c = verifyAgainstApplication({ ...goodExtraction, government_warning_bold: null }, app);
expect("bold unclear → match", r5c.checks.find(c => c.id === "warning")!.status, "match");

// 6. brand containment → review
const r6 = verifyAgainstApplication({ ...goodExtraction, brand_name: "Old Tom Distillery Reserve" }, app);
expect("brand containment", r6.checks.find(c => c.id === "brand")!.status, "review");

// 7. net contents unit variations
const r7 = verifyAgainstApplication({ ...goodExtraction, net_contents: "750 milliliters" }, app);
expect("net contents units", r7.checks.find(c => c.id === "net")!.status, "match");

// 8. optional fields skipped when blank
const r8 = verifyAgainstApplication(goodExtraction, { brandName: "Old Tom Distillery", abv: "45" });
expect("optional skipped", r8.checks.map(c => c.id), ["brand","abv","warning"]);

// 9. image quality issue → review
const r9 = verifyAgainstApplication({ ...goodExtraction, image_quality_issue: "glare on lower half" }, app);
expect("quality issue overall", r9.overall, "review");

// 10. abv string with symbols "13.5%"
const r10 = verifyAgainstApplication({ ...goodExtraction, abv_percent: 13.5, alcohol_content_raw: "13.5% ALC/VOL" }, { ...app, abv: "13.5%" });
expect("abv with % sign", r10.checks.find(c => c.id === "abv")!.status, "match");

// 11. bottler: application value contained in label statement → match
const r11 = verifyAgainstApplication(goodExtraction, { ...app, bottler: "Old Tom Distillery, Louisville, KY" });
expect("bottler containment match", r11.checks.find(c => c.id === "bottler")!.status, "match");

// 12. bottler: partial overlap → review
const r12 = verifyAgainstApplication({ ...goodExtraction, bottler_info: "BOTTLED BY OLD TOM SPIRITS CO, FRANKFORT, KY" }, { ...app, bottler: "Old Tom Distillery, Louisville, KY" });
expect("bottler partial overlap review", r12.checks.find(c => c.id === "bottler")!.status, "review");

// 13. country of origin: "France" in "PRODUCT OF FRANCE" → match
const r13 = verifyAgainstApplication({ ...goodExtraction, country_of_origin: "PRODUCT OF FRANCE" }, { ...app, countryOfOrigin: "France" });
expect("origin containment match", r13.checks.find(c => c.id === "origin")!.status, "match");

// 14. country of origin missing on label → not_found
const r14 = verifyAgainstApplication(goodExtraction, { ...app, countryOfOrigin: "France" });
expect("origin missing", r14.checks.find(c => c.id === "origin")!.status, "not_found");

// 15. Dave's exact case: STONE'S THROW (label) vs Stone's Throw (application)
const r15 = verifyAgainstApplication(
  { ...goodExtraction, brand_name: "STONE'S THROW" },
  { ...app, brandName: "Stone's Throw" }
);
expect("STONE'S THROW vs Stone's Throw", r15.checks.find(c => c.id === "brand")!.status, "match");

// 16. apostrophe present vs absent → still the same words
const r16 = verifyAgainstApplication(
  { ...goodExtraction, brand_name: "STONES THROW" },
  { ...app, brandName: "Stone's Throw" }
);
expect("STONES THROW vs Stone's Throw", r16.checks.find(c => c.id === "brand")!.status, "match");

// 17. abbreviation periods: "ST. JAMES" vs "St James"
const r17 = verifyAgainstApplication(
  { ...goodExtraction, brand_name: "ST. JAMES RESERVE" },
  { ...app, brandName: "St James Reserve" }
);
expect("ST. JAMES vs St James", r17.checks.find(c => c.id === "brand")!.status, "match");

// 18. genuinely different brands still mismatch
const r18 = verifyAgainstApplication(
  { ...goodExtraction, brand_name: "STONE BRIDGE" },
  { ...app, brandName: "Stone's Throw" }
);
expect("different brands still fail", r18.checks.find(c => c.id === "brand")!.status, "mismatch");

// 19. decimal points survive normalization: class with a number
const r19 = verifyAgainstApplication(
  { ...goodExtraction, product_class: "Reserve 13.5 Blend" },
  { ...app, productClass: "Reserve 135 Blend" }
);
expect("13.5 does not collapse to 135", r19.checks.find(c => c.id === "class")!.status, "mismatch");

// 20. accents fold: CHÂTEAU RIVIÈRE vs Chateau Riviere
const r20 = verifyAgainstApplication(
  { ...goodExtraction, brand_name: "CHÂTEAU RIVIÈRE" },
  { ...app, brandName: "Chateau Riviere" }
);
expect("accented vs plain brand", r20.checks.find(c => c.id === "brand")!.status, "match");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
