"use client";

import { useState } from "react";

/**
 * The contact form previously posted to `action="mailto:…" method="post"`,
 * which no current browser does anything useful with — Chrome silently drops
 * it, and the fields carried no `name` attributes, so even a working submit
 * would have sent an empty body. Nothing the visitor typed ever left the page.
 *
 * Composing the message into a `mailto:` link and letting the user's own mail
 * client send it works everywhere and needs no mail provider on the server. If
 * you later add an inbox endpoint, swap `href` for a POST to it.
 */
export default function ContactForm({ to }: { to: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("A form didn't fill correctly");
  const [message, setMessage] = useState("");

  const ready = name.trim() && email.trim() && message.trim();

  const href = `mailto:${to}?subject=${encodeURIComponent(`[Appli-Fill] ${topic}`)}&body=${encodeURIComponent(
    `${message}\n\n—\n${name}\n${email}`
  )}`;

  return (
    <form className="mt-10 space-y-4" onSubmit={(e) => e.preventDefault()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="c-name">Name</label>
          <input
            id="c-name" name="name" className="input" required
            value={name} onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="c-email">Email</label>
          <input
            id="c-email" name="email" type="email" className="input" required
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="c-topic">Topic</label>
        <select
          id="c-topic" name="topic" className="input"
          value={topic} onChange={(e) => setTopic(e.target.value)}
        >
          <option>A form didn&apos;t fill correctly</option>
          <option>Billing or subscription</option>
          <option>Feature request</option>
          <option>Something else</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor="c-message">Message</label>
        <textarea
          id="c-message" name="message" className="input resize-y" rows={6} required
          value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder="If a form didn't fill, paste the job link here — that's the most useful thing you can send."
        />
      </div>

      <a
        href={ready ? href : undefined}
        aria-disabled={!ready}
        className={`btn-primary inline-flex ${ready ? "" : "pointer-events-none opacity-50"}`}
      >
        Send message
      </a>
      <p className="text-[12.5px] text-ink-faint">
        This opens your email app with the message ready to send, so you keep a copy in your sent mail.
      </p>
    </form>
  );
}
