import type { NextConfig } from 'next'

const config: NextConfig = {
  // S3 and CloudFront serve files, not a Node server; every route here is a client component
  output: 'export',
  // the CloudFront function maps /rules to rules/index.html, which only exists with trailing slashes on
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
}

export default config
