'use strict';

const { app, BrowserWindow, Menu, protocol, net, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const { parseEnv, searchInvoices, invoicePayments, kvGet, kvSet, staffSignIn } = require('./invoice-lookup');

// The renderer is served over a custom app:// scheme rather than file://.
// That gives it a real, stable origin, so localStorage (where the whole
// portal keeps its data) persists across app updates instead of being
// tied to a file path or a shifting localhost port.
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://portal`;

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

let mainWindow = null;
let updateDownloaded = null;   // holds the UpdateInfo once an update is ready

function resolveAsset(urlPath){
  // Map app://portal/<file> onto the packaged app directory, refusing anything
  // that tries to climb out of it.
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(__dirname, rel);
  if(full !== __dirname && !full.startsWith(__dirname + path.sep)) return null;
  return full;
}

function createWindow(){
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#F5F7FA',
    show: false,
    title: 'Eternalgy C&I Portal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', ()=> mainWindow.show());
  mainWindow.loadURL(`${ORIGIN}/index.html`);

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url })=>{
    if(/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url)=>{
    if(!url.startsWith(ORIGIN)){
      e.preventDefault();
      if(/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', ()=> { mainWindow = null; });
}

/* ---------------------------------------------------------
   AUTO-UPDATE
   Checks GitHub Releases on launch. Downloads in the background, then
   tells the renderer so it can offer "Restart now" — deliberately not
   silent, because the user's data lives in the running app and a
   surprise restart could interrupt an edit in progress.
--------------------------------------------------------- */
let updateCheckIsManual = false;

function setupUpdates(){
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', info => {
    updateDownloaded = info;
    if(mainWindow && !mainWindow.isDestroyed()){
      mainWindow.webContents.send('update:ready', { version: info.version });
    }
  });

  autoUpdater.on('update-not-available', ()=>{
    if(updateCheckIsManual){
      updateCheckIsManual = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'No update available',
        message: `You're on the latest version (${app.getVersion()}).`,
        buttons: ['OK']
      });
    }
  });

  autoUpdater.on('error', err => {
    // Offline or a throttled feed is normal — never block the app over it.
    console.error('[updater]', err == null ? 'unknown error' : (err.message || err));
    if(updateCheckIsManual){
      updateCheckIsManual = false;
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Update check failed',
        message: 'Could not reach the update server. Check your connection and try again.',
        buttons: ['OK']
      });
    }
  });

  ipcMain.handle('update:restart', ()=>{
    if(!updateDownloaded) return false;
    // isSilent=false so NSIS shows its progress; isForceRunAfter=true reopens the app.
    autoUpdater.quitAndInstall(false, true);
    return true;
  });

  // The releases repo is private: a read-only token (bundled in the connection file) lets the updater see it.
  const ghToken = dbEnv().GH_UPDATE_TOKEN;
  if(ghToken) process.env.GH_TOKEN = ghToken;
  if(app.isPackaged) autoUpdater.checkForUpdates().catch(()=>{});
}

/* ---------------------------------------------------------
   INVOICE LOOKUP (prod_main + NUrul_DB)
   The database keys are NOT in the installer. Each PC imports its own
   connection file once (File → Database Connection), which is copied to
   the app's data folder. Only this main process reads it; the page asks
   for search results over IPC and never sees the keys.
--------------------------------------------------------- */
const DB_KEYS_REQUIRED = ['PG_PROXY_URL', 'PG_PROXY_DATABASE', 'PG_PROXY_TOKEN'];
function dbConfigPath(){ return path.join(app.getPath('userData'), 'portal-db.env'); }
let dbEnvCache = null;
function dbEnv(){
  if(dbEnvCache) return dbEnvCache;
  // A file imported on this PC wins; otherwise use the connection file bundled in the installer.
  for(const p of [dbConfigPath(), path.join(process.resourcesPath || '', 'portal-db.env')]){
    try { dbEnvCache = parseEnv(fs.readFileSync(p, 'utf8')); return dbEnvCache; } catch {}
  }
  dbEnvCache = {};
  return dbEnvCache;
}

function setupSharedStorage(){
  // Shared portal data lives in NUrul_DB (public.portal_kv). Only offered when this PC has its keys.
  ipcMain.on('kv:enabled', e => { const v = dbEnv(); e.returnValue = !!(v.NURUL_PG_PROXY_URL && v.NURUL_PG_PROXY_DATABASE && v.NURUL_PG_PROXY_TOKEN); });
  ipcMain.handle('kv:get', async (_e, key)=>({ value: await kvGet(dbEnv(), String(key)) }));
  ipcMain.handle('kv:set', async (_e, key, value)=>{
    if(typeof value !== 'string' || value.length > 40 * 1024 * 1024) throw new Error('Value too large');
    return kvSet(dbEnv(), String(key), value, require('node:os').userInfo().username);
  });
}

