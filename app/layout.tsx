import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const TITLE = "ContextScope";
const DESCRIPTION = "See what filled your coding agent's context window — request by request, locally. A profiler for Claude Code and Codex sessions: where the context went, what subagents cost and returned, and the one setup change to make first.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;
  return {
    title: TITLE,
    description: DESCRIPTION,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: TITLE,
      description: "See what filled your coding agent's context window — request by request, locally.",
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "ContextScope: a session's context occupancy chart on the dark theme" }],
    },
    twitter: { card: "summary_large_image", title: TITLE, description: "See what filled your coding agent's context window — request by request, locally.", images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
