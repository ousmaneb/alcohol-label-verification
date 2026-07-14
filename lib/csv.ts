import type { ApplicationData } from "@/lib/verification";

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface BatchRow {
  filename: string;
  application: ApplicationData;
}

/** Header aliases → canonical field. Headers are matched after lowercasing
 *  and stripping spaces/underscores, so "Brand Name" == "brand_name". */
const HEADER_ALIASES: Record<string, string> = {
  filename: "filename",
  file: "filename",
  image: "filename",
  photo: "filename",
  brand: "brandName",
  brandname: "brandName",
  abv: "abv",
  alcohol: "abv",
  alcoholcontent: "abv",
  class: "productClass",
  type: "productClass",
  classtype: "productClass",
  productclass: "productClass",
  net: "netContents",
  netcontents: "netContents",
  bottler: "bottler",
  producer: "bottler",
  bottlerproducer: "bottler",
  country: "countryOfOrigin",
  origin: "countryOfOrigin",
  countryoforigin: "countryOfOrigin",
};

export interface CsvParseResult {
  rows: BatchRow[];
  errors: string[];
}

export function parseApplicationsCsv(text: string): CsvParseResult {
  const raw = parseCsv(text);
  if (raw.length < 2) {
    return {
      rows: [],
      errors: ["The file needs a header row and at least one application row."],
    };
  }

  const headers = raw[0].map(
    (h) => HEADER_ALIASES[h.toLowerCase().replace(/[\s_-]/g, "")] ?? null
  );

  const missing = ["filename", "brandName", "abv"].filter(
    (req) => !headers.includes(req)
  );
  if (missing.length > 0) {
    const names: Record<string, string> = {
      filename: "filename",
      brandName: "brand_name",
      abv: "abv",
    };
    return {
      rows: [],
      errors: [
        `Missing required column(s): ${missing.map((m) => names[m]).join(", ")}. ` +
          "Download the template to see the expected format.",
      ],
    };
  }

  const rows: BatchRow[] = [];
  const errors: string[] = [];

  raw.slice(1).forEach((cells, index) => {
    const record: Record<string, string> = {};
    headers.forEach((key, i) => {
      if (key && cells[i] !== undefined) record[key] = cells[i].trim();
    });
    const lineNo = index + 2;
    if (!record.filename) {
      errors.push(`Row ${lineNo}: missing filename, skipped.`);
      return;
    }
    if (!record.brandName || !record.abv) {
      errors.push(`Row ${lineNo} (${record.filename}): missing brand name or ABV, skipped.`);
      return;
    }
    rows.push({
      filename: record.filename,
      application: {
        brandName: record.brandName,
        abv: record.abv,
        productClass: record.productClass,
        netContents: record.netContents,
        bottler: record.bottler,
        countryOfOrigin: record.countryOfOrigin,
      },
    });
  });

  return { rows, errors };
}

export const CSV_TEMPLATE =
  "filename,brand_name,abv,class_type,net_contents,bottler,country_of_origin\n" +
  'old-tom-good.png,OLD TOM DISTILLERY,45,Kentucky Straight Bourbon Whiskey,750 mL,"Old Tom Distillery, Louisville, KY",\n' +
  "chateau-example.jpg,Chateau Example,13.5,Red Wine,750 mL,,France\n";
