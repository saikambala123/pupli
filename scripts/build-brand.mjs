import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "brand/source/appli-fill-logo.png");
const dark = { r: 12, g: 23, b: 32, alpha: 1 };
const pngs = new Map();
async function save(path, data) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
async function icon(size, { padding = 0.04, opaque = false } = {}) {
  const inner = Math.round(size * (1 - 2 * padding));
  const art = await sharp(source).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: opaque ? dark : { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art, gravity: "centre" }]).png({ compressionLevel: 9 }).toBuffer();
}
for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) {
  const data = await icon(size);
  pngs.set(size, data);
  await save(`public/brand/icon-${size}.png`, data);
}
const logo = await icon(1024);
await save("public/brand/appli-fill-logo.webp", await sharp(logo).webp({ quality: 95, alphaQuality: 100 }).toBuffer());
await save("public/brand/appli-fill-logo.png", logo);
await save("brand/appli-fill-logo-4k.png", await icon(4096));
const bannerLogo = await icon(1840);
await save("brand/appli-fill-banner-4k.png", await sharp({ create: { width: 3840, height: 2160, channels: 4, background: dark } }).composite([{ input: bannerLogo, gravity: "centre" }]).png({ compressionLevel: 9 }).toBuffer());
await save("src/app/icon.png", pngs.get(512));
await save("src/app/apple-icon.png", await icon(180, { padding: 0.08, opaque: true }));
for (const size of [192, 512]) {
  await save(`public/brand/maskable-${size}.png`, await icon(size, { padding: 0.16, opaque: true }));
}
const sizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const pos = 6 + i * 16;
  header[pos] = size === 256 ? 0 : size;
  header[pos + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, pos + 4);
  header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(pngs.get(size).length, pos + 8);
  header.writeUInt32LE(offset, pos + 12);
  offset += pngs.get(size).length;
});
await save("src/app/favicon.ico", Buffer.concat([header, ...sizes.map(size => pngs.get(size))]));
for (const size of [16, 32, 48, 128, 256, 512]) {
  await save(`extension/icons/icon${size}.png`, pngs.get(size));
}
console.log("Appli-Fill branding exported: 4K artwork, web icons, Apple/Android icons and extension icons.");