function setupStaffSignIn(){
  ipcMain.handle('staff:signin', async (_event, phone)=> (await staffSignIn(dbEnv(), String(phone || '').slice(0, 20))).body);
}

function setupInvoiceLookup(){
  ipcMain.handle('invoices:payments', async (_event, p)=>{
    const r = await invoicePayments(dbEnv(), p && p.numbers, p && p.names);
    return { ok: r.status === 200, ...r.body };
  });
  ipcMain.handle('invoices:search', async (_event, q)=>{
    const r = await searchInvoices(dbEnv(), typeof q === 'string' ? q : '');
    return { ok: r.status === 200, ...r.body };
  });
}

async function importDbConnection(){
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: 'Import database connection file',
    message: 'Choose the .env file with the prod_main (PG_PROXY_*) and NUrul_DB (NURUL_PG_PROXY_*) keys.',
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'Connection file', extensions: ['env', 'txt'] }, { name: 'All files', extensions: ['*'] }]
  });
  if(pick.canceled || !pick.filePaths[0]) return;
  let text;
  try { text = fs.readFileSync(pick.filePaths[0], 'utf8'); }
  catch(err){ dialog.showErrorBox('Could not read file', String(err.message || err)); return; }
  const env = parseEnv(text);
  const missing = DB_KEYS_REQUIRED.filter(k => !env[k]);
  if(missing.length){
    dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Not a connection file',
      message: 'This file is missing: ' + missing.join(', '), buttons: ['OK'] });
    return;
  }
  // Keep only the keys the lookup uses.
  const keep = Object.keys(env).filter(k => /^(NURUL_)?PG_PROXY_(URL|DATABASE|TOKEN)$/.test(k));
  fs.writeFileSync(dbConfigPath(), keep.map(k => `${k}=${env[k]}`).join('\n') + '\n', { mode: 0o600 });
  dbEnvCache = null;
  const test = await searchInvoices(dbEnv(), 'INV-1');
  dialog.showMessageBox(mainWindow, {
    type: test.status === 200 ? 'info' : 'warning',
    title: 'Database connection',
    message: test.status === 200
      ? `Connected to ${env.PG_PROXY_DATABASE}${env.NURUL_PG_PROXY_DATABASE ? ' and ' + env.NURUL_PG_PROXY_DATABASE : ''}. Invoice lookup is on for this PC.`
      : 'Saved, but the test search failed: ' + (test.body.error || 'unknown error'),
    buttons: ['OK']
  });
}

async function removeDbConnection(){
  const ok = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Remove database connection',
    message: 'Remove the database keys from this PC? Invoice lookup will stop until a file is imported again.',
    buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1 });
  if(ok.response !== 0) return;
  try { fs.rmSync(dbConfigPath(), { force: true }); } catch {}
  dbEnvCache = null;
}

function buildMenu(){
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Check for Updates…',
          click: ()=>{
            if(!app.isPackaged){
              dialog.showMessageBox(mainWindow, {
                type: 'info', title: 'Development build',
                message: 'Update checks only run in the installed app.', buttons: ['OK']
              });
              return;
            }
            updateCheckIsManual = true;
            autoUpdater.checkForUpdates().catch(()=>{});
          }
        },
        {
          label: 'Database Connection',
          submenu: [
            { label: 'Import Connection File…', click: ()=> importDbConnection() },
            { label: 'Remove Connection from This PC…', click: ()=> removeDbConnection() }
          ]
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' },
      // Electron's default Zoom In accelerator is Ctrl+Plus, which on most keyboards
      // needs Shift — so plain Ctrl + "=" / numpad "+" did nothing. Bind those too.
      { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
      { role: 'zoomIn', accelerator: 'CommandOrControl+Plus', visible: false },
      { role: 'zoomIn', accelerator: 'CommandOrControl+numadd', visible: false },
      { role: 'zoomOut' },
      { role: 'zoomOut', accelerator: 'CommandOrControl+numsub', visible: false },
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' }
    ]},
    { label: 'Help', submenu: [
      {
        label: 'About',
        click: ()=> dialog.showMessageBox(mainWindow, {
          type: 'info', title: 'About',
          message: 'Eternalgy C&I Portal',
          detail: `Version ${app.getVersion()}\nCommercial Department`,
          buttons: ['OK']
        })
      }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single instance — a second launch focuses the existing window instead of
// opening a rival copy writing to the same local storage.
if(!app.requestSingleInstanceLock()){
  app.quit();
} else {
  app.on('second-instance', ()=>{
    if(mainWindow){
      if(mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(()=>{
    protocol.handle(SCHEME, req => {
      const target = resolveAsset(new URL(req.url).pathname);
      if(!target) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });

    buildMenu();
    setupInvoiceLookup();
    setupStaffSignIn();
    setupSharedStorage();
    createWindow();
    setupUpdates();

    app.on('activate', ()=>{
      if(BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', ()=>{
    if(process.platform !== 'darwin') app.quit();
  });
}
