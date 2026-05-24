import type { NextConfig } from 'next';

const isMobileBuild = process.env.BUILD_TARGET === 'mobile';

const nextConfig: NextConfig = {
  transpilePackages: ['react-map-gl', '@lib/db-map'],
  ...(isMobileBuild && {
    output: 'export',
    images: {
      unoptimized: true,
    },
    trailingSlash: true,
  }),
};

export default nextConfig;
