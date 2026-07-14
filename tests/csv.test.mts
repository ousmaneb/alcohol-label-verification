// Author: Dr. Ousmane Barry
/**
 * tests/csv.test.mts — unit tests for the batch CSV parser.
 *
 * Run with: npm test
 * Covers: the bundled template, quoted fields with embedded commas and
 * quotes, header-name aliases, and missing-column error reporting.
 */
import { parseApplicationsCsv, photoMatchesRow, CSV_TEMPLATE } from "../lib/csv.ts";

let failures = 0;
function expect(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(
      `FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
    );
  } else {
    console.log(`ok   ${name}`);
  }
}

// 1. The bundled template parses cleanly
const template = parseApplicationsCsv(CSV_TEMPLATE);
expect("template row count", template.rows.length, 2);
expect("template errors", template.errors.length, 0);
expect(
  "template quoted bottler",
  template.rows[0].application.bottler,
  "Old Tom Distillery, Louisville, KY"
);

// 2. Missing required column is reported, not silently ignored
const missing = parseApplicationsCsv("brand_name,abv\nX,40\n");
expect("missing filename column", missing.rows.length, 0);
expect(
  "missing column named in error",
  missing.errors[0]?.includes("filename"),
  true
);

// 3. Header aliases: "File", "Brand", "Alcohol" map to canonical fields
const alias = parseApplicationsCsv("File,Brand,Alcohol\na.png,Foo,40\n");
expect("alias headers accepted", alias.rows.length, 1);
expect("alias brand mapped", alias.rows[0].application.brandName, "Foo");

// 4. Quoted field with embedded comma and escaped quote
const quoted = parseApplicationsCsv(
  'filename,brand_name,abv,bottler\na.png,Foo,40,"Bar, Baz ""Inc"""\n'
);
expect(
  "quoted field parsed",
  quoted.rows[0].application.bottler,
  'Bar, Baz "Inc"'
);

// 5. Row missing brand/abv is skipped with a line-numbered error
const badRow = parseApplicationsCsv(
  "filename,brand_name,abv\na.png,Foo,40\nb.png,,\n"
);
expect("good row kept", badRow.rows.length, 1);
expect("bad row error mentions line", badRow.errors[0]?.includes("Row 3"), true);


// 6. photo pairing: exact, case-insensitive, and extension-insensitive
expect("exact name matches", photoMatchesRow("old-tom-good.png", "old-tom-good.png"), true);
expect("case-insensitive match", photoMatchesRow("Old-Tom-Good.PNG", "old-tom-good.png"), true);
expect("extension differs still matches", photoMatchesRow("old-tom-good.jpeg", "old-tom-good.png"), true);
expect("different photo does not match", photoMatchesRow("IMG_0123.jpeg", "old-tom-good.png"), false);
expect("empty stem does not match", photoMatchesRow(".png", "old-tom-good.png"), false);

console.log(failures === 0 ? "\nALL CSV TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
