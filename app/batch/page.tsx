"use client";

import { useRef, useState } from "react";
import { Masthead, SiteFooter } from "@/components/SiteChrome";
import { parseApplicationsCsv, CSV_TEMPLATE, type BatchRow } from "@/lib/csv";
import { prepareImage } from "@/lib/image";

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

const CONCURRENCY = 4;

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
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvName, setCsvName] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [dragCsv, setDragCsv] = useState(false);
  const [dragPhotos, setDragPhotos] = useState(false);

  async function handleCsv(file: File | undefined | null) {
    if (!file) return;
    setFinished(false);
    const text = await file.text();
    const { rows, errors } = parseApplicationsCsv(text);
    setCsvName(file.name);
    setCsvErrors(errors);
    setItems((prev) => {
      const photosByName = new Map(
        prev.filter((i) => i.file).map((i) => [i.row.filename.toLowerCase(), i.file!])
      );
      return rows.map((row) => {
        const file = photosByName.get(row.filename.toLowerCase()) ?? null;
        return { row, file, status: file ? "waiting" : "no_photo" };
      });
    });
  }

  function handlePhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setFinished(false);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setItems((prev) =>
      prev.map((item) => {
        const match = list.find(
          (f) => f.name.toLowerCase() === item.row.filename.toLowerCase()
        );
        return match
          ? { ...item, file: match, status: "waiting" as const }
          : item;
      })
    );
  }

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
  const doneCount = items.filter(
    (i) => i.status === "done" || i.status === "error"
  ).length;

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

  function exportResults() {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
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
          result,
          esc(issues),
          i.seconds ? i.seconds.toFixed(1) : "",
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

            {items.length > 0 && (
              <p className="required-note" style={{ marginTop: 12 }}>
                {matched} of {items.length} applications have a matching photo.
              </p>
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
                  {items.map((item, i) => (
                    <tr key={i}>
                      <td>{item.row.filename}</td>
                      <td>
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
                      <td>
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
