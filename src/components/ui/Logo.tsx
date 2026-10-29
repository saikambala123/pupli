import Image from "next/image";

export default function Logo({ dark = false, compact = false }: { dark?: boolean; compact?: boolean }) {
  return (
    <span className={`brand-lockup ${dark ? "brand-lockup--dark" : ""}`}>
      <Image src="/brand/icon-128.png" width={48} height={48} alt="" className="brand-lockup__icon" unoptimized />
      {!compact && <span className="brand-lockup__text">Appli<span>-Fill</span></span>}
    </span>
  );
}
