import { NextRequest } from "next/server";

export const runtime = "nodejs";

const lookupWindows = new Map<string, { count: number; resetAt: number }>();

type AvalaraResponse = {
  totalRate?: number;
  error?: { message?: string; details?: { message?: string }[] };
};

export async function POST(request: NextRequest) {
  const now = Date.now();
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const window = lookupWindows.get(client);
  if (window && window.resetAt > now && window.count >= 20) {
    return Response.json({ error: "Too many tax lookups. Please wait a few minutes and try again." }, { status: 429 });
  }
  lookupWindows.set(client, !window || window.resetAt <= now ? { count: 1, resetAt: now + 10 * 60_000 } : { ...window, count: window.count + 1 });

  const accountId = process.env.AVALARA_ACCOUNT_ID || "";
  const licenseKey = process.env.AVALARA_LICENSE_KEY || "";
  if (!accountId || !licenseKey) return Response.json({ error: "Tax lookup is not configured yet.", code: "tax_lookup_not_configured" }, { status: 503 });

  let zip = "";
  try {
    const body = await request.json() as { zip?: string };
    zip = (body.zip || "").trim();
  } catch {
    return Response.json({ error: "The ZIP code could not be read." }, { status: 400 });
  }
  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) return Response.json({ error: "Enter a valid 5-digit ZIP code." }, { status: 400 });

  const params = new URLSearchParams({ country: "US", postalCode: zip });
  const authorization = Buffer.from(`${accountId}:${licenseKey}`).toString("base64");
  try {
    const response = await fetch(`https://rest.avatax.com/api/v2/taxrates/bypostalcode?${params}`, {
      headers: {
        Authorization: `Basic ${authorization}`,
        "X-Avalara-Client": "SplitAndPay; 0.1.39; ZipTaxLookup; pooya-r26",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const data = await response.json() as AvalaraResponse;
    if (!response.ok) {
      const detail = data.error?.details?.[0]?.message;
      throw new Error(detail || data.error?.message || "The tax service could not find this ZIP code.");
    }
    if (typeof data.totalRate !== "number" || !Number.isFinite(data.totalRate)) throw new Error("No estimated tax rate was returned for this ZIP code.");
    return Response.json({ rate: Number((data.totalRate * 100).toFixed(4)), location: { zip } });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The tax service is unavailable right now.";
    return Response.json({ error: message }, { status: 502 });
  }
}
