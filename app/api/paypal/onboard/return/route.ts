import { NextResponse } from "next/server";
import { getPayPalMerchantStatus, sellerTrackingId, verifyPayPalState } from "../../../../lib/paypal-server";
import { supabaseAdmin } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = verifyPayPalState(url.searchParams.get("state") || "");
  const merchantId = url.searchParams.get("merchantIdInPayPal") || "";
  const home = new URL("/", url.origin);
  if (!userId || !merchantId) {
    home.searchParams.set("paypal", "error");
    return NextResponse.redirect(home);
  }
  try {
    const status = await getPayPalMerchantStatus(merchantId);
    if (status.tracking_id && status.tracking_id !== sellerTrackingId(userId)) throw new Error("PayPal seller identity did not match.");
    const connected = status.payments_receivable === true && status.primary_email_confirmed === true;
    const { error } = await supabaseAdmin().from("paypal_merchant_accounts").upsert({
      owner_id: userId,
      tracking_id: sellerTrackingId(userId),
      merchant_id: merchantId,
      status: connected ? "connected" : "needs_attention",
      payments_receivable: status.payments_receivable === true,
      email_confirmed: status.primary_email_confirmed === true,
      paypal_details: status,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id" });
    if (error) throw error;
    home.searchParams.set("paypal", connected ? "connected" : "attention");
  } catch {
    home.searchParams.set("paypal", "error");
  }
  return NextResponse.redirect(home);
}
