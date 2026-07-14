import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import "./globals.css";

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
