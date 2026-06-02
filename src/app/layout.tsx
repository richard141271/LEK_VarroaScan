import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegister } from "./sw-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LEK-VarroaScan™️",
  description: "Datainnsamling av bunnbrett-bilder for varroa",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const vercelEnv = process.env.VERCEL_ENV;
  const vercelBranch = process.env.VERCEL_GIT_COMMIT_REF;
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA;
  const appEnv = process.env.NEXT_PUBLIC_APP_ENV;
  const isStaging =
    appEnv === "staging" || (vercelEnv === "preview" && vercelBranch === "staging");
  const shortSha = vercelSha ? vercelSha.slice(0, 7) : null;

  return (
    <html
      lang="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-50">
        {isStaging ? (
          <div className="sticky top-0 z-50 border-b border-red-900 bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white">
            STAGING (ikke ekte app){shortSha ? ` • ${shortSha}` : ""}
          </div>
        ) : null}
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
