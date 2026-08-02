import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type PayPalMerchantStatus = {
  merchant_id?: string;
  tracking_id?: string;
  payments_receivable?: boolean;
  primary_email_confirmed?: boolean;
  products?: Array<{ name?: string; status?: string; vetting_status?: string }>;
};

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export const paypalConfig = () => {
  const sandbox = (process.env.PAYPAL_ENV || "sandbox").toLowerCase() !== "live";
  return {
    sandbox,
    baseUrl: sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com",
    clientId: required("PAYPAL_CLIENT_ID"),
    clientSecret: required("PAYPAL_CLIENT_SECRET"),
    partnerMerchantId: required("PAYPAL_PARTNER_MERCHANT_ID"),
    bnCode: required("PAYPAL_BN_CODE"),
  };
};

export async function paypalAccessToken() {
  const config = paypalConfig();
  const authorization = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(body.error_description || "PayPal authentication failed.");
  return body.access_token as string;
}

export async function paypalRequest<T>(path: string, init: RequestInit = {}) {
  const config = paypalConfig();
  const accessToken = await paypalAccessToken();
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Partner-Attribution-Id": config.bnCode,
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.details?.[0]?.description || body?.message || "PayPal request failed.";
    throw new Error(detail);
  }
  return body as T;
}

export function sellerTrackingId(userId: string) {
  return `billsplitter_${userId.replaceAll("-", "")}`;
}

export function sellerNonce() {
  return randomBytes(48).toString("base64url");
}

export function signPayPalState(userId: string) {
  const expires = Date.now() + 15 * 60 * 1000;
  const value = `${userId}.${expires}`;
  const signature = createHmac("sha256", paypalConfig().clientSecret).update(value).digest("base64url");
  return Buffer.from(`${value}.${signature}`).toString("base64url");
}

export function verifyPayPalState(state: string) {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const [userId, expiresText, signature] = decoded.split(".");
    const value = `${userId}.${expiresText}`;
    const expected = createHmac("sha256", paypalConfig().clientSecret).update(value).digest("base64url");
    if (!userId || Number(expiresText) < Date.now()) return null;
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    return userId;
  } catch {
    return null;
  }
}

export async function getPayPalMerchantStatus(merchantId: string) {
  const config = paypalConfig();
  return paypalRequest<PayPalMerchantStatus>(
    `/v1/customer/partners/${encodeURIComponent(config.partnerMerchantId)}/merchant-integrations/${encodeURIComponent(merchantId)}`,
  );
}

export async function getPayPalMerchantStatusByTrackingId(trackingId: string) {
  const config = paypalConfig();
  return paypalRequest<PayPalMerchantStatus>(
    `/v1/customer/partners/${encodeURIComponent(config.partnerMerchantId)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`,
  );
}
