/**
 * components/SiteChrome.tsx — the shared page "frame".
 *
 * Both pages (single check and batch check) render the same masthead and
 * footer, so they live here once instead of being duplicated. The masthead
 * holds the LabelProof logo, the division eyebrow, and the two-tab
 * navigation; `active` controls which tab is highlighted.
 */
import Link from "next/link";

/**
 * LabelProof mark: a label tag with a verification check.
 * Colors are props so the same mark works on light backgrounds (green tag)
 * and on the dark green masthead (white tag).
 */
export function LogoMark({
  tagFill = "#1b9a1b",
  holeFill = "#f5c400",
  checkStroke = "#ffffff",
}: {
  tagFill?: string;
  holeFill?: string;
  checkStroke?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"
        fill={tagFill}
      />
      <circle cx="7.3" cy="7.3" r="1.7" fill={holeFill} />
      <path
        d="M10.4 13.2l2.2 2.2 4.3-4.9"
        fill="none"
        stroke={checkStroke}
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Masthead({ active }: { active: "single" | "batch" }) {
  return (
    <>
      <div className="brand-band" aria-hidden="true" />
      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand-mark" aria-hidden="true">
            <LogoMark
              tagFill="#ffffff"
              holeFill="#f5c400"
              checkStroke="#0a520a"
            />
          </div>
          <div className="masthead-text">
            <div className="eyebrow">Label Compliance Division</div>
            <h1>
              Label<span className="wordmark-accent">Proof</span>
            </h1>
          </div>
          <nav className="masthead-nav" aria-label="Mode">
            <Link
              href="/"
              className={active === "single" ? "active" : ""}
              aria-current={active === "single" ? "page" : undefined}
            >
              Single label
            </Link>
            <Link
              href="/batch"
              className={active === "batch" ? "active" : ""}
              aria-current={active === "batch" ? "page" : undefined}
            >
              Batch check
            </Link>
          </nav>
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        LabelProof is a prototype for demonstration. Verification results are
        advisory and require confirmation by a compliance agent.
      </div>
    </footer>
  );
}
