export type DeviceInfo = {
  userAgent: string;
  platform: string | null;
  language: string | null;
  timezone: string | null;
  screen: { width: number; height: number; devicePixelRatio: number };
};

export function getDeviceInfo(): DeviceInfo {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? null,
    language: navigator.language ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      devicePixelRatio: window.devicePixelRatio ?? 1,
    },
  };
}

