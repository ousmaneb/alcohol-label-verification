// Author: Dr. Ousmane Barry
/**
 * app/batch/page.tsx — Batch mode: check MANY labels in one go.
 *
 * Built for importer season, when 200-300 applications arrive at once.
 * The agent's flow:
 *
 *   Step 1: drop a CSV listing the applications (parsed by lib/csv.ts)
 *   Step 2: drop all the label photos; each CSV row is paired to a photo
 *           whose filename matches its "filename" column
 *   Press "Check N Labels"
 *     -> up to 4 labels are verified at the same time (see CONCURRENCY)
 *     -> a progress bar and per-row statuses update live
 *     -> when done, results can be downloaded as a CSV
 *
 * Each individual label goes through the exact same /api/verify route as
 * the single-label page; this page is just an orchestrator around it.
 */
"use client";

import { useRef, useState } from "react";
import { Masthead, SiteFooter } from "@/components/SiteChrome";
import {
  parseApplicationsCsv,
  photoMatchesRow,
  CSV_TEMPLATE,
  type BatchRow,
} from "@/lib/csv";
import { prepareImage } from "@/lib/image";

// Lifecycle of one row in the batch:
//   no_photo -> the CSV row has no matching photo yet
//   waiting  -> ready, queued behind other rows
//   checking -> its request to /api/verify is in flight
//   done     -> finished (overall + checks are filled in)
//   error    -> the request itself failed (network, server error)
type ItemStatus = "waiting" | "no_photo" | "checking" | "done" | "error";

interface CheckResult {
  id: string;
  label: string;
  expected: string;
  found: string;
  status: "match" | "mismatch" | "not_found" | "review";
  note?: string;
}

interface BatchItem {
  row: BatchRow;
  file: File | null;
  status: ItemStatus;
  overall?: "pass" | "fail" | "review";
  checks?: CheckResult[];
  seconds?: number;
  error?: string;
}

const OVERALL_TEXT = {
  pass: "Passed",
  fail: "Issues found",
  review: "Needs review",
};

// How many labels are checked at the same time. Higher = faster wall-clock
// time but more simultaneous API requests; 4 is a comfortable middle ground
// (a 300-label batch finishes in roughly 4-5 minutes).
const CONCURRENCY = 4;

/** One-line summary of a label's problems, shown in the Details column. */
function issueSummary(checks: CheckResult[]): string {
  const problems = checks.filter((c) => c.status !== "match");
  if (problems.length === 0) return "All checks passed";
  return problems
    .map((c) => {
      if (c.status === "not_found") return `${c.label}: not on label`;
      if (c.status === "review") return `${c.label}: needs review`;
      return `${c.label}: does not match`;
    })
    .join("; ");
}

