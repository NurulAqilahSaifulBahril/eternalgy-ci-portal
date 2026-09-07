// Render an HTML file to PDF with Electron's Chromium engine.
// Usage: electron topdf.js <input.html> <output.pdf>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Running as `electron topdf.js in out`, argv is [electron, topdf.js, in, out].
// Take the last two non-flag arguments rather than guessing an offset.
const args = process.argv.slice(1).filter(a => !a.startsWith('--') && !a.endsWith('topdf.js'));
const input = path.resolve(args[0]);
const output = path.resolve(args[1]);
console.log('input :', input);
console.log('output:', output);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 1754 });
  await win.loadURL(pathToFileURL(input).toString());
  // Give webfonts/images a beat to settle before snapshotting.
  await new Promise(r => setTimeout(r, 900));
  const pdf = await win.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    preferCSSPageSize: true
  });
  fs.writeFileSync(output, pdf);
  console.log('wrote ' + output + ' (' + pdf.length + ' bytes)');
  win.destroy();
  app.quit();
}).catch(err => { console.error('FAILED:', err); app.exit(1); });
