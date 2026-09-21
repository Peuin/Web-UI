import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Google Drive Media Workflow",
  description: "Browse Google Drive media and run Supabase/n8n workflows.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
