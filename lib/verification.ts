import { z } from "zod";

/**
 * The health warning statement required verbatim on every alcohol beverage
 * label by 27 CFR Part 16.
 */
export const GOVERNMENT_WARNING_TEXT =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not " +
  "drink alcoholic beverages during pregnancy because of the risk of birth " +
  "defects. (2) Consumption of alcoholic beverages impairs your ability to " +
  "drive a car or operate machinery, and may cause health problems.";

/** What Claude extracts from the label image. Comparison happens in code. */
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

export type LabelExtraction = z.infer<typeof LabelExtractionSchema>;

export interface ApplicationData {
  brandName: string;
  abv: string;
  productClass?: string;
  netContents?: string;
  bottler?: string;
  countryOfOrigin?: string;
}

export type CheckStatus = "match" | "mismatch" | "not_found" | "review";

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

/** Letters and digits only — for the strictest text comparison (warning statement). */
function lettersOnly(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Units-insensitive comparison for net contents: "750 mL" == "750ML". */
function normalizeVolume(s: string): string {
  return s
    .toLowerCase()
    .replace(/millilit(er|re)s?|ml\.?/g, "ml")
    .replace(/lit(er|re)s?|(?<=\d\s*)l\b/g, "l")
    .replace(/fl\.?\s*oz\.?|fluid\s+ounces?/g, "floz")
    .replace(/[^a-z0-9.]/g, "");
}

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

export function verifyAgainstApplication(
  extraction: LabelExtraction,
  app: ApplicationData
): Omit<VerificationResult, "elapsedMs"> {
  const checks: CheckResult[] = [];

  // Brand name
  checks.push(
    compareText("brand", "Brand name", app.brandName, extraction.brand_name)
  );

  // Alcohol content — numeric comparison
  {
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

  // Government warning — always required
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
