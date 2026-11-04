import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChainAim NEAR Live Ops",
  description: "What near-watch sees of NEAR USDC payments to the paywall, from final-block chain data and the paywall's own claims only.",
  robots: { index: false, follow: false },
};

/** Applies the theme the viewer chose last time before the first paint (per-browser convenience only). */
const THEME_SCRIPT = `try{var t=localStorage.getItem("cs-theme");if(t==="cream"||t==="ink")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="ink" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- same fonts as the liveops demo; loaded by the browser, not at build time */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
