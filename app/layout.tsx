import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;
  return {
    title: "Attention Lab — Why Transformer Attention Scales as N²",
    description: "An interactive explainer for token-to-token attention and the quadratic cost of full-context transformers.",
    openGraph: {
      title: "Attention Lab — N Tokens → N² Relationships",
      description: "Explore why full transformer attention creates a quadratic number of token relationships.",
      images: [{ url: `${protocol}://${host}/attention-lab-og.png`, width: 1729, height: 910, alt: "Attention Lab transformer attention visualization" }],
    },
    twitter: { card: "summary_large_image", title: "Attention Lab", description: "Explore why transformer attention scales as N².", images: [`${protocol}://${host}/attention-lab-og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
