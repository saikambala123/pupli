import Nav from "@/components/marketing/Nav";
import Footer from "@/components/marketing/Footer";
import LegalPage, { COMPANY, LAST_UPDATED, SUPPORT_EMAIL } from "@/components/marketing/LegalPage";

export const metadata = {
  title: "Privacy",
  description: "What Appli-Fill stores, why, and how to get it back or delete it.",
};

/**
 * This page exists because the site footer links to /privacy from every page,
 * and that link was a 404 — which is also a hard blocker for a Chrome Web Store
 * listing, since an extension handling personal data must publish one.
 *
 * The content below describes what this codebase actually does with data, which
 * is the part only you can't outsource. The bracketed values in LegalPage.tsx
 * (company name, jurisdiction, address) still need filling in, and a lawyer
 * should review it before you rely on it — this is an accurate technical
 * description, not legal advice.
 */
export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <LegalPage title="Privacy Policy" updated={LAST_UPDATED}>
        <p>
          Appli-Fill fills in job application forms on your behalf. To do that it has to hold the
          information those forms ask for. This page says exactly what is stored, where, and how to get
          rid of it.
        </p>

        <h2>What we store</h2>
        <p>Everything below is data you enter, import, or that the extension captures as you apply.</p>
        <ul>
          <li>
            <b>Account</b> — your email address, a bcrypt hash of your password (never the password
            itself), and, if you sign in with Google, your Google account id, name and profile picture
            URL.
          </li>
          <li>
            <b>Application profile</b> — name, contact details, postal address, work history,
            education, skills, links and work-eligibility answers.
          </li>
          <li>
            <b>Documents</b> — resumes and cover letters you upload, stored as file data on your
            profile so the extension can attach them to applications.
          </li>
          <li>
            <b>Saved answers</b> — the free-text answers you write to application questions, so the
            same question can be filled automatically next time.
          </li>
          <li>
            <b>Application history</b> — the role, company, link and status of each application you
            submit or add.
          </li>
          <li>
            <b>Voluntary demographic answers</b> — if you choose to enter them, gender, race or
            ethnicity, veteran status and disability status, so US equal-opportunity questions can be
            filled. These are optional, they are never inferred, and leaving them blank means those
            questions are simply left blank on the form. See the section below.
          </li>
        </ul>

        <h2>Demographic and health-related answers</h2>
        <p>
          Race, ethnicity, disability status and veteran status are treated as sensitive personal data
          under laws including the EU/UK GDPR (Article 9) and India&rsquo;s Digital Personal Data
          Protection Act. We store them only because you typed them in, only to answer the voluntary
          self-identification questions on job applications, and we never use them for anything else.
          You can clear these fields at any time from your profile, or answer them with &ldquo;decline
          to self-identify&rdquo; instead.
        </p>

        <h2>What we do not do</h2>
        <ul>
          <li>We do not sell your data, and we do not share it with advertisers.</li>
          <li>We do not read the pages you browse. The extension only acts on a page when you ask it to.</li>
          <li>We do not submit applications for you — you press submit yourself.</li>
        </ul>

        <h2>Who else processes it</h2>
        <p>
          Running the service means a small number of providers handle data on our behalf:
        </p>
        <ul>
          <li><b>MongoDB Atlas</b> — the database where your account, profile and applications live.</li>
          <li><b>Vercel</b> — hosting for the website and its API.</li>
          <li><b>Google (Gemini API)</b> — reads your resume when you ask us to parse it, and drafts answers when you use that feature. Not used unless you trigger it.</li>
          <li><b>Stripe</b> — payments, if you subscribe. Card details go to Stripe and never reach our servers.</li>
          <li><b>Resend</b> — password reset and confirmation emails.</li>
        </ul>

        <h2>How long we keep it</h2>
        <p>
          Your data is kept for as long as your account exists. Delete your account and the account,
          profiles, documents, saved answers and application history are removed. Backups roll off on
          their own schedule.
        </p>

        <h2>Your rights</h2>
        <p>
          Depending on where you live you may have the right to access, correct, export or delete your
          data, and to withdraw consent for the optional fields above. You can export a profile as JSON
          and edit or clear any field from the dashboard at any time. For access or deletion requests,
          email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>

        <h2>Security</h2>
        <p>
          Passwords are hashed with bcrypt. Sessions use signed tokens over HTTPS. Password reset and
          email confirmation links are stored only as hashes, so a database dump cannot be used to reset
          anyone&rsquo;s password. No system is perfectly secure, and we will tell you if something
          material goes wrong.
        </p>

        <h2>Children</h2>
        <p>Appli-Fill is not intended for anyone under 16, and we do not knowingly collect their data.</p>

        <h2>Changes</h2>
        <p>
          If this policy changes materially we will say so here and update the date at the top.
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
