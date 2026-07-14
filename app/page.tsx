// Author: Dr. Ousmane Barry
/**
 * app/page.tsx — the main screen: check ONE label against ONE application.
 *
 * "use client" means this component runs in the browser (it needs state,
 * file uploads, and click handlers). The flow the agent sees:
 *
 *   Step 1: type the application details (brand, ABV, optional fields)
 *   Step 2: add the label photo (drag-drop or click)
 *   Press "Check Label"
 *     -> photo is downscaled in the browser (lib/image.ts)
 *     -> POST to /api/verify (the server route that talks to the AI)
 *     -> results render as a color-coded table with per-field verdicts
 *
 * All state lives in this component with React useState; there is no global
 * store because the whole screen is one self-contained form.
 */
"use client";

import { useRef, useState } from "react";
import { Masthead, SiteFooter } from "@/components/SiteChrome";
import { prepareImage } from "@/lib/image";

// These mirror the server's response shape (see lib/verification.ts).
type CheckStatus = "match" | "mismatch" | "not_found" | "review";

interface CheckResult {
  id: string;
  label: string;
  expected: string;
  found: string;
  status: CheckStatus;
  note?: string;
}

interface VerificationResponse {
  overall: "pass" | "fail" | "review";
  checks: CheckResult[];
  imageQualityIssue: string | null;
  elapsedMs: number;
}

// Human-readable wording for each verdict. Shown next to an icon so color
// is never the only signal (accessibility).
const STATUS_TEXT: Record<CheckStatus, string> = {
  match: "Matches",
  mismatch: "Does not match",
  not_found: "Not on label",
  review: "Needs review",
};

const BANNER_TEXT = {
  pass: "All checks passed",
  fail: "Issues found. Do not approve.",
  review: "Needs a closer look",
};

/* ── Inline SVG icons (single stroke family, consistent sizing) ── */

