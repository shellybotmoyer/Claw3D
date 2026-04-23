import type { Metadata } from "next";
import { Bebas_Neue, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claw3D",
  description: "Focused operator studio for the OpenClaw gateway.",
  openGraph: {
    title: "Claw3D",
    description: "Focused operator studio for the OpenClaw gateway.",
    type: "website",
    siteName: "Claw3D",
    images: [
      {
        url: "/og-image.svg",
        width: 1200,
        height: 630,
        alt: "Claw3D - Focused Operator Studio for OpenClaw",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Claw3D",
    description: "Focused operator studio for the OpenClaw gateway.",
  },
  icons: [
    { rel: "icon", url: "/favicon.ico", type: "image/x-icon" },
    { rel: "icon", url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    { rel: "icon", url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    { rel: "apple-touch-icon", url: "/apple-touch-icon.png", sizes: "180x180" },
  ],
  manifest: "/manifest.json",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f172a",
};

const display = Bebas_Neue({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin"],
});

const sans = IBM_Plex_Sans({
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t?t==='dark':m;document.documentElement.classList.toggle('dark',d);}catch(e){}})();",
          }}
        />
      </head>
      <body className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}>
        <main className="h-screen w-screen overflow-hidden bg-background">{children}</main>
      </body>
    </html>
  );
}
