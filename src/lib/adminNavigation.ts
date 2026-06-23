function normalizeSource(value: string | null) {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9_-]{1,64}$/.test(raw)) return null;
  return raw;
}

function normalizeReturnUrl(value: string | null) {
  const raw = (value ?? "").trim();
  if (!raw || raw.length > 1000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getSearchParams(search: string) {
  return new URLSearchParams(String(search || "").replace(/^\?/, ""));
}

export function getAdminContextSearch(search: string) {
  const params = getSearchParams(search);
  const next = new URLSearchParams();

  const source = normalizeSource(params.get("source"));
  const returnTo = normalizeReturnUrl(
    params.get("returnTo") ??
      params.get("return_to") ??
      params.get("backTo") ??
      params.get("back_to") ??
      params.get("return") ??
      params.get("back"),
  );

  if (source) next.set("source", source);
  if (returnTo) next.set("returnTo", returnTo);

  const query = next.toString();
  return query ? `?${query}` : "";
}

export function getAdminReturnInfo(search: string) {
  const params = getSearchParams(search);
  const source = normalizeSource(params.get("source"));
  const returnTo = normalizeReturnUrl(
    params.get("returnTo") ??
      params.get("return_to") ??
      params.get("backTo") ??
      params.get("back_to") ??
      params.get("return") ??
      params.get("back"),
  );

  return {
    href: returnTo,
    label:
      source === "biens-vokter-admin" || source === "biens-vokter"
        ? "← Tilbake til LEK-Biens Vokter"
        : "← Tilbake",
  };
}

export function appendAdminContext(href: string, search: string) {
  const context = getAdminContextSearch(search);
  if (!context) return href;

  const url = new URL(href, "https://varroa.local");
  const contextParams = getSearchParams(context);
  for (const [key, value] of contextParams.entries()) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }

  return `${url.pathname}${url.search}`;
}
