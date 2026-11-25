import type { Metadata } from "next";
import "./globals.css";
import { ToastContainer } from "@/components/ui/Toast";
import { I18nProvider } from "@/locales";

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
        <I18nProvider>
          {children}
          <ToastContainer />
        </I18nProvider>
      </body>
    </html>
  );
}
