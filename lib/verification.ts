/**
 * lib/verification.ts — the "brain" of the app.
 *
 * The app splits label checking into two very different jobs:
 *
 *   1. READING the label (done by the Claude AI model, with vision).
 *      The AI is only asked to transcribe what is printed on the label,
 *      exactly as printed. It never decides pass/fail.
 *
 *   2. COMPARING what was read against the application (done by the plain
 *      TypeScript code in this file). Because this part is ordinary code,
 *      the same inputs always produce the same verdict, and every rule can
 *      be unit tested. That makes the results auditable, which matters for
 *      a government compliance tool.
 *
 * This file defines:
 *   - LabelExtractionSchema: the exact shape of data we ask the AI to return
 *   - the comparison helpers (normalize, compareText, compareLoose, ...)
 *   - verifyAgainstApplication(): runs every check and builds the verdict
 */
import { z } from "zod";

/**
 * The health warning statement required verbatim on every alcohol beverage
 * label by 27 CFR Part 16. We compare the label's warning text against this
 * string, so a single changed word is detected.
 */
export const GOVERNMENT_WARNING_TEXT =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not " +
  "drink alcoholic beverages during pregnancy because of the risk of birth " +
  "defects. (2) Consumption of alcoholic beverages impairs your ability to " +
  "drive a car or operate machinery, and may cause health problems.";

/**
 * What Claude extracts from the label image. Comparison happens in code.
 *
 * This is a Zod schema: a machine-readable description of the JSON object we
 * want back from the AI. We send it with the API request ("structured
 * output"), and the API guarantees the response matches this shape — so we
 * never have to parse free-form text. Each .describe() string is read by the
 * model and acts as an instruction for that field.
 *
 * Every field is .nullable() on purpose: if something is not printed on the
 * label (or not legible), the model must return null instead of guessing.
 */
export const LabelExtractionSchema = z.object({
  brand_name: z
    .string()
    .nullable()
    .describe(
      "The brand name under which the product is sold, usually the most " +
        "prominent product name on the label. On beer labels this is the " +
        "beer's name, not the brewery name (the brewery/producer belongs in " +
        "bottler_info). Null if not visible."
    ),
  product_class: z
    .string()
    .nullable()
    .describe(
      'The class/type designation as printed, e.g. "Kentucky Straight Bourbon Whiskey", "Red Wine", "India Pale Ale", or null'
    ),
  alcohol_content_raw: z
    .string()
    .nullable()
    .describe(
      'The alcohol content statement exactly as printed, e.g. "ALC. 13.5% BY VOL.", or null if not visible'
    ),
  abv_percent: z
    .number()
    .nullable()
    .describe("The alcohol by volume as a number, e.g. 13.5, or null"),
  net_contents: z
    .string()
    .nullable()
    .describe('The net contents as printed, e.g. "750 ML", or null'),
  bottler_info: z
    .string()
    .nullable()
    .describe(
      'The bottler/producer name and address statement as printed, e.g. "BOTTLED BY OLD TOM DISTILLERY, LOUISVILLE, KY", or null'
    ),
  country_of_origin: z
    .string()
    .nullable()
    .describe(
      'The country of origin statement as printed, e.g. "PRODUCT OF FRANCE", or null if none'
    ),
  government_warning_present: z
    .boolean()
    .describe("Whether a GOVERNMENT WARNING statement appears on the label"),
  government_warning_text: z
    .string()
    .nullable()
    .describe(
      "The full government warning statement transcribed verbatim, preserving capitalization, or null if absent"
    ),
  government_warning_bold: z
    .boolean()
    .nullable()
    .describe(
      'Whether the words "GOVERNMENT WARNING" are printed in bold type (visibly heavier than the rest of the statement), or null if it cannot be judged from the photo'
    ),
  image_quality_issue: z
    .string()
    .nullable()
    .describe(
      "null if the label is fully legible; otherwise a short description of the problem (blurry, glare, cropped, partially obscured)"
    ),
});

/** The TypeScript type derived automatically from the schema above. */
export type LabelExtraction = z.infer<typeof LabelExtractionSchema>;

/**
 * What the compliance agent typed into the form (or a row of the batch CSV).
 * brandName and abv are required; the rest are optional and only checked
 * when the agent filled them in.
 */
export interface ApplicationData {
  brandName: string;
  abv: string;
  productClass?: string;
  netContents?: string;
  bottler?: string;
  countryOfOrigin?: string;
}

/**
 * Every individual check ends in exactly one of these four states:
 *   match     - label agrees with the application
 *   mismatch  - label clearly disagrees (hard failure)
 *   not_found - the field is not visible on the label at all
 *   review    - too close to call; a human agent must decide
 * "review" exists because discovery showed agents need judgment calls
 * escalated to them, never silently decided by the tool.
 */
export type CheckStatus = "match" | "mismatch" | "not_found" | "review";

