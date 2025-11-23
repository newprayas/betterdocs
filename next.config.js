/** @type {import('next').NextConfig} */
const webpack = require('webpack');

const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },

  webpack: (config, { dev, isServer }) => {
    // Enable WebAssembly support
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    // Add support for WebAssembly files
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'webassembly/async',
    });

    // FIX: Enhanced polyfills for Supabase compatibility in Edge Runtime
    config.plugins.push(
      new webpack.DefinePlugin({
        'process.version': JSON.stringify('v18.0.0'),
        'process.versions': JSON.stringify({
          node: '18.0.0',
          v8: '10.0.0'
        }),
      })
    );

    return config;
  },
  // Headers for security
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;