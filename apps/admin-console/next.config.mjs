/**
 * Next.js settings for the Live Ops console. Flags (port, bind, ledger-watch URL, key variable) are set by
 * scripts/console.ts, not here: this file only holds build behaviour and response headers.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This app lives inside a repository with other lockfiles; pin the root so Next does not guess it.
  turbopack: { root: import.meta.dirname },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
