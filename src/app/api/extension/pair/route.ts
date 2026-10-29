import { connectDB } from "@/lib/db";
import User from "@/models/User";
import { requireUser, signToken } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";
import { isPremium } from "@/lib/plan";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

const CODE_TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — easier to read off a screen

const randomCode = () =>
  Array.from(crypto.getRandomValues(new Uint32Array(6)), (n) => ALPHABET[n % ALPHABET.length]).join("");

/** GET — dashboard asks for a fresh pairing code (needs a web session). */
export const GET = handler(async () => {
  const user = await requireUser();
  await connectDB();

  /**
   * Retry on collision. `pairingCode` is now uniquely indexed, and redemption
   * looks a code up across all users — so two people holding the same live code
   * would have paired the extension to whichever document Mongo returned first.
   * Also generated from a CSPRNG rather than Math.random, since this code is a
   * short-lived credential for a 180-day token.
   */
  let code = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    code = randomCode();
    try {
      await User.findByIdAndUpdate(user._id, {
        pairingCode: code,
        pairingCodeExpires: new Date(Date.now() + CODE_TTL_MS),
      });
      break;
    } catch (err: any) {
      if (err?.code !== 11000 || attempt === 4) throw err;
    }
  }

  return ok({ code, expiresInSeconds: CODE_TTL_MS / 1000 });
});

/** POST — extension redeems the code for a long-lived bearer token. */
export const POST = handler(async (req: Request) => {
  const { code } = await req.json();
  if (!code || typeof code !== "string") return fail("Enter the 6-character code from your dashboard.", 400);

  // Codes are guessable in bulk without a limit: 32^6 is small enough to brute
  // force from one host if nothing is counting the attempts.
  await rateLimit("pair", clientIp(req), { limit: 20, windowSec: 900 });

  await connectDB();
  const user = await User.findOne({
    pairingCode: code.trim().toUpperCase(),
    pairingCodeExpires: { $gt: new Date() },
  });
  if (!user) return fail("That code is expired or incorrect. Generate a new one in Settings.", 401);

  user.pairingCode = undefined;
  user.pairingCodeExpires = undefined;
  user.lastSeenAt = new Date();
  user.extensionPairedAt = user.extensionPairedAt ?? new Date();
  user.extensionSeenAt = new Date();
  await user.save();

  const token = await signToken(
    {
      sub: String(user._id),
      email: user.email,
      scope: "extension",
      sv: Number(user.sessionVersion ?? 0),
    },
    "extension"
  );

  return ok({
    token,
    user: { id: String(user._id), name: user.name, email: user.email, premium: isPremium(user) },
  });
});
