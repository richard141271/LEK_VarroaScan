export function getAppVersion() {
  const env =
    process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.NEXT_PUBLIC_BUILD_ID ?? null;
  if (env) return env;

  if (typeof document !== "undefined") {
    const build = document.documentElement.getAttribute("data-build") ?? "";
    if (build) return build;
  }

  return "dev";
}
