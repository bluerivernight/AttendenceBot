/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { turbo: { resolveAlias: { 'node:crypto': 'crypto-browserify', 'node:stream': 'stream-browserify' } } },
};

module.exports = nextConfig;