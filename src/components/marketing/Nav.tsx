"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import Logo from "@/components/ui/Logo";
const LINKS = [{href:"/#how",label:"How it works"},{href:"/#tracker",label:"Workspace"},{href:"/#responses",label:"Saved answers"},{href:"/#premium",label:"Premium"},{href:"/docs",label:"Docs"}];
export default function Nav() {
  const [open,setOpen]=useState(false);
  useEffect(()=>{ if(!open)return; const close=(e:KeyboardEvent)=>{if(e.key==="Escape")setOpen(false);}; window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close); },[open]);
  return <header className="af-nav sticky top-0 z-50">
    <nav className="container-x flex h-20 items-center justify-between gap-4" aria-label="Main navigation">
      <Link href="/" aria-label="Appli-Fill home" className="shrink-0"><Logo /></Link>
      <ul className="hidden items-center gap-1 lg:flex">{LINKS.map(l=><li key={l.href}><Link href={l.href} className="rounded-lg px-3 py-2 text-[13px] font-medium text-ink-soft transition-colors hover:bg-brand-50 hover:text-brand-600">{l.label}</Link></li>)}</ul>
      <div className="hidden items-center gap-2 lg:flex"><Link href="/auth" className="btn-ghost btn-sm">Sign in</Link><Link href="/auth?mode=signup" className="btn-primary btn-sm">Get started</Link></div>
      <button className="rounded-xl border border-line p-2.5 lg:hidden" onClick={()=>setOpen(v=>!v)} aria-label={open?"Close menu":"Open menu"} aria-expanded={open} aria-controls="mobile-navigation">{open?<X size={22}/>:<Menu size={22}/>}</button>
    </nav>
    {open&&<nav id="mobile-navigation" className="border-t border-line bg-white p-5 lg:hidden" aria-label="Mobile navigation"><ul className="space-y-1">{LINKS.map(l=><li key={l.href}><Link href={l.href} onClick={()=>setOpen(false)} className="block rounded-xl px-3 py-3 text-sm font-medium hover:bg-brand-50">{l.label}</Link></li>)}</ul><div className="mt-4 flex gap-3"><Link href="/auth" className="btn-ghost flex-1">Sign in</Link><Link href="/auth?mode=signup" className="btn-primary flex-1">Get started</Link></div></nav>}
  </header>;
}
