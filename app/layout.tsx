/**
 * app/layout.tsx — the outer HTML shell shared by every page.
 *
 * In Next.js (App Router), this file wraps all pages: it sets the <html>
 * and <body> tags, the browser-tab title, and the font. The favicon comes
 * from app/icon.svg automatically (a Next.js convention).
 */
import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import "./globals.css";

// Public Sans is the U.S. federal design system's typeface. next/font
// downloads it at BUILD time and serves it from our own server, so the
// running app makes no calls to Google Fonts (important on locked-down
// government networks).
const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "LabelProof | Label Verification",
  description:
    "LabelProof compares an alcohol beverage label photo against its COLA application in seconds.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. ColorZilla) inject
          attributes on <body> before React hydrates, causing a false-positive
          hydration warning. Scoped to this element only. */}
      <body className={publicSans.className} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
