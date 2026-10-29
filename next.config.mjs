/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mongoose must stay a real Node module — bundling it breaks its driver.
  // (On Next 15+ this option is renamed to the top-level `serverExternalPackages`.)
  experimental: {
    serverComponentsExternalPackages: [
      "mongoose",
      "unpdf",
      "mammoth",
      // mongodb-memory-server-core ships its own mongodb@7 whose `exports`
      // field puts `default` before the named conditions, which webpack 5
      // rejects with "Default condition should be last one". Externalizing
      // it forces Node to resolve it at runtime instead of webpack bundling
      // it. Only loaded in dev when MONGODB_URI is unset; production deploys
      // set MONGODB_URI and never touch this code path.
      "mongodb-memory-server",
      "mongodb-memory-server-core",
    ],
  },
  async headers() {
    return [
      {
        // The browser extension talks to these routes cross-origin.
        // Note the wildcard origin is safe *only* because these routes
        // authenticate with a Bearer token and never with the session cookie:
        // a wildcard cannot be combined with credentialed requests.
        source: "/api/extension/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,PUT,PATCH,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
          { key: "Vary", value: "Origin" },
        ],
      },
      {
        // Baseline hardening. None of these were set, which left the dashboard
        // framable (clickjacking against the billing and settings controls) and
        // let browsers MIME-sniff API responses.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
