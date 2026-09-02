/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  // These ship prebuilt native .node binaries (@napi-rs/canvas for PDF rasterization,
  // @node-rs/argon2 for password hashing) — webpack can't bundle a native binary, so
  // they're left as real `require()`s resolved by Node at runtime instead, which is
  // also what makes them safe on Vercel's serverless Node runtime in the first place
  // (see the Next.js -> Vercel migration plan / docs/decisions/ADR-006).
  experimental: {
    serverComponentsExternalPackages: ['@napi-rs/canvas', '@node-rs/argon2', 'pdfjs-dist'],
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

module.exports = nextConfig;
