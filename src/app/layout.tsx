import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Summon Agent Platform",
  description: "Create, run, and monitor AI agents for Summon workspaces.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-[#0d0f0f] text-zinc-50">
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
