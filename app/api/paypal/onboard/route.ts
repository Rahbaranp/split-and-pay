import { NextResponse } from "next/server";
import { authenticatedUser, supabaseAdmin } from "../../../lib/supabase-admin";
import { paypalConfig, paypalRequest, sellerNonce, sellerTrackingId, signPayPalState } from "../../../lib/paypal-server";

type ReferralResponse = {
  links?: Array<{ href: string; rel: string }>;
};

export async function POST(request: Request) {
  try {
    const user = await authenticatedUser(request);
    if (!user) return NextResponse.json({ error: "Sign in before connecting PayPal." }, { status: 401 });

    const origin = new URL(request.url).origin;
    const trackingId = sellerTrackingId(user.id);
    const state = signPayPalState(user.id);
    const returnUrl = `${origin}/api/paypal/onboard/return?state=${encodeURIComponent(state)}`;
    const referral = await paypalRequest<ReferralResponse>("/v2/customer/partner-referrals", {
      method: "POST",
      body: JSON.stringify({
        tracking_id: trackingId,
        operations: [{
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              third_party_details: {
                features: ["PAYMENT", "REFUND"],
              },
            },
          },
        }],
        products: ["PPCP"],
        legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
        partner_config_override: {
          return_url: returnUrl,
          return_url_description: "Return to Split & Pay",
        },
      }),
    });
    const actionUrl = referral.links?.find((link) => link.rel === "action_url")?.href;
    if (!actionUrl) throw new Error("PayPal did not return an onboarding link.");

    const { error } = await supabaseAdmin().from("paypal_merchant_accounts").upsert({
      owner_id: user.id,
      tracking_id: trackingId,
      environment: paypalConfig().sandbox ? "sandbox" : "live",
      status: "pending",
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id" });
    if (error) throw error;
    return NextResponse.json({ url: actionUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start PayPal onboarding." }, { status: 500 });
  }
}
