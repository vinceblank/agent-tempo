import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@temporalio/client', '@temporalio/worker'],
};

export default nextConfig;
