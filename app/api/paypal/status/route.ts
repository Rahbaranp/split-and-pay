import { NextResponse } from "next/server";
import { authenticatedUser, supabaseAdmin } from "../../../lib/supabase-admin";
import { getPayPalMerchantStatusByTrackingId, paypalConfig, sellerTrackingId } from "../../../lib/paypal-server";

export async function GET(request: Request) {
  const user = await authenticatedUser(request);
  if (!user) return NextResponse.json({ error: "Sign in to view PayPal status." }, { status: 401 });
  const admin = supabaseAdmin();
  const { data, error } = await admin.from("paypal_merchant_accounts")
    .select("merchant_id,tracking_id,status,payments_receivable,email_confirmed,environment,updated_at")
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.status === "connected") return NextResponse.json({ account: data || null });

  try {
    const trackingId = data.tracking_id || sellerTrackingId(user.id);
    const merchant = await getPayPalMerchantStatusByTrackingId(trackingId);
    if (!merchant.merchant_id || (merchant.tracking_id && merchant.tracking_id !== trackingId)) {
      return NextResponse.json({ account: data });
    }
    const connected = merchant.payments_receivable === true && merchant.primary_email_confirmed === true;
    const updated = {
      owner_id: user.id,
      tracking_id: trackingId,
      merchant_id: merchant.merchant_id,
      environment: paypalConfig().sandbox ? "sandbox" : "live",
      status: connected ? "connected" : "needs_attention",
      payments_receivable: merchant.payments_receivable === true,
      email_confirmed: merchant.primary_email_confirmed === true,
      paypal_details: merchant,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error: saveError } = await admin.from("paypal_merchant_accounts")
      .upsert(updated, { onConflict: "owner_id" })
      .select("merchant_id,tracking_id,status,payments_receivable,email_confirmed,environment,updated_at")
      .single();
    if (saveError) throw saveError;
    return NextResponse.json({ account: saved });
  } catch (refreshError) {
    return NextResponse.json({
      account: data,
      warning: refreshError instanceof Error ? refreshError.message : "Could not refresh PayPal status.",
    });
  }
}
