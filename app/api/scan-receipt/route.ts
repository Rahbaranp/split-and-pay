import { AnalyzeExpenseCommand, TextractClient, type ExpenseField } from "@aws-sdk/client-textract";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

const scanWindows = new Map<string, { count: number; resetAt: number }>();
const ignoredLine = /^(sub\s*total|total|tax|tip|discount|change|cash|visa|mastercard|amex|balance|amount due|payment|credit|debit|fees?)(\b|\s|:)/i;

function fieldText(fields: ExpenseField[], type: string) {
  return fields.find((field) => field.Type?.Text?.toUpperCase() === type)?.ValueDetection?.Text?.trim() || "";
}

function moneyToCents(value: string) {
  const matches = [...value.replace(/,/g, "").matchAll(/-?\d+(?:\.\d{1,2})?/g)];
  const amount = matches.at(-1)?.[0];
  return amount ? Math.round(Number(amount) * 100) : 0;
}

function cleanFallbackRow(row: string) {
  return row
    .replace(/\s+[$€£]?\s*-?\d[\d,]*(?:\.\d{2})\s*$/, "")
    .replace(/^\s*\d+(?:\.\d+)?\s*[xX@]\s*/, "")
    .trim();
}

export async function POST(request: NextRequest) {
  const now = Date.now();
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const window = scanWindows.get(client);
  if (window && window.resetAt > now && window.count >= 12) {
    return Response.json({ error: "Too many receipt scans. Please wait a few minutes and try again." }, { status: 429 });
  }
  scanWindows.set(client, !window || window.resetAt <= now ? { count: 1, resetAt: now + 10 * 60_000 } : { ...window, count: window.count + 1 });

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return Response.json({ error: "Receipt scanning is not configured yet.", code: "scanner_not_configured" }, { status: 503 });
  }

  let image: string;
  try {
    const body = await request.json() as { image?: string };
    image = body.image || "";
  } catch {
    return Response.json({ error: "The receipt image could not be read." }, { status: 400 });
  }

  const match = image.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
  if (!match) return Response.json({ error: "Use a JPEG or PNG receipt image." }, { status: 400 });
  if (image.length > 10_000_000) return Response.json({ error: "The receipt photo is too large. Try a smaller photo." }, { status: 413 });

  try {
    const textract = new TextractClient({ region: process.env.AWS_REGION || "us-west-2" });
    const result = await textract.send(new AnalyzeExpenseCommand({ Document: { Bytes: Buffer.from(match[2], "base64") } }), {
      abortSignal: AbortSignal.timeout(45_000),
    });

    const items = (result.ExpenseDocuments || []).flatMap((document) =>
      (document.LineItemGroups || []).flatMap((group) =>
        (group.LineItems || []).flatMap((line) => {
          const fields = line.LineItemExpenseFields || [];
          const row = fieldText(fields, "EXPENSE_ROW");
          const name = (fieldText(fields, "ITEM") || cleanFallbackRow(row)).trim();
          const cents = moneyToCents(fieldText(fields, "PRICE") || row);
          const quantity = Math.max(1, Number.parseFloat(fieldText(fields, "QUANTITY")) || 1);
          return name && !ignoredLine.test(name) && cents > 0 && cents < 100_000_000
            ? [{ name, cents, quantity }]
            : [];
        })
      )
    ).slice(0, 200);

    return Response.json({ items });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The receipt reader could not process this photo.";
    return Response.json({ error: message }, { status: 502 });
  }
}