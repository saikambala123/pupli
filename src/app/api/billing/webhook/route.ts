import { connectDB } from "@/lib/db";
import User from "@/models/User";
import { ok, fail, handler } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Stripe subscription lifecycle -> user.plan. Configure the endpoint in Stripe. */
export const POST = handler(async (req: Request) => {
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) return fail("Billing isn't configured.", 503);

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(STRIPE_SECRET_KEY);

  const signature = req.headers.get("stripe-signature");
  const raw = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature!, STRIPE_WEBHOOK_SECRET);
  } catch {
    return fail("Signature verification failed.", 400);
  }

  await connectDB();
  const obj: any = event.data.object;

  /** Stripe sends period ends as unix seconds. Fall back to ~31 days. */
  const periodEnd = (seconds?: number) =>
    seconds ? new Date(seconds * 1000) : new Date(Date.now() + 31 * 86_400_000);

  switch (event.type) {
    case "checkout.session.completed": {
      const userId = obj.client_reference_id;
      if (userId) {
        // Record `stripeCustomerId` here too. Every later event in this switch
        // is looked up by it, so a subscription started from a payment link or
        // the Stripe dashboard — where our checkout route never ran — used to
        // leave it unset, and renewals and cancellations then matched nothing
        // and silently did nothing.
        await User.findByIdAndUpdate(userId, {
          plan: "premium",
          stripeCustomerId: obj.customer,
          stripeSubscriptionId: obj.subscription,
          premiumUntil: new Date(Date.now() + 31 * 86_400_000),
        });
      }
      break;
    }

    case "invoice.paid": {
      await User.findOneAndUpdate(
        { stripeCustomerId: obj.customer },
        {
          plan: "premium",
          premiumUntil: periodEnd(obj.lines?.data?.[0]?.period?.end),
        }
      );
      break;
    }

    /**
     * A failed charge is not a cancellation. Stripe retries a declined card for
     * days (dunning) and only gives up by cancelling the subscription. Downgrading
     * on the first failure locked paying customers out over a temporary decline,
     * so this now only records the problem and lets access run to the period end.
     */
    case "invoice.payment_failed": {
      console.warn("[billing] payment failed for customer", obj.customer);
      break;
    }

    /**
     * Subscription state is authoritative. `past_due`/`unpaid` keep access until
     * Stripe resolves or cancels; anything else inactive ends it now.
     */
    case "customer.subscription.updated": {
      const status = String(obj.status ?? "");
      if (["active", "trialing", "past_due", "unpaid"].includes(status)) {
        await User.findOneAndUpdate(
          { stripeCustomerId: obj.customer },
          { plan: "premium", premiumUntil: periodEnd(obj.current_period_end) }
        );
      } else {
        await User.findOneAndUpdate(
          { stripeCustomerId: obj.customer },
          { plan: "free", premiumUntil: new Date() }
        );
      }
      break;
    }

    /**
     * Cancelled. `plan: "free"` alone was not enough to revoke anything —
     * `isPremium()` also honours `premiumUntil`, which had been set to 31 days
     * out at the last payment, so a cancelled account kept Premium for up to a
     * month. Honour the period the customer actually paid for, and no more.
     */
    case "customer.subscription.deleted": {
      await User.findOneAndUpdate(
        { stripeCustomerId: obj.customer },
        {
          plan: "free",
          premiumUntil: periodEnd(obj.current_period_end),
          stripeSubscriptionId: undefined,
        }
      );
      break;
    }
  }

  return ok({ received: true });
});
