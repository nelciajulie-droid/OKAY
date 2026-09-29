import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Boppy Studio",
  description:
    "Unofficial studio client for boppy.me AI music generation (ACE-Step)",
  keywords: ["Boppy", "boppy.me", "ACE-Step", "AI music", "music generation"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Boppy Studio",
    description:
      "Unofficial studio client for boppy.me AI music generation (ACE-Step)",
    siteName: "Boppy Studio",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <div className="dark">
          <Toaster theme="dark" position="bottom-right" />
        </div>
      </body>
    </html>
  );
}
