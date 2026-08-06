import { NextRequest } from "next/server";

export const runtime = "nodejs";

const scanWindows = new Map<string, { count: number; resetAt: number }>();
const ignoredLine = /^(sub\s*total|total|tax|tip|discount|change|cash|visa|mastercard|amex|balance|amount due|payment|credit|debit|fees?)(\b|\s|:)/i;

type ExpenseField = { Type?: { Text?: string }; ValueDetection?: { Text?: string } };
type TextractResult = { ExpenseDocuments?: { SummaryFields?: ExpenseField[]; LineItemGroups?: { LineItems?: { LineItemExpenseFields?: ExpenseField[] }[] }[] }[] };

const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
async function sha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function hmac(key: BufferSource, value: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}
async function analyzeExpense(imageBase64: string) {
  const region = process.env.AWS_REGION || "us-east-1";
  const accessKey = process.env.AWS_ACCESS_KEY_ID || "";
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY || "";
  const host = `textract.${region}.amazonaws.com`;
  const target = "Textract.AnalyzeExpense";
  const contentType = "application/x-amz-json-1.1";
  const body = JSON.stringify({ Document: { Bytes: imageBase64 } });
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-date;x-amz-target";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:${target}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${await sha256(body)}`;
  const scope = `${dateStamp}/${region}/textract/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonicalRequest)}`;
  const dateKey = await hmac(encoder.encode(`AWS4${secretKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "textract");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/`, { method: "POST", headers: { "content-type": contentType, "x-amz-date": amzDate, "x-amz-target": target, authorization }, body, signal: AbortSignal.timeout(45_000) });
  const data = await response.json() as TextractResult & { Message?: string; message?: string };
  if (!response.ok) throw new Error(data.Message || data.message || `AWS Textract returned ${response.status}.`);
  return data;
}

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
    const result = await analyzeExpense(match[2]);

    const documents = result.ExpenseDocuments || [];
    const items = documents.flatMap((document) =>
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

    const taxCents = documents.reduce((sum, document) => sum + moneyToCents(fieldText(document.SummaryFields || [], "TAX")), 0);
    return Response.json({ items, taxCents });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The receipt reader could not process this photo.";
    return Response.json({ error: message }, { status: 502 });
  }
}