function StatusIcon({ status }: { status: CheckStatus }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 13,
    height: 13,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (status === "match") {
    return (
      <svg {...common}>
        <path d="M2.5 8.5l3.5 3.5 7-8" />
      </svg>
    );
  }
  if (status === "review") {
    return (
      <svg {...common}>
        <path d="M5.5 5.5a2.5 2.5 0 1 1 3.4 2.4c-.8.3-.9 1-.9 1.6" />
        <circle cx="8" cy="12.5" r="0.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={34}
      height={34}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3.5 17l4.5-4.5 3 3 4-4 5.5 5.5" />
    </svg>
  );
}

const BannerIcon = StatusIcon;

export default function Home() {
  // ---- Form state: one piece of state per input field ----
  const [brandName, setBrandName] = useState("");
  const [abv, setAbv] = useState("");
  const [productClass, setProductClass] = useState("");
  const [netContents, setNetContents] = useState("");
  const [bottler, setBottler] = useState("");
  const [countryOfOrigin, setCountryOfOrigin] = useState("");

  // ---- Photo + request state ----
  const [image, setImage] = useState<{
    base64: string;      // the downscaled photo, ready to send to the server
    mediaType: string;   // always "image/jpeg" after downscaling
    previewUrl: string;  // data: URL for the thumbnail preview
    name: string;        // original filename, used in the preview alt text
  } | null>(null);
  const [dragging, setDragging] = useState(false); // highlights the dropzone
  const [busy, setBusy] = useState(false);         // true while a check runs
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResponse | null>(null);
  // Ref to the hidden <input type="file">, so clicking the styled dropzone
  // can open the native file picker.
  const fileInput = useRef<HTMLInputElement>(null);

  /** Called when the agent picks or drops a photo file. */
  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That file is not a photo. Please choose a JPEG or PNG image.");
      return;
    }
    setError(null);
    setResult(null);
    try {
      const prepared = await prepareImage(file);
      setImage({ ...prepared, name: file.name });
    } catch {
      setError("Could not read that photo. Please try a different file.");
    }
  }

  // The Check Label button stays disabled until the two required fields and
  // the photo are all present.
  const ready = image !== null && brandName.trim() !== "" && abv.trim() !== "";

  /** Sends everything to the server and stores the verdict (or error). */
  async function verify() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: image!.base64,
          mediaType: image!.mediaType,
          application: {
            brandName,
            abv,
            productClass,
            netContents,
            bottler,
            countryOfOrigin,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
      } else {
        setResult(data);
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const passedCount = result
    ? result.checks.filter((c) => c.status === "match").length
    : 0;

  return (
    <>
      <Masthead active="single" />

      <main className="container">
        <p className="lede">
          Compare a label photo against the application. Enter the application
          details, add the photo, and press Check Label.
        </p>

        <div className="grid">
          <section className="card" aria-labelledby="step1">
            <h2 id="step1">
              <span className="step-number">1</span> Application details
            </h2>

            <label className="field-label" htmlFor="brand">
              Brand name <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id="brand"
              type="text"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="e.g. Old Tom Distillery"
              autoComplete="off"
              required
            />

            <label className="field-label" htmlFor="abv">
              Alcohol content (% ABV){" "}
              <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id="abv"
              type="text"
              inputMode="decimal"
              value={abv}
              onChange={(e) => setAbv(e.target.value)}
              placeholder="e.g. 13.5"
              autoComplete="off"
              required
            />

            <label className="field-label" htmlFor="class">
              Class / type <span className="hint">(optional)</span>
            </label>
            <input
              id="class"
              type="text"
              value={productClass}
              onChange={(e) => setProductClass(e.target.value)}
              placeholder="e.g. Kentucky Straight Bourbon Whiskey"
              autoComplete="off"
            />

            <label className="field-label" htmlFor="net">
              Net contents <span className="hint">(optional)</span>
            </label>
            <input
              id="net"
              type="text"
              value={netContents}
              onChange={(e) => setNetContents(e.target.value)}
              placeholder="e.g. 750 mL"
              autoComplete="off"
            />

            <label className="field-label" htmlFor="bottler">
              Bottler / producer <span className="hint">(optional)</span>
            </label>
            <input
              id="bottler"
              type="text"
              value={bottler}
              onChange={(e) => setBottler(e.target.value)}
              placeholder="e.g. Old Tom Distillery, Louisville, KY"
              autoComplete="off"
            />

            <label className="field-label" htmlFor="origin">
              Country of origin{" "}
              <span className="hint">(optional, for imports)</span>
            </label>
            <input
              id="origin"
              type="text"
              value={countryOfOrigin}
              onChange={(e) => setCountryOfOrigin(e.target.value)}
              placeholder="e.g. France"
              autoComplete="off"
            />

            <p className="required-note">* Required</p>
          </section>

          <section className="card" aria-labelledby="step2">
            <h2 id="step2">
              <span className="step-number">2</span> Label photo
            </h2>

            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="Add a label photo"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  fileInput.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                handleFile(e.dataTransfer.files?.[0]);
              }}
            >
              <UploadIcon />
              {image ? (
                <span>
                  Photo added. <strong>Click to replace it.</strong>
                </span>
              ) : (
                <span>
                  Drag the label photo here, or{" "}
                  <strong>click to choose a file</strong>
                </span>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => handleFile(e.target.files?.[0])}
            />

            {image && (
              <div className="preview">
                <img src={image.previewUrl} alt={`Label photo: ${image.name}`} />
                <button
                  className="link-button"
                  onClick={() => {
                    setImage(null);
                    setResult(null);
                  }}
                >
                  Remove photo
                </button>
              </div>
            )}

            <button
              className="verify-button"
              onClick={verify}
              disabled={!ready || busy}
            >
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Checking…
                </>
              ) : (
                "Check Label"
              )}
            </button>
          </section>
        </div>

        {/* Results area. aria-live="polite" makes screen readers announce the
          verdict when it appears, without stealing focus. */}
      <div style={{ marginTop: 24 }} aria-live="polite">
          {error && <div className="error-box">{error}</div>}

          {result && (
            <section className="card" aria-labelledby="results">
              <div className={`banner ${result.overall}`} id="results">
                <span className="banner-main">
                  <span className="banner-icon" aria-hidden="true">
                    <BannerIcon
                      status={
                        result.overall === "pass"
                          ? "match"
                          : result.overall === "fail"
                            ? "mismatch"
                            : "review"
                      }
                    />
                  </span>
                  <span>
                    {BANNER_TEXT[result.overall]}
                    <span className="banner-sub">
                      {passedCount} of {result.checks.length} checks passed
                    </span>
                  </span>
                </span>
                <span className="time-chip">
                  {(result.elapsedMs / 1000).toFixed(1)} seconds
                </span>
              </div>

              <table className="checks">
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    <th scope="col">On application</th>
                    <th scope="col">On label</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {/* data-label lets CSS re-print the column heading inside
                      each cell when the table reflows into stacked cards on
                      narrow (phone) screens. */}
                  {result.checks.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.label}</strong>
                      </td>
                      <td data-label="On application">{c.expected}</td>
                      <td data-label="On label">
                        {c.found}
                        {c.note && <div className="note">{c.note}</div>}
                      </td>
                      <td>
                        <span className={`status ${c.status}`}>
                          <StatusIcon status={c.status} />
                          {STATUS_TEXT[c.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {result.imageQualityIssue && (
                <div className="quality-flag">
                  <strong>Photo quality:</strong> {result.imageQualityIssue}.
                  Results may be incomplete; consider retaking the photo.
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
