/**
 * Blurb desktop — Electron main process.
 *
 * Owns the simulation (via PetHost), so Blurb keeps living while the window
 * is minimized and the fan page keeps updating. Renderers are untrusted views:
 * sandboxed, context-isolated, talking only through allowlisted IPC.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, screen, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import WebSocket from 'ws';
import { PetHost, type WSLike } from '@blurb/host';
import {
  LLAMACPP_PORT,
  LlamaServer,
  PROVIDER_PRESETS,
  createProvider,
  defaultModelDirs,
  downloadHfGguf,
  explainError,
  findLlamaServer,
  listHfGgufFiles,
  scanForGguf,
  searchHfGguf,
} from '@blurb/llm';
import { OBJECT_DEFS, OBJECT_KINDS, RESOURCE_KINDS, normalizeColor, type AppSettings, type FanMode, type ObjectKind, type ResourceKind } from '@blurb/shared';
import type { DesktopEvent, InitData, PlaceKind, WorldInfo } from '../ipc-types';
import { DesktopEnvProvider } from './desktop-env';
import { OverlayManager, preloadPath } from './overlay';
import { clearSecret, getSecret, hasSecret, setSecret, storageStrength } from './secrets';
import { loadSettings, sanitizeSettings, saveSettings } from './settings-store';

if (!app.requestSingleInstanceLock()) app.quit();

const PRELOAD = preloadPath(__dirname);
let mainWin: BrowserWindow | null = null;
let host: PetHost;
let overlay: OverlayManager;
let envProvider: DesktopEnvProvider;
let tray: Tray | null = null;
let llama: LlamaServer | null = null;
let shuttingDown = false;
let lastWorldJson = '';
const brain = { status: 'idle', message: '' as string | undefined };
const relay = { status: 'off', viewers: 0 };

function loadPage(win: BrowserWindow, page: 'index' | 'overlay') {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) void win.loadURL(`${dev}/${page}.html`);
  else void win.loadFile(path.join(__dirname, `../renderer/${page}.html`));
}

function broadcast(e: DesktopEvent) {
  mainWin?.webContents.send('blurb:event', e);
  for (const w of overlay?.windows ?? []) w.webContents.send('blurb:event', e);
}

function worldInfo(): WorldInfo {
  const s = host.sim;
  return {
    dropBox: s.dropBox,
    notes: s.notes,
    outbox: s.outbox.length,
    inventory: s.pet.inventory,
    appearance: s.pet.appearance,
    look: s.look(),
  };
}

function pushWorld(force = false) {
  const w = worldInfo();
  const json = JSON.stringify(w);
  if (!force && json === lastWorldJson) return;
  lastWorldJson = json;
  broadcast({ type: 'world', world: w });
}

function appIcon(size: number) {
  return nativeImage.createFromPath(path.join(__dirname, `../../resources/icon-${size}.png`));
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 500,
    title: 'Blurb',
    backgroundColor: '#140e1e',
    icon: appIcon(256),
    show: false,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
  });
  mainWin.once('ready-to-show', () => mainWin?.show());
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  // Minimize → Blurb hops out onto the desktop. Restore → back home.
  mainWin.on('minimize', () => goOut());
  mainWin.on('restore', () => comeHome());
  mainWin.on('show', () => {
    if (!mainWin?.isMinimized()) comeHome();
  });
  // Closing the house window quits the app (use minimize to send Blurb out).
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
  loadPage(mainWin, 'index');
}

/** With desktop_explore off, Blurb still comes out but just naps in a corner. */
function goOut() {
  envProvider.refreshDisplays();
  host.setMode('overlay');
  overlay.show();
}

function comeHome() {
  overlay.hide();
  host.setMode('windowed');
}

function showHome() {
  if (!mainWin) createMainWindow();
  if (mainWin?.isMinimized()) mainWin.restore();
  mainWin?.show();
  mainWin?.focus();
}

