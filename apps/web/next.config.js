/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Proxies /api/* to the Fastify backend so the browser only ever talks to one origin —
    // simplifies cookies (no cross-site SameSite issues) for local dev and the pilot alike.
    // NOTE: API_URL is read here at build time (next.config.js runs once, during `next build`),
    // not at request time — a deployment promoted from a build that didn't have the Production
    // API_URL available bakes in the http://localhost:4000 fallback below and every /api/* call
    // 404s. Forcing a fresh commit-triggered build (this comment) is the reliable way to make
    // sure the real value gets baked in.
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/:path*` }];
  },
};

module.exports = nextConfig;
