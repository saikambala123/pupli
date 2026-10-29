import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "./globals.css";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: "Appli-Fill — Your next move starts here", template: "%s · Appli-Fill" },
  description: "Spend less time filling forms. Use your profile and saved answers to complete job applications, then track every next step with Appli-Fill.",
  applicationName: "Appli-Fill",
  keywords: ["job application autofill", "Workday autofill", "Greenhouse autofill", "application tracker", "Appli-Fill"],
  appleWebApp: { capable: true, title: "Appli-Fill", statusBarStyle: "default" },
  openGraph: { title: "Appli-Fill — Your next move starts here", description: "Your profile. Your answers. Your next opportunity.", url: APP_URL, siteName: "Appli-Fill", type: "website", images: [{ url: "/brand/icon-1024.png", width: 1024, height: 1024, alt: "Appli-Fill gorilla shield logo" }] },
  twitter: { card: "summary", title: "Appli-Fill", description: "Your job search, with less busywork.", images: ["/brand/icon-512.png"] }
};
export const viewport: Viewport = { themeColor: "#0C1720", width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to content</a>{children}</body></html>;
}
