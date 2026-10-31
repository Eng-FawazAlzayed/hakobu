// Resizes build/icon.png into the browser extension icons. Run: npx electron build/ext-icons.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(() => {
  const src = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  for (const s of [16, 48, 128]) fs.writeFileSync(path.join(__dirname, '..', 'extension', 'icons', s + '.png'), src.resize({ width: s, height: s, quality: 'best' }).toPNG());
  app.quit();
});
