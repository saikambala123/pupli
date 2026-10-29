import Image from "next/image";
import Link from "next/link";
import Nav from "@/components/marketing/Nav";
import Footer from "@/components/marketing/Footer";
import AutofillDemo from "@/components/marketing/AutofillDemo";
import Faq from "@/components/marketing/Faq";
import { Layers, MousePointer2, MessageSquareQuote, BriefcaseBusiness, ShieldCheck, Check, Puzzle, Sparkles, ListChecks } from "lucide-react";

const steps = [
  { number: "01", title: "Make it yours", body: "Upload your résumé, review your profile, and save your work history, education and preferences.", icon: Layers },
  { number: "02", title: "Fill with confidence", body: "Open an application and let the extension use your profile and saved answers. Review everything before you submit.", icon: MousePointer2 },
  { number: "03", title: "Build on every answer", body: "Save the answers you write and the edits you make. Keep useful responses ready for the next application.", icon: MessageSquareQuote },
];
export default function HomePage() {
  return <>
    <Nav />
    <main id="main-content">
      <section className="af-hero">
        <div className="container-x af-hero-grid relative">
          <div className="relative">
            <span className="af-tag"><Puzzle size={15} /> Your job search, with less busywork</span>
            <h1 className="af-hero-title mt-7">Less form filling.<br />More <em>forward<br className="hidden xl:block" /> momentum.</em></h1>
            <p className="af-hero-copy">Meet Appli-Fill. One profile, answers that stay with you, and a clear view of every application. Put your energy into your next opportunity.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/auth?mode=signup" className="btn af-primary-on-dark px-6">Start applying smarter</Link>
              <Link href="/docs#install" className="btn af-secondary-on-dark">Install the extension</Link>
            </div>
            <div className="af-proof">
              <span><Check size={15} className="text-teal-400" /> Free to get started</span>
              <span><Check size={15} className="text-teal-400" /> You review and submit</span>
              <span><Check size={15} className="text-teal-400" /> Chrome, Edge & Firefox</span>
            </div>
          </div>
          <div className="af-hero-art">
            <Image src="/brand/appli-fill-logo.webp" width={1024} height={1024} alt="Appli-Fill gorilla mascot with orange hat and turquoise shield" priority sizes="(max-width: 640px) 280px, (max-width: 1023px) 340px, 540px" />
            <p className="af-hero-note"><ShieldCheck size={17} className="text-teal-400" /> Your experience. Your answers. Your control.</p>
          </div>
        </div>
      </section>
      <section className="af-platforms" aria-label="Supported application platforms">
        <div className="container-x">
          <p className="mb-5 text-center text-xs font-semibold uppercase tracking-[.15em] text-ink-faint">Made for the places you apply</p>
          <div className="af-platform-list">{["Workday", "Greenhouse", "Lever", "Ashby", "iCIMS", "SmartRecruiters"].map(name => <span key={name}>{name}</span>)}</div>
        </div>
      </section>
      <section id="how" className="container-x af-section">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div><p className="eyebrow">A simpler routine</p><h2 className="af-section-heading mt-3 max-w-[600px]">Set up once.<br />Keep moving forward.</h2></div>
          <p className="max-w-[330px] text-base leading-relaxed text-ink-soft">Bring your profile, answers and application history into one connected workspace.</p>
        </div>
        <ol className="mt-10 grid gap-5 md:grid-cols-3">{steps.map(step => <li key={step.number} className="af-feature">
          <div className="flex items-center justify-between"><span className="af-feature-icon"><step.icon size={22} /></span><span className="font-mono text-sm text-ink-faint">{step.number}</span></div>
          <h3 className="mt-7 text-xl font-bold">{step.title}</h3><p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{step.body}</p>
        </li>)}</ol>
      </section>
      <section className="border-y border-line bg-white">
        <div className="container-x af-section">
          <div className="mx-auto mb-10 max-w-[680px] text-center"><p className="eyebrow">Meet your application assistant</p><h2 className="af-section-heading mt-3">Your details, right where they belong.</h2><p className="mt-5 text-base leading-relaxed text-ink-soft">The extension brings together your profile and saved answers. New questions can become drafts for you to review.</p></div>
          <div className="mx-auto max-w-[940px]"><AutofillDemo /></div>
          <p className="mt-4 text-center text-xs text-ink-faint">Interactive preview with sample profile data. Actual form support varies by website.</p>
        </div>
      </section>
      <section id="tracker" className="container-x af-section">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <div><p className="eyebrow">Your search, organized</p><h2 className="af-section-heading mt-3">See the bigger picture.<br />Know your next step.</h2><p className="mt-5 max-w-[500px] text-base leading-relaxed text-ink-soft">Keep your roles, companies and progress together. Follow each application from saved to interview and offer, without losing the details.</p>
            <ul className="mt-7 space-y-4">{["Track roles across your application pipeline", "Review your recent applications and activity", "Set a daily goal and see your progress"].map(text => <li key={text} className="flex gap-3 text-sm text-ink-soft"><Check size={18} className="shrink-0 text-teal-600" />{text}</li>)}</ul>
            <Link href="/dashboard/applications" className="btn-dark mt-8">Open your workspace</Link>
          </div>
          <div className="af-dark-panel p-7 sm:p-10">
            <div className="flex items-center justify-between border-b border-white/10 pb-6"><BriefcaseBusiness size={26} className="text-teal-400" /><span className="text-xs uppercase tracking-[.14em] text-slate-400">Application journey</span></div>
            <ol className="mt-3">{[["01", "Saved", "An opportunity worth exploring"], ["02", "Applied", "Your application is on its way"], ["03", "Interview", "Time to make your experience count"], ["04", "Offer", "A new chapter awaits"]].map(([n,title,body],i) => <li key={n} className="flex gap-5 border-b border-white/[.07] py-5 last:border-0"><span className={`mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold ${i===2?"bg-teal-400 text-night":"bg-white/[.06] text-slate-400"}`}>{n}</span><div><h3 className="font-bold">{title}</h3><p className="mt-1 text-sm">{body}</p></div></li>)}</ol>
          </div>
        </div>
      </section>
      <section id="responses" className="border-y border-line bg-white">
        <div className="container-x af-section grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <div className="order-2 rounded-3xl border border-line bg-canvas p-6 sm:p-8 lg:order-1">
            <div className="flex items-center gap-3"><MessageSquareQuote className="text-brand-500" size={24} /><h3 className="text-xl font-bold">A little less repetition.</h3></div>
            {[["Your profile", "Contact details, experience, education and preferences."], ["Your saved answers", "The responses you have already written and approved."], ["Your review", "A chance to check, edit and decide what gets submitted."]].map(([title,body]) => <div key={title} className="mt-4 rounded-2xl border border-line bg-white p-5"><p className="text-sm font-semibold">{title}</p><p className="mt-2 text-sm leading-relaxed text-ink-soft">{body}</p></div>)}
          </div>
          <div className="order-1 lg:order-2"><p className="eyebrow">Answers that stay with you</p><h2 className="af-section-heading mt-3">Good answers deserve<br />a second application.</h2><p className="mt-5 text-base leading-relaxed text-ink-soft">Save a response once, find it when you need it, and reuse it on matching questions. Your answer library grows with your search.</p><Link href="/dashboard/responses" className="btn-primary mt-8">Build your answer library</Link></div>
        </div>
      </section>
      <section id="premium" className="af-hero af-section">
        <div className="container-x relative grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div><span className="af-tag"><Sparkles size={15} /> Appli-Fill Premium</span><h2 className="af-section-heading mt-5">A sharper toolkit<br />for your next move.</h2><p className="mt-5 max-w-[460px] text-base leading-relaxed text-slate-300">Keep a profile for each career direction, compare your fit, and draft answers grounded in your experience.</p><Link href="/auth?mode=signup" className="btn af-primary-on-dark mt-7">Try Premium</Link><p className="mt-4 text-sm text-slate-400">3-day trial · No card needed to start</p></div>
          <div className="space-y-4">{[[Layers,"Multiple profiles","Adapt your experience to different roles without starting over."],[ListChecks,"Profile scoring","Understand how your profile lines up with a job posting."],[Sparkles,"AI answer drafts","Get a starting point for new questions, then make it yours."]].map(([Icon,title,body])=>{const I=Icon as typeof Layers;return <div key={String(title)} className="flex gap-5 rounded-2xl border border-white/10 bg-white/[.035] p-6"><I className="mt-1 h-6 w-6 shrink-0 text-teal-400" /><div><h3 className="text-lg font-bold">{String(title)}</h3><p className="mt-2 text-sm leading-relaxed text-slate-300">{String(body)}</p></div></div>;})}</div>
        </div>
      </section>
      <Faq />
      <section className="border-t border-line bg-white py-16 sm:py-24"><div className="container-x text-center"><p className="eyebrow">Your next chapter</p><h2 className="af-section-heading mx-auto mt-4 max-w-[650px]">Bring your ambition.<br />Leave the busywork to Appli-Fill.</h2><Link href="/auth?mode=signup" className="btn-primary mt-8">Create your free account</Link></div></section>
    </main>
    <Footer />
  </>;
}
