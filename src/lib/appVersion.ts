export function getAppVersion() {
  return (
    process.env.NEXT_PUBLIC_APP_VERSION ??
    process.env.NEXT_PUBLIC_BUILD_ID ??
    "dev"
  );
}

