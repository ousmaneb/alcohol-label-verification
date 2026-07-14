import Link from "next/link";

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2l8 3.5v5.5c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5.5L12 2z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
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
            <ShieldIcon />
          </div>
          <div className="masthead-text">
            <div className="eyebrow">Label Compliance Division</div>
            <h1>Label Verification</h1>
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
        Prototype for demonstration. Verification results are advisory and
        require confirmation by a compliance agent.
      </div>
    </footer>
  );
}
