/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Proxies /api/* to the Fastify backend so the browser only ever talks to one origin —
    // simplifies cookies (no cross-site SameSite issues) for local dev and the pilot alike.
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/:path*` }];
  },
};

module.exports = nextConfig;
