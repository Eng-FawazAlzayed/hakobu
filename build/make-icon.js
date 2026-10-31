// Renders the Hakobu icon (運) to build/icon.png (512x512) and src/renderer/logo.png. Run: npx electron build/make-icon.js
// 運 = 辶 (road / movement) + 軍, which contains 車 (cart): a cart moving along a road, the meaning of 運ぶ "to carry".
// The road radical's long tail turns into a motion arrow, so the kanji itself carries something forward.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@font-face{font-family:IconKanji;src:local("Yu Gothic Bold"),local("YuGothic-Bold"),local("Yu Gothic UI Bold"),local("Meiryo Bold");font-weight:700}
html,body{margin:0;background:transparent}
.tile{position:absolute;left:36px;top:36px;width:440px;height:440px;border-radius:112px;overflow:hidden;
  background:linear-gradient(140deg,#6d7dff 0%,#8f7bff 45%,#b38bff 100%);
  box-shadow:inset 0 8px 0 rgba(255,255,255,.22), inset 0 -10px 24px rgba(40,20,120,.35)}
.tile::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 20% 0%,rgba(255,255,255,.28),transparent 55%)}
.k{position:absolute;left:0;top:0;width:512px;height:512px;font:700 318px/1 IconKanji,"Yu Gothic",sans-serif;
  color:#fff;display:grid;place-items:center;letter-spacing:0;text-shadow:0 6px 18px rgba(40,20,120,.35);transform:translate(-30px,-14px)}
svg{position:absolute;left:0;top:0}
</style></head><body>
<div class="tile"></div>
<div class="k">運</div>
<svg style="display:var(--arrows,block)" width="512" height="512" viewBox="0 0 512 512">
  <!-- the 辶 tail sweeps on into a motion arrow: the cart (車) keeps moving down the road (辶) -->
  <path d="M 352 361 L 410 361" stroke="#fff" stroke-width="21" stroke-linecap="round" fill="none"/>
  <path d="M 392 336 L 424 361 L 392 386" stroke="#fff" stroke-width="21" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <!-- speed lines trailing behind -->
  <path d="M 52 258 L 74 258 M 44 292 L 70 292" stroke="rgba(255,255,255,.6)" stroke-width="11" stroke-linecap="round"/>
</svg>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 700));
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })).resize({ width: 512, height: 512, quality: 'best' });
  const out = process.env.ICON_OUT || path.join(__dirname, 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  if (!process.env.ICON_OUT) fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'logo.png'), img.resize({ width: 128, height: 128, quality: 'best' }).toPNG());
  app.quit();
});
