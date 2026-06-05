"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onLoad = async () => {
      try {
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
        const reg = await navigator.serviceWorker.register(`${basePath}/sw.js`);
        await reg.update();
      } catch {
        return;
      }
    };

    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
