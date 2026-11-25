import type { Metadata } from "next";
import "./globals.css";
import { ToastContainer } from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "SorobanAnchor Gate — Milestone Escrow & Stellar Bridge",
  description:
    "Non-custodial milestone escrow, Freighter wallet signing, and automated off-chain anchor settlement bridge on Stellar.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased font-sans">
      <body className="min-h-full flex flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-xl focus:bg-primary focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary"
        >
          Skip to main content
        </a>
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
