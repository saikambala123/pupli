import Nav from "@/components/marketing/Nav";
import Footer from "@/components/marketing/Footer";
import LegalPage, { COMPANY, JURISDICTION, LAST_UPDATED, SUPPORT_EMAIL } from "@/components/marketing/LegalPage";

export const metadata = {
  title: "Terms",
  description: "The terms you agree to when you use Appli-Fill.",
};

/** Companion to /privacy — the footer links here from every page. */
export default function TermsPage() {
  return (
    <>
      <Nav />
      <LegalPage title="Terms of Service" updated={LAST_UPDATED}>
        <p>
          These terms cover your use of Appli-Fill — the website, the dashboard and the browser extension.
          Using any of them means you accept them.
        </p>

        <h2>What Appli-Fill does</h2>
        <p>
          Appli-Fill fills job application forms with information you have given it, remembers the answers
          you write, and keeps a record of the applications you send. It is a tool that types for you.
          It does not apply on your behalf: you review every form and you press submit.
        </p>

        <h2>Your account</h2>
        <ul>
          <li>You need to be at least 16 to use Appli-Fill.</li>
          <li>Keep your password to yourself — you are responsible for what happens under your account.</li>
          <li>One account per person. Don&rsquo;t share a login.</li>
          <li>Give us a real email address; it is how you recover access.</li>
        </ul>

        <h2>You are responsible for what you submit</h2>
        <p>
          This is the important one. Appli-Fill fills forms from data you provided, and automated filling
          can get things wrong — a mismatched dropdown, a stale answer, a field the page renamed. Check
          the form before you submit it. You are responsible for the accuracy of every application sent
          from your account, including anything Appli-Fill filled in. We are not responsible for the outcome
          of any application, or for an application submitted with incorrect information.
        </p>

        <h2>Fair use</h2>
        <p>Don&rsquo;t use Appli-Fill to:</p>
        <ul>
          <li>Submit applications you know to contain false information.</li>
          <li>Mass-submit applications in a way that abuses an employer&rsquo;s systems.</li>
          <li>Get around a site&rsquo;s access controls, rate limits or terms.</li>
          <li>Resell, redistribute or reverse-engineer the service.</li>
          <li>Overload our systems, or automate against our API outside the extension.</li>
        </ul>

        <h2>Third-party sites</h2>
        <p>
          Appli-Fill runs on job boards and applicant tracking systems we don&rsquo;t control. Their terms
          apply to you when you use them, they can change how their forms work at any time, and we
          can&rsquo;t promise autofill will keep working on any particular site.
        </p>

        <h2>Premium and billing</h2>
        <ul>
          <li>Premium features are listed on the pricing page and may change.</li>
          <li>Subscriptions are billed through Stripe and renew automatically until you cancel.</li>
          <li>You can cancel any time from the billing portal; access runs to the end of the period you have paid for.</li>
          <li>Except where the law requires otherwise, payments already made are non-refundable.</li>
          <li>Free trials are one per account.</li>
        </ul>

        <h2>Availability</h2>
        <p>
          Appli-Fill is provided as-is. We don&rsquo;t promise it will be uninterrupted or error-free, and
          we may change or discontinue features. We will give reasonable notice before shutting the
          service down.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent the law allows, {COMPANY} is not liable for indirect or consequential
          loss, for lost job opportunities, or for loss of data. Where liability cannot be excluded, it
          is limited to the amount you paid us in the twelve months before the claim.
        </p>

        <h2>Ending your account</h2>
        <p>
          You can stop using Appli-Fill at any time and ask us to delete your account. We may suspend an
          account that breaks these terms, and will tell you why where we can.
        </p>

        <h2>Governing law</h2>
        <p>These terms are governed by the laws of {JURISDICTION}.</p>

        <h2>Changes</h2>
        <p>
          We may update these terms. Material changes will be posted here with a new date, and
          continuing to use Appli-Fill after that means you accept them.
        </p>

        <h2>Contact</h2>
        <p>
          {COMPANY} &middot; <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </LegalPage>
      <Footer />
    </>
  );
}