/** One row of the results table shown to the agent. */
export interface CheckResult {
  id: string;
  label: string;
  expected: string;
  found: string;
  status: CheckStatus;
  note?: string;
}

export interface VerificationResult {
  overall: "pass" | "fail" | "review";
  checks: CheckResult[];
  imageQualityIssue: string | null;
  elapsedMs: number;
}

/**
 * Lowercase, strip accents and punctuation, collapse whitespace.
 * Diacritics are folded ("CHÂTEAU RIVIÈRE" == "Chateau Riviere") since
 * agents typically type application data without accents. Apostrophes and
 * abbreviation periods are removed entirely (not replaced with a space) so
 * "STONE'S THROW" == "Stone's Throw" == "Stones Throw" and "ST. JAMES" ==
 * "St James". Decimal points between digits are preserved so "13.5" never
 * collapses to "135".
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/(?<!\d)\./g, "")
    .replace(/\.(?!\d)/g, "")
    .replace(/[^\p{L}\p{N}\s%.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Letters and digits only — the strictest comparison, used for the
 * government warning statement where the WORDING must be identical but
 * punctuation/spacing/case differences from photo transcription are noise.
 */
function lettersOnly(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Units-insensitive comparison for net contents: "750 mL" == "750ML" ==
 * "750 milliliters". Each replace() maps one family of unit spellings to a
 * single canonical form before comparing.
 */
function normalizeVolume(s: string): string {
  return s
    .toLowerCase()
    .replace(/millilit(er|re)s?|ml\.?/g, "ml")
    .replace(/lit(er|re)s?|(?<=\d\s*)l\b/g, "l")
    .replace(/fl\.?\s*oz\.?|fluid\s+ounces?/g, "floz")
    .replace(/[^a-z0-9.]/g, "");
}

/**
 * Standard comparison for brand name and class/type.
 * Decision ladder:
 *   1. not printed on the label            -> not_found
 *   2. identical after normalize()         -> match
 *   3. one string contains the other       -> review (human decides)
 *   4. anything else                       -> mismatch
 */
function compareText(
  id: string,
  label: string,
  expected: string,
  found: string | null
): CheckResult {
  if (!found) {
    return { id, label, expected, found: "Not found on label", status: "not_found" };
  }
  const e = normalize(expected);
  const f = normalize(found);
  if (e === f) return { id, label, expected, found, status: "match" };
  // One contains the other (e.g. label says "Old Tom Distillery Reserve",
  // application says "Old Tom") — surface for human judgment, don't auto-fail.
  if (e.includes(f) || f.includes(e)) {
    return {
      id,
      label,
      expected,
      found,
      status: "review",
      note: "Close but not identical. Please confirm.",
    };
  }
  return { id, label, expected, found, status: "mismatch" };
}

/**
 * Lenient comparison for statements whose printed form legitimately varies
 * (bottler name-and-address, country of origin). Containment counts as a
 * match ("France" matches "PRODUCT OF FRANCE"); substantial word overlap is
 * surfaced for review; little overlap is a mismatch.
 */
function compareLoose(
  id: string,
  label: string,
  expected: string,
  found: string | null
): CheckResult {
  if (!found) {
    return { id, label, expected, found: "Not found on label", status: "not_found" };
  }
  const e = normalize(expected);
  const f = normalize(found);
  if (e === f || f.includes(e) || e.includes(f)) {
    return { id, label, expected, found, status: "match" };
  }
  const expectedWords = e.split(" ").filter((w) => w.length > 1);
  const overlap = expectedWords.filter((w) => f.includes(w)).length;
  if (expectedWords.length > 0 && overlap / expectedWords.length >= 0.5) {
    return {
      id,
      label,
      expected,
      found,
      status: "review",
      note: "Similar but not identical. Please confirm.",
    };
  }
  return { id, label, expected, found, status: "mismatch" };
}

/**
 * The main entry point: takes what the AI read off the label (extraction)
 * and what the agent typed (app), runs every applicable check, and returns
 * the list of per-field verdicts plus an overall pass/fail/review outcome.
 * Pure function: no network, no side effects — which is what makes it easy
 * to unit test.
 */
export function verifyAgainstApplication(
  extraction: LabelExtraction,
  app: ApplicationData
): Omit<VerificationResult, "elapsedMs"> {
  const checks: CheckResult[] = [];

  // Brand name
  checks.push(
    compareText("brand", "Brand name", app.brandName, extraction.brand_name)
  );

  // Alcohol content — numeric comparison, not text comparison. The label may
  // print "45% Alc./Vol. (90 Proof)" while the application says "45"; we
  // compare the numbers (45 == 45), and show the label's raw text to the
  // agent for context.
  {
    // Strip everything except digits and the decimal point, e.g. "13.5%" -> 13.5
    const expectedAbv = parseFloat(app.abv.replace(/[^0-9.]/g, ""));
    const foundAbv = extraction.abv_percent;
    const foundDisplay =
      extraction.alcohol_content_raw ??
      (foundAbv != null ? `${foundAbv}%` : null);
    if (foundAbv == null || foundDisplay == null) {
      checks.push({
        id: "abv",
        label: "Alcohol content",
        expected: `${expectedAbv}% ABV`,
        found: "Not found on label",
        status: "not_found",
      });
    } else {
      checks.push({
        id: "abv",
        label: "Alcohol content",
        expected: `${expectedAbv}% ABV`,
        found: foundDisplay,
        // 0.005 tolerance only absorbs floating-point rounding noise;
        // a genuinely different ABV (44.9 vs 45) still fails.
        status: Math.abs(foundAbv - expectedAbv) < 0.005 ? "match" : "mismatch",
      });
    }
  }

  // Product class/type — only if the agent entered one
  if (app.productClass?.trim()) {
    checks.push(
      compareText(
        "class",
        "Class / type",
        app.productClass.trim(),
        extraction.product_class
      )
    );
  }

  // Net contents — only if the agent entered one
  if (app.netContents?.trim()) {
    const expected = app.netContents.trim();
    const found = extraction.net_contents;
    if (!found) {
      checks.push({
        id: "net",
        label: "Net contents",
        expected,
        found: "Not found on label",
        status: "not_found",
      });
    } else {
      checks.push({
        id: "net",
        label: "Net contents",
        expected,
        found,
        status:
          normalizeVolume(expected) === normalizeVolume(found)
            ? "match"
            : "mismatch",
      });
    }
  }

  // Bottler / producer name and address — only if the agent entered one
  if (app.bottler?.trim()) {
    checks.push(
      compareLoose(
        "bottler",
        "Bottler / producer",
        app.bottler.trim(),
        extraction.bottler_info
      )
    );
  }

  // Country of origin — only if the agent entered one (imports)
  if (app.countryOfOrigin?.trim()) {
    checks.push(
      compareLoose(
        "origin",
        "Country of origin",
        app.countryOfOrigin.trim(),
        extraction.country_of_origin
      )
    );
  }

  // Government warning — the only check that is ALWAYS required (federal law
  // mandates it on every alcohol beverage label). Three things are verified:
  //   1. the wording is identical to the statutory text (lettersOnly compare)
  //   2. the heading reads "GOVERNMENT WARNING" in capital letters
  //   3. the heading appears in bold type (judged visually by the AI)
  {
    const found = extraction.government_warning_text;
    if (!extraction.government_warning_present || !found) {
      checks.push({
        id: "warning",
        label: "Government warning",
        expected: "Required health warning statement",
        found: "Not found on label",
        status: "not_found",
      });
    } else if (lettersOnly(found) === lettersOnly(GOVERNMENT_WARNING_TEXT)) {
      const capsOk = found.includes("GOVERNMENT WARNING");
      if (!capsOk) {
        // Wording is right but "Government Warning" is not in all caps.
        // A hard failure: the heading must read GOVERNMENT WARNING.
        checks.push({
          id: "warning",
          label: "Government warning",
          expected: "Exact wording, GOVERNMENT WARNING in capitals and bold",
          found: "Correct wording, but “GOVERNMENT WARNING” is not in capital letters",
          status: "mismatch",
          note: "The words GOVERNMENT WARNING must appear in capital letters.",
        });
      } else if (extraction.government_warning_bold === false) {
        // Caps and wording correct, but the heading does not appear bold.
        // Visual weight is harder to judge from a photo, so this goes to
        // human review rather than a hard failure.
        checks.push({
          id: "warning",
          label: "Government warning",
          expected: "Exact wording, GOVERNMENT WARNING in capitals and bold",
          found: "Correct wording and capitals, but the heading does not appear to be in bold type",
          status: "review",
          note: "The words GOVERNMENT WARNING must be in bold. Please confirm on the label.",
        });
      } else {
        checks.push({
          id: "warning",
          label: "Government warning",
          expected: "Exact wording, GOVERNMENT WARNING in capitals and bold",
          found: "Present, exact wording",
          status: "match",
        });
      }
    } else {
      checks.push({
        id: "warning",
        label: "Government warning",
        expected: "Exact wording, GOVERNMENT WARNING in capitals and bold",
        found: "Present, but wording differs from the required statement",
        status: "mismatch",
        note: `Label reads: “${found}”`,
      });
    }
  }

  // Roll the individual checks up into one overall verdict:
  //   any hard failure          -> "fail"
  //   else any review/photo issue -> "review"
  //   else                        -> "pass"
  const hasFailure = checks.some(
    (c) => c.status === "mismatch" || c.status === "not_found"
  );
  const hasReview =
    checks.some((c) => c.status === "review") ||
    extraction.image_quality_issue != null;

  return {
    overall: hasFailure ? "fail" : hasReview ? "review" : "pass",
    checks,
    imageQualityIssue: extraction.image_quality_issue,
  };
}
