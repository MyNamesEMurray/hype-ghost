// Renders assets/icon.svg + assets/tray.svg into the PNG/ICO files the app
// and installer need. Run with: npm run icons
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const asset = (f) => path.join(root, 'assets', f);

async function render(svgPath, size) {
  return sharp(svgPath, { density: 300 }).resize(size, size).png().toBuffer();
}

mkdirSync(path.join(root, 'build'), { recursive: true });

// App icon: PNGs at standard sizes, combined into a Windows .ico
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) {
  const buf = await render(asset('icon.svg'), s);
  pngs.push(buf);
}
writeFileSync(path.join(root, 'build', 'icon.ico'), await pngToIco(pngs));
writeFileSync(asset('icon.png'), await render(asset('icon.svg'), 256));

// Tray icon (transparent ghost) at 1x and 2x
writeFileSync(asset('tray.png'), await render(asset('tray.svg'), 32));
writeFileSync(asset('tray@2x.png'), await render(asset('tray.svg'), 64));

console.log('icons written: build/icon.ico, assets/icon.png, assets/tray.png, assets/tray@2x.png');