export default function BatchPage() {
  const [items, setItems] = useState<BatchItem[]>([]);
  // All photos the agent has added so far, whether or not they matched a
  // CSV row yet. Keeping them in a pool means the CSV and the photos can be
  // added in either order (previously, photos added before the CSV were
  // silently lost).
  const [photoPool, setPhotoPool] = useState<File[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvName, setCsvName] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [dragCsv, setDragCsv] = useState(false);
  const [dragPhotos, setDragPhotos] = useState(false);

  /**
   * Called when the agent drops/picks the applications CSV. Parses it and
   * builds one BatchItem per valid row. If photos were added before the CSV
   * (either order works), they are re-paired to the new rows by filename.
   */
  async function handleCsv(file: File | undefined | null) {
    if (!file) return;
    setFinished(false);
    const text = await file.text();
    const { rows, errors } = parseApplicationsCsv(text);
    setCsvName(file.name);
    setCsvErrors(errors);
    // Pair every row with a photo from the pool (works whether the photos
    // were added before or after the CSV).
    setItems(
      rows.map((row) => {
        const match =
          photoPool.find((f) => photoMatchesRow(f.name, row.filename)) ?? null;
        return { row, file: match, status: match ? "waiting" : "no_photo" };
      })
    );
  }

  /**
   * Called when the agent drops/picks label photos (many at once). Photos
   * go into the pool (so the CSV can arrive later), and any that match a
   * loaded CSV row by filename are attached to it immediately. Matching is
   * extension-insensitive because phones rename and convert image formats.
   */
  function handlePhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setFinished(false);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    // Add to the pool, replacing any earlier photo with the same name.
    setPhotoPool((prev) => [
      ...prev.filter((p) => !list.some((f) => f.name === p.name)),
      ...list,
    ]);
    setItems((prev) =>
      prev.map((item) => {
        const match = list.find((f) =>
          photoMatchesRow(f.name, item.row.filename)
        );
        return match
          ? { ...item, file: match, status: "waiting" as const }
          : item;
      })
    );
  }

  /** Downloads a starter CSV showing the expected column layout. */
  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "applications-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const matched = items.filter((i) => i.file !== null).length;
  // Photos in the pool that paired with no CSV row (surfaced in the UI so
  // the agent understands why a photo seems to have been "ignored").
  const unmatchedPhotos =
    items.length > 0
      ? photoPool.filter(
          (f) => !items.some((i) => photoMatchesRow(f.name, i.row.filename))
        )
      : [];
  const doneCount = items.filter(
    (i) => i.status === "done" || i.status === "error"
  ).length;

  /**
   * Runs the whole batch using a small "worker pool":
   * CONCURRENCY worker functions run at once, each repeatedly taking the
   * next unprocessed row (via the shared `cursor` index) until none remain.
   * That keeps exactly 4 requests in flight without any extra libraries.
   * Every state update goes through setItems so the table re-renders live.
   */
  async function runBatch() {
    if (running || matched === 0) return;
    setRunning(true);
    setFinished(false);
    setItems((prev) =>
      prev.map((i) => (i.file ? { ...i, status: "waiting", overall: undefined, checks: undefined, error: undefined } : i))
    );

    const indexes = items
      .map((item, index) => (item.file ? index : -1))
      .filter((i) => i >= 0);
    let cursor = 0;

    async function worker() {
      while (true) {
        const myIndex = indexes[cursor++];
        if (myIndex === undefined) return;
        const item = items[myIndex];
        setItems((prev) =>
          prev.map((it, i) => (i === myIndex ? { ...it, status: "checking" } : it))
        );
        try {
          const image = await prepareImage(item.file!);
          const started = Date.now();
          const res = await fetch("/api/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageBase64: image.base64,
              mediaType: image.mediaType,
              application: item.row.application,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? "Verification failed");
          setItems((prev) =>
            prev.map((it, i) =>
              i === myIndex
                ? {
                    ...it,
                    status: "done",
                    overall: data.overall,
                    checks: data.checks,
                    seconds: (Date.now() - started) / 1000,
                  }
                : it
            )
          );
        } catch (e) {
          setItems((prev) =>
            prev.map((it, i) =>
              i === myIndex
                ? {
                    ...it,
                    status: "error",
                    error: e instanceof Error ? e.message : "Verification failed",
                  }
                : it
            )
          );
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, indexes.length) }, worker)
    );
    setRunning(false);
    setFinished(true);
  }

  /**
   * Builds verification-results.csv in the browser and triggers a download
   * (a temporary <a> element pointing at an in-memory blob; no server round
   * trip). Agents use this to work the exceptions in Excel.
   */
  function exportResults() {
    // Escape for CSV and neutralize spreadsheet formula injection: a cell
    // beginning with = + - @ or a tab would otherwise be evaluated as a
    // formula by Excel/LibreOffice when the agent opens the export. The
    // source values come from an applicant-supplied CSV, so treat them as
    // hostile (OWASP: prefix risky cells with a single quote).
    const esc = (s: string) => {
      const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${guarded.replace(/"/g, '""')}"`;
    };
    const lines = [
      "filename,brand_name,result,issues,seconds",
      ...items.map((i) => {
        const result =
          i.status === "error"
            ? "error"
            : i.status === "no_photo"
              ? "no photo"
              : (i.overall ?? "not checked");
        const issues =
          i.status === "error"
            ? (i.error ?? "")
            : i.checks
              ? issueSummary(i.checks)
              : "";
        return [
          esc(i.row.filename),
          esc(i.row.application.brandName),
          esc(result),
          esc(issues),
          esc(i.seconds ? i.seconds.toFixed(1) : ""),
        ].join(",");
      }),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "verification-results.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const failCount = items.filter((i) => i.overall === "fail").length;
  const reviewCount = items.filter((i) => i.overall === "review").length;

  return (
    <>
      <Masthead active="batch" />

      <main className="container">
        <p className="lede">
          Check many labels at once. Add a spreadsheet listing each
          application, add the matching label photos, and press Check All
          Labels. Rows are paired to photos by filename.
        </p>

        <div className="grid">
          <section className="card" aria-labelledby="bstep1">
            <h2 id="bstep1">
              <span className="step-number">1</span> Application list (CSV)
            </h2>

            <div
              className={`dropzone${dragCsv ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="Add the application list CSV"
              onClick={() => csvInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") csvInput.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragCsv(true);
              }}
              onDragLeave={() => setDragCsv(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragCsv(false);
                handleCsv(e.dataTransfer.files?.[0]);
              }}
            >
              {csvName ? (
                <span>
                  <strong>{csvName}</strong>: {items.length} application
                  {items.length === 1 ? "" : "s"} loaded.{" "}
                  <strong>Click to replace.</strong>
                </span>
              ) : (
                <span>
                  Drag the CSV here, or <strong>click to choose a file</strong>
                </span>
              )}
            </div>
            <input
              ref={csvInput}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => handleCsv(e.target.files?.[0])}
            />

            <p className="required-note" style={{ marginTop: 12 }}>
              Columns: filename, brand_name, abv are required; class_type,
              net_contents, bottler, country_of_origin are optional.{" "}
              <button className="link-button" onClick={downloadTemplate}>
                Download template
              </button>
            </p>

            {csvErrors.length > 0 && (
              <div className="quality-flag" role="alert">
                {csvErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="bstep2">
            <h2 id="bstep2">
              <span className="step-number">2</span> Label photos
            </h2>

            <div
              className={`dropzone${dragPhotos ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="Add label photos"
              onClick={() => photoInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  photoInput.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragPhotos(true);
              }}
              onDragLeave={() => setDragPhotos(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragPhotos(false);
                handlePhotos(e.dataTransfer.files);
              }}
            >
              <span>
                Drag all the label photos here, or{" "}
                <strong>click to choose files</strong>
              </span>
            </div>
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => handlePhotos(e.target.files)}
            />

            {/* Feedback so nothing fails silently: photo counts, and an
                explanation for any photo that didn't pair with a CSV row. */}
            {photoPool.length > 0 && items.length === 0 && (
              <p className="required-note" style={{ marginTop: 12 }}>
                {photoPool.length} photo{photoPool.length === 1 ? "" : "s"}{" "}
                added. Now add the application list (CSV) in step 1.
              </p>
            )}
            {items.length > 0 && (
              <p className="required-note" style={{ marginTop: 12 }}>
                {photoPool.length} photo{photoPool.length === 1 ? "" : "s"}{" "}
                added. {matched} of {items.length} applications have a
                matching photo.
              </p>
            )}
            {items.length > 0 && unmatchedPhotos.length > 0 && (
              <div className="quality-flag" role="alert">
                <strong>
                  {unmatchedPhotos.length} photo
                  {unmatchedPhotos.length === 1 ? "" : "s"} did not match any
                  row in the CSV:
                </strong>{" "}
                {unmatchedPhotos
                  .slice(0, 5)
                  .map((f) => f.name)
                  .join(", ")}
                {unmatchedPhotos.length > 5 ? ", …" : ""}. Photo names must
                match the CSV&apos;s filename column (a different extension,
                like .jpeg instead of .png, is fine). If your phone renamed
                the photos, rename them back or update the CSV.
              </div>
            )}

            <button
              className="verify-button"
              onClick={runBatch}
              disabled={matched === 0 || running}
            >
              {running ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Checking {doneCount} of {matched}…
                </>
              ) : matched > 0 ? (
                `Check ${matched} Label${matched === 1 ? "" : "s"}`
              ) : (
                "Check All Labels"
              )}
            </button>

            {running && (
              <div
                className="progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={matched}
                aria-valuenow={doneCount}
              >
                <div
                  className="progress-fill"
                  style={{ width: `${matched ? (doneCount / matched) * 100 : 0}%` }}
                />
              </div>
            )}
          </section>
        </div>

        {items.length > 0 && (
          <div style={{ marginTop: 24 }} aria-live="polite">
            <section className="card">
              {finished && (
                <div
                  className={`banner ${failCount > 0 ? "fail" : reviewCount > 0 ? "review" : "pass"}`}
                >
                  <span className="banner-main">
                    <span>
                      {failCount > 0
                        ? `${failCount} label${failCount === 1 ? "" : "s"} with issues`
                        : reviewCount > 0
                          ? `${reviewCount} label${reviewCount === 1 ? "" : "s"} need a closer look`
                          : "All labels passed"}
                      <span className="banner-sub">
                        {doneCount} checked of {items.length} applications
                      </span>
                    </span>
                  </span>
                  <button className="link-button" onClick={exportResults}>
                    Download results (CSV)
                  </button>
                </div>
              )}

              <table className="checks">
                <thead>
                  <tr>
                    <th scope="col">Photo</th>
                    <th scope="col">Brand</th>
                    <th scope="col">Result</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {/* data-label lets CSS re-print the column heading inside
                      each cell when the table reflows into stacked cards on
                      narrow (phone) screens. */}
                  {items.map((item, i) => (
                    <tr key={i}>
                      <td>{item.row.filename}</td>
                      <td data-label="Brand">
                        <strong>{item.row.application.brandName}</strong>
                      </td>
                      <td>
                        {item.status === "no_photo" && (
                          <span className="status review">No photo</span>
                        )}
                        {item.status === "waiting" && (
                          <span className="status waiting">Waiting</span>
                        )}
                        {item.status === "checking" && (
                          <span className="status waiting">Checking…</span>
                        )}
                        {item.status === "error" && (
                          <span className="status mismatch">Error</span>
                        )}
                        {item.status === "done" && item.overall && (
                          <span
                            className={`status ${
                              item.overall === "pass"
                                ? "match"
                                : item.overall === "fail"
                                  ? "mismatch"
                                  : "review"
                            }`}
                          >
                            {OVERALL_TEXT[item.overall]}
                          </span>
                        )}
                      </td>
                      <td data-label="Details">
                        {item.status === "done" && item.checks
                          ? issueSummary(item.checks)
                          : item.status === "error"
                            ? item.error
                            : item.status === "no_photo"
                              ? "Add a photo with this filename"
                              : ""}
                        {item.seconds !== undefined && (
                          <span className="note"> {item.seconds.toFixed(1)}s</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </main>

      <SiteFooter />
    </>
  );
}
