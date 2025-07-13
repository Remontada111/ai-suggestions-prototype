// src/app/layout.tsx
import "./globals.css"; // ← din Tailwind-fil

import type { ReactNode } from "react";

export const metadata = {
  title: "AI Ads SaaS",
  description: "Optimize ads with AI-powered recommendations",
};

/**
 * Root layout – här *måste* <html> och <body> finnas
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
        {children}
      </body>
    </html>
  );
}
