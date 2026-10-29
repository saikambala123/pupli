import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  theme: { extend: {
    colors: {
      ink: { DEFAULT: "#15232D", soft: "#52636F", faint: "#6F7E8A" },
      canvas: "#F2F5F6", line: "#DEE5E8", night: "#0C1720",
      brand: { 50: "#FFF3E9", 100: "#FFE2CB", 200: "#FFC5A0", 300: "#FFAB71", 400: "#FF863D", 500: "#C94D0B", 600: "#A83A09", 700: "#83300D", 800: "#172A36", 900: "#0C1720" },
      teal: { 300: "#A1F2EB", 400: "#5FE4DC", 500: "#00858A", 600: "#006B72" },
      amber: { 200: "#FFE7A3", 300: "#FFD16C", 400: "#FFC44D", 500: "#ECA218", 600: "#946000" },
      danger: { 500: "#C63C43", 600: "#AB2831" }
    },
    fontFamily: { display: ["Manrope Variable", "system-ui", "sans-serif"], sans: ["Inter Variable", "system-ui", "sans-serif"], mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"] },
    borderRadius: { xl: "14px", "2xl": "20px", "3xl": "28px" },
    boxShadow: { card: "0 2px 3px rgba(12,23,32,.025), 0 12px 36px -24px rgba(12,23,32,.22)", lift: "0 24px 64px -28px rgba(12,23,32,.30)", ring: "0 0 0 4px rgba(0,133,138,.12)" },
    keyframes: {
      scanline: { "0%": { transform: "translateY(-8%)" }, "100%": { transform: "translateY(760%)" } },
      pop: { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "none" } },
      marquee: { from: { transform: "translateX(0)" }, to: { transform: "translateX(-50%)" } },
      pulseDot: { "0%,100%": { opacity: "1" }, "50%": { opacity: ".35" } }
    },
    animation: { scanline: "scanline 2.6s cubic-bezier(.4,0,.2,1) infinite", pop: "pop .4s cubic-bezier(.2,.8,.2,1) both", marquee: "marquee 45s linear infinite", pulseDot: "pulseDot 1.4s ease-in-out infinite" }
  }},
  plugins: []
};
export default config;
