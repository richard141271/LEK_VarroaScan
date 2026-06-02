import type { NextConfig } from "next";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const envBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
const basePathCandidate =
  envBasePath ??
  (process.env.GITHUB_PAGES === "true" && repoName ? `/${repoName}` : "");
const basePath = basePathCandidate === "/" ? "" : basePathCandidate;

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
