'use strict';

const { app, BrowserWindow, Menu, protocol, net, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');

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

  if(app.isPackaged) autoUpdater.checkForUpdates().catch(()=>{});
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
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
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
