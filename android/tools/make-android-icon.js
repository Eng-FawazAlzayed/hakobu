// Renders the Windows Hakobu icon (運 + motion arrow, build/make-icon.js) as Android adaptive-icon layers.
// Run from the desktop repo (needs electron): npx electron android/tools/make-android-icon.js android/app/src/main/res
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const res = process.argv[process.argv.length - 1];

const fg = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@font-face{font-family:IconKanji;src:local("Yu Gothic Bold"),local("YuGothic-Bold"),local("Yu Gothic UI Bold"),local("Meiryo Bold");font-weight:700}
html,body{margin:0;background:transparent}
.layer{position:absolute;left:0;top:0;width:512px;height:512px;transform:scale(SCALE);transform-origin:256px 256px}
.k{position:absolute;left:0;top:0;width:512px;height:512px;font:700 318px/1 IconKanji,"Yu Gothic",sans-serif;
  color:#fff;display:grid;place-items:center;text-shadow:SHADOW;transform:translate(-30px,-14px)}
svg{position:absolute;left:0;top:0}
</style></head><body><div class="layer">
<div class="k">運</div>
<svg width="512" height="512" viewBox="0 0 512 512">
  <path d="M 352 361 L 410 361" stroke="#fff" stroke-width="21" stroke-linecap="round" fill="none"/>
  <path d="M 392 336 L 424 361 L 392 386" stroke="#fff" stroke-width="21" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M 52 258 L 74 258 M 44 292 L 70 292" stroke="SPEED" stroke-width="11" stroke-linecap="round"/>
</svg></div></body></html>`;
const bg = `<!doctype html><html><head><style>html,body{margin:0}
.t{position:absolute;inset:0;width:512px;height:512px;background:linear-gradient(140deg,#6d7dff 0%,#8f7bff 45%,#b38bff 100%)}
.t::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 20% 0%,rgba(255,255,255,.28),transparent 55%)}
</style></head><body><div class="t"></div></body></html>`;

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
async function render(win, html, name) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  for (const [d, m] of Object.entries(densities)) {
    const dir = path.join(res, 'mipmap-' + d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), img.resize({ width: 108 * m, height: 108 * m, quality: 'best' }).toPNG());
  }
  return img;
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  // 0.8 keeps the kanji and its arrow inside the 66dp safe zone of the 108dp adaptive canvas
  const layer = (shadow, speed) => fg.replace('SCALE', '0.8').replace('SHADOW', shadow).replace('SPEED', speed);
  await render(win, layer('0 6px 18px rgba(40,20,120,.35)', 'rgba(255,255,255,.6)'), 'ic_launcher_foreground');
  await render(win, layer('none', '#fff'), 'ic_launcher_monochrome');
  await render(win, bg, 'ic_launcher_background');
  app.quit();
});
