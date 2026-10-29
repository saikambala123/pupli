import Link from "next/link";
import Nav from "@/components/marketing/Nav";
import Footer from "@/components/marketing/Footer";
import ContactForm from "@/components/marketing/ContactForm";

// Set NEXT_PUBLIC_SUPPORT_EMAIL to your real inbox — the page shipped with a
// placeholder address that went nowhere.
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "";

export const metadata = { title: "Contact" };

export default function ContactPage() {
  return (
    <>
      <Nav />
      <main id="main-content" className="container-x max-w-[640px] py-16">
        <p className="eyebrow">Contact</p>
        <h1 className="mt-3 font-display text-[36px] font-extrabold tracking-[-.02em]">Get in touch</h1>
        <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
          Found a site where autofill misses fields? Send the job link — adapters get written from real
          examples, so a broken form is the most useful thing you can report.
        </p>

        {SUPPORT_EMAIL ? <ContactForm to={SUPPORT_EMAIL} /> : <div className="card mt-8 p-6"><h2 className="text-lg font-bold">Find help in the guides</h2><p className="mt-2 text-sm leading-relaxed text-ink-soft">Email support is not available yet. Our guides cover setup, pairing, profile data and saved answers.</p><Link href="/docs" className="btn-primary mt-5">Browse help</Link></div>}
      </main>
      <Footer />
    </>
  );
}
