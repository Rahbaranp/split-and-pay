import { NextRequest } from "next/server";

export const runtime = "nodejs";

const lookupWindows = new Map<string, { count: number; resetAt: number }>();

type TaxJarResponse = {
  rate?: {
    zip?: string;
    state?: string;
    county?: string;
    city?: string;
    combined_rate?: number;
  };
  error?: string;
  detail?: string;
};

export async function POST(request: NextRequest) {
  const now = Date.now();
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const window = lookupWindows.get(client);
  if (window && window.resetAt > now && window.count >= 20) {
    return Response.json({ error: "Too many tax lookups. Please wait a few minutes and try again." }, { status: 429 });
  }
  lookupWindows.set(client, !window || window.resetAt <= now ? { count: 1, resetAt: now + 10 * 60_000 } : { ...window, count: window.count + 1 });

  const token = process.env.TAXJAR_API_TOKEN || "";
  if (!token) return Response.json({ error: "Tax lookup is not configured yet.", code: "tax_lookup_not_configured" }, { status: 503 });

  let zip = "";
  let city = "";
  try {
    const body = await request.json() as { zip?: string; city?: string };
    zip = (body.zip || "").trim();
    city = (body.city || "").trim();
  } catch {
    return Response.json({ error: "The location could not be read." }, { status: 400 });
  }

  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });
  if (city && !/^[\p{L} .'-]{2,80}$/u.test(city)) return Response.json({ error: "Enter a valid city name." }, { status: 400 });

  const params = new URLSearchParams({ country: "US" });
  if (city) params.set("city", city);

  try {
    const response = await fetch(`https://api.taxjar.com/v2/rates/${encodeURIComponent(zip)}?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const data = await response.json() as TaxJarResponse;
    if (!response.ok) throw new Error(data.detail || data.error || "The tax service could not find this location.");
    const combinedRate = data.rate?.combined_rate;
    if (typeof combinedRate !== "number" || !Number.isFinite(combinedRate)) throw new Error("No estimated tax rate was returned for this location.");
    return Response.json({
      rate: Number((combinedRate * 100).toFixed(4)),
      location: {
        zip: data.rate?.zip || zip,
        city: data.rate?.city || city,
        county: data.rate?.county || "",
        state: data.rate?.state || "",
      },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The tax service is unavailable right now.";
    return Response.json({ error: message }, { status: 502 });
  }
}
