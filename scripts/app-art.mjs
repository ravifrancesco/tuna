// Renders the app icons and the TV banner from Tuna's mark (apps/common/mark.svg), with Chrome.
//   node scripts/app-art.mjs        (from the repo root; needs Google Chrome)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'apps/common');
const mark = fs.readFileSync(path.join(out, 'mark.svg'), 'utf8').replace(/<!--.*?-->/gs, '');
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const bg = 'background: radial-gradient(ellipse 80% 70% at 30% 20%, #2b1d4d 0%, #120d1f 55%, #07060c 100%);';
const svg = (size) => mark.replace('<svg ', `<svg width="${size}" height="${size}" `);
const word = (px) => `<span style="font: 800 ${px}px/1 -apple-system, 'Helvetica Neue', sans-serif; letter-spacing: -0.04em; color: #f1eefc">tuna</span>`;

const art = {
  // Mac, Android, Windows: a rounded tile with room around it.
  'icon.png': [1024, 1024, `<div style="width:824px;height:824px;border-radius:185px;${bg}display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)">${svg(560)}</div>`, true],
  // iOS masks the corners itself: a full square, no transparency.
  'icon-ios.png': [1024, 1024, `<div style="width:1024px;height:1024px;${bg}display:grid;place-items:center">${svg(640)}</div>`, false],
  // The web app's icon for home screens.
  'icon-512.png': [512, 512, `<div style="width:512px;height:512px;${bg}display:grid;place-items:center">${svg(320)}</div>`, false],
  // TV: logo above the name (Fire TV/Android TV squeeze the icon into a square).
  'tv-icon.png': [1024, 1024, `<div style="width:1024px;height:1024px;${bg}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px">${svg(420)}${word(200)}</div>`, false],
  // Android TV home-screen banner (16:9).
  'banner.png': [1280, 720, `<div style="width:1280px;height:720px;${bg}display:flex;align-items:center;justify-content:center;gap:36px">${svg(300)}${word(220)}</div>`, false],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuna-art-'));
for (const [name, [w, h, body, transparent]] of Object.entries(art)) {
  const page = path.join(tmp, `${name}.html`);
  fs.writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}body{display:grid;place-items:center}</style></head><body>${body}</body></html>`);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`, `--user-data-dir=${path.join(tmp, 'profile')}`, ...(transparent ? ['--default-background-color=00000000'] : []), `--screenshot=${path.join(out, name)}`, `file://${page}`], { stdio: 'ignore' });
  console.log('wrote', path.join('apps/common', name));
}
fs.copyFileSync(path.join(out, 'icon-512.png'), path.join(root, 'web/public/icon-512.png'));
fs.rmSync(tmp, { recursive: true, force: true });