function createTray() {
  tray = new Tray(appIcon(32));
  tray.setToolTip('Blurb');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Blurb’s house', click: showHome },
      { label: 'Let Blurb out on the desktop', click: () => mainWin?.minimize() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', showHome);
}

// ---------------------------------------------------------------------------
// screen capture (owner-initiated, or opt-in peeks). Never sent to the relay.
// ---------------------------------------------------------------------------

async function captureScreen(): Promise<{ mime: 'image/jpeg'; base64: string } | null> {
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const ratio = Math.min(1, 1280 / display.size.width);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.size.width * ratio), height: Math.round(display.size.height * ratio) },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return { mime: 'image/jpeg', base64: src.thumbnail.toJPEG(78).toString('base64') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// llama.cpp (GGUF) lifecycle
// ---------------------------------------------------------------------------

async function ensureLlama(s: AppSettings) {
  if (s.llm.provider !== 'llamacpp' || !s.llm.ggufPath) {
    if (llama) await llama.stop();
    return;
  }
  const bin = findLlamaServer();
  if (!bin) {
    broadcast({ type: 'llama', status: 'error', message: 'llama-server not found. Install llama.cpp (e.g. `brew install llama.cpp` or `winget install llama.cpp`) or set BLURB_LLAMA_SERVER.' });
    return;
  }
  llama ??= new LlamaServer(bin, LLAMACPP_PORT);
  broadcast({ type: 'llama', status: 'starting', message: path.basename(s.llm.ggufPath) });
  try {
    await llama.start(s.llm.ggufPath);
    broadcast({ type: 'llama', status: 'ready', message: path.basename(s.llm.ggufPath) });
  } catch (e) {
    broadcast({ type: 'llama', status: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

/** Fill in the right base URL for the selected provider (llamacpp is always ours). */
function normalizeLlm(s: AppSettings): AppSettings {
  if (s.llm.provider === 'llamacpp') s.llm.baseUrl = PROVIDER_PRESETS.llamacpp.baseUrl;
  if (!s.llm.baseUrl) s.llm.baseUrl = PROVIDER_PRESETS[s.llm.provider].baseUrl;
  return s;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** Only our own windows may call in. */
function trusted(e: IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const id = e.sender.id;
  return id === mainWin?.webContents.id || overlay.windows.some((w) => w.webContents.id === id);
}

function handle<A extends unknown[], R>(ch: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(`blurb:${ch}`, async (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...(args as A));
  });
}

const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function registerIpc() {
  handle('init', async (): Promise<InitData> => ({
    settings: host.settings,
    hasApiKey: await hasSecret('llm'),
    hasRelayToken: await hasSecret('relay'),
    secureStorage: storageStrength(),
    ownerLog: host.ownerLog,
    world: worldInfo(),
    moderation: host.moderation,
    relay,
    brain,
    presets: PROVIDER_PRESETS,
    platform: process.platform,
    llamaServer: findLlamaServer(),
  }));

  handle('chat', (text: unknown) => {
    if (isStr(text, 4000)) host.ownerSay(text);
  });
  handle('askScreen', async (q: unknown) => {
    await host.askAboutScreen(isStr(q, 1000) ? q : '');
  });

  handle('petStart', () => host.sim.petStart());
  handle('petContinue', () => host.sim.petContinue());
  handle('dragStart', () => host.sim.dragStart());
  handle('dragMove', (x: unknown, y: unknown) => {
    if (isNum(x) && isNum(y)) host.sim.dragMove(x, y);
  });
  handle('dragEnd', () => host.sim.dragEnd());

  handle('useObject', (id: unknown) => isStr(id, 80) && host.sim.requestUse(id, 'owner asked'));
  handle('moveObject', (id: unknown, x: unknown) => isStr(id, 80) && isNum(x) && host.sim.ownerMoveObject(id, x));
  handle('recolorObject', (id: unknown, c: unknown) => {
    const color = normalizeColor(c);
    return isStr(id, 80) && !!color && host.sim.ownerRecolor(id, color);
  });
  handle('removeObject', (id: unknown) => isStr(id, 80) && host.sim.ownerRemove(id));
  handle('place', (kind: unknown, x: unknown) => {
    if (!isStr(kind, 40) || !isNum(x)) return false;
    const k = kind as PlaceKind;
    const ok = k.startsWith('resource:') ? (RESOURCE_KINDS as readonly string[]).includes(k.slice(9)) : (OBJECT_KINDS as readonly string[]).includes(k) && !OBJECT_DEFS[k as ObjectKind].unique && k !== 'resource';
    return ok ? !!host.sim.ownerPlace(k, x) : false;
  });
  handle('dropToBox', (item: unknown) => {
    const i = item as { kind?: string; resource?: string; objectKind?: string; count?: number };
    const count = Math.max(1, Math.min(20, Math.round(Number(i?.count) || 1)));
    if (i?.kind === 'resource' && (RESOURCE_KINDS as readonly string[]).includes(i.resource ?? ''))
      host.sim.addToDropBox({ kind: 'resource', resource: i.resource as ResourceKind, count, from: 'owner' });
    else if (i?.kind === 'object' && (OBJECT_KINDS as readonly string[]).includes(i.objectKind ?? '') && !OBJECT_DEFS[i.objectKind as ObjectKind].unique)
      host.sim.addToDropBox({ kind: 'object', objectKind: i.objectKind as ObjectKind, count, from: 'owner' });
    else if (i?.kind === 'treat') host.sim.addToDropBox({ kind: 'treat', count, from: 'owner' });
    pushWorld();
  });
  handle('giveTreat', () => host.sim.giveTreat('cookie', 'you', 'owner'));

  handle('setSkin', (id: unknown) => isStr(id, 80) && host.sim.setSkin(id));
  handle('setShape', (id: unknown) => isStr(id, 80) && host.sim.setShape(id));
  handle('decideShape', (id: unknown, ok: unknown) => isStr(id, 80) && host.sim.decideShape(id, ok === true));
  handle('markNotesRead', () => {
    host.sim.markNotesRead();
    pushWorld();
  });

  handle('moderate', (id: unknown, ok: unknown) => isStr(id, 80) && host.moderate(id, ok === true));
  handle('setFanMode', async (mode: unknown) => {
    if (mode !== 'fan_chat' && mode !== 'treats_only' && mode !== 'view_only') return;
    host.setFanMode(mode as FanMode);
    await saveSettings(host.settings);
  });

  handle('saveSettings', async (s: unknown) => {
    const next = normalizeLlm(sanitizeSettings(s));
    next.llm.apiKeyRef = (await hasSecret('llm')) ? 'llm' : undefined;
    next.relay.tokenRef = (await hasSecret('relay')) ? 'relay' : undefined;
    await saveSettings(next);
    await host.applySettings(next);
    void ensureLlama(next);
    return next;
  });
  handle('setSecret', async (ref: unknown, value: unknown) => {
    if ((ref !== 'llm' && ref !== 'relay') || !isStr(value, 4096) || !value.trim()) return { ok: false, error: 'Invalid value' };
    try {
      await setSecret(ref, value.trim());
      const next = structuredClone(host.settings);
      if (ref === 'llm') next.llm.apiKeyRef = 'llm';
      else next.relay.tokenRef = 'relay';
      await saveSettings(next);
      await host.applySettings(next);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  handle('clearSecret', async (ref: unknown) => {
    if (ref !== 'llm' && ref !== 'relay') return;
    await clearSecret(ref);
    const next = structuredClone(host.settings);
    if (ref === 'llm') next.llm.apiKeyRef = undefined;
    else next.relay.tokenRef = undefined;
    await saveSettings(next);
    await host.applySettings(next);
  });

  const draftProvider = async (draft: unknown) => {
    const cfg = normalizeLlm(sanitizeSettings({ ...host.settings, llm: draft })).llm;
    const key = (await getSecret('llm')) ?? undefined;
    return { cfg, provider: createProvider(cfg, key) };
  };
  handle('listModels', async (draft: unknown) => {
    const { cfg, provider } = await draftProvider(draft);
    if (!provider) return { ok: false, models: [], error: cfg.provider === 'rules' ? 'The rule brain has no models.' : 'Add an API key first.' };
    try {
      return { ok: true, models: await provider.listModels(AbortSignal.timeout(8000)) };
    } catch (e) {
      return { ok: false, models: [], error: explainError(e, cfg.baseUrl) };
    }
  });
  handle('testBrain', async (draft: unknown) => {
    const { cfg, provider } = await draftProvider(draft);
    if (!provider) return { ok: cfg.provider === 'rules', message: cfg.provider === 'rules' ? 'Rule brain needs no connection.' : 'Add an API key first.' };
    return provider.test();
  });
  handle('scanGguf', () => scanForGguf(defaultModelDirs([path.join(app.getPath('userData'), 'models')])));
  handle('hfSearch', async (q: unknown) => (isStr(q, 80) && q.trim() ? searchHfGguf(q.trim(), AbortSignal.timeout(10000)) : []));
  handle('hfFiles', async (repo: unknown) => (isStr(repo, 120) ? listHfGgufFiles(repo, AbortSignal.timeout(10000)) : []));
  handle('hfDownload', async (repo: unknown, file: unknown) => {
    if (!isStr(repo, 120) || !isStr(file, 300)) return { ok: false, error: 'invalid' };
    try {
      let last = 0;
      const p = await downloadHfGguf(repo, file, path.join(app.getPath('userData'), 'models'), (received, total) => {
        if (Date.now() - last > 250) {
          last = Date.now();
          broadcast({ type: 'download', file, received, total });
        }
      });
      broadcast({ type: 'download', file, received: 1, total: 1, done: true });
      return { ok: true, path: p };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      broadcast({ type: 'download', file, received: 0, total: 0, error });
      return { ok: false, error };
    }
  });
  handle('memoryList', () => host.memory.list());
  handle('memoryDelete', (id: unknown) => {
    if (isStr(id, 80)) host.memory.remove(id);
  });
  handle('memoryClear', () => host.memory.clear());
  handle('goOut', () => mainWin?.minimize());

  // overlay-only
  handle('overlayPet', () => host.desktop.petStart());
  handle('overlayDragStart', () => overlay.dragStart());
  handle('overlayDragEnd', () => overlay.dragEnd());
  handle('overlayNap', () => {
    host.sim.setEmotion('sleepy', 4);
    host.desktop.mode = 'nap';
  });
  handle('goHome', () => showHome());

  ipcMain.on('blurb:overlayRegions', (e, regions: unknown) => {
    if (!trusted(e) || !Array.isArray(regions)) return;
    const clean = regions
      .filter((r) => r && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h))
      .map((r) => ({ x: r.x, y: r.y, w: Math.min(800, r.w), h: Math.min(800, r.h) }));
    overlay.setRegions(e.sender.id, clean);
  });
  ipcMain.on('blurb:overlayFocus', (e, focus: unknown) => {
    if (trusted(e)) overlay.setFocus(e.sender.id, focus === true);
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

app.on('second-instance', showHome);

app.whenReady().then(async () => {
  // Deny every web permission; screen capture happens in main, on request.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  envProvider = new DesktopEnvProvider();
  envProvider.start();
  const settings = normalizeLlm(await loadSettings());
  settings.llm.apiKeyRef = (await hasSecret('llm')) ? 'llm' : undefined;
  settings.relay.tokenRef = (await hasSecret('relay')) ? 'relay' : undefined;

  host = await PetHost.load(settings, {
    dataDir: app.getPath('userData'),
    getSecret,
    createSocket: (url) => new WebSocket(url) as unknown as WSLike,
    desktopEnv: () => envProvider.env,
    captureScreen,
  });
  brain.message = host.brainLabel();
  host.on((e) => {
    if (e.type === 'brain') Object.assign(brain, { status: e.status, message: e.message ?? host.brainLabel() });
    if (e.type === 'relay') Object.assign(relay, { status: e.status, viewers: e.viewers });
    broadcast(e);
    if (e.type === 'sim' && ['program', 'note', 'dropbox'].includes(e.event.type)) pushWorld();
  });

  overlay = new OverlayManager(host, loadPage, PRELOAD);
  envProvider.ownBounds = () => [...overlay.bounds(), ...(mainWin ? [mainWin.getBounds()] : [])];
  screen.on('display-added', () => overlay.sync());
  screen.on('display-removed', () => overlay.sync());
  screen.on('display-metrics-changed', () => overlay.sync());

  registerIpc();
  createMainWindow();
  createTray();
  host.start();
  void ensureLlama(settings);

  setInterval(() => {
    if (mainWin && !mainWin.isMinimized() && mainWin.isVisible()) mainWin.webContents.send('blurb:state', host.localState());
    overlay.tick();
  }, 33);
  setInterval(() => pushWorld(), 1000);
});

app.on('before-quit', async (e) => {
  if (!host || shuttingDown) return;
  e.preventDefault();
  shuttingDown = true;
  overlay?.destroy();
  envProvider?.stop();
  await Promise.allSettled([host.stop(), llama?.stop()]);
  app.exit(0);
});

app.on('window-all-closed', () => app.quit());
