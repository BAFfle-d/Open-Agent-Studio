/**
 * Desktop overlay: one transparent, frameless, always-on-top window per
 * display. Click-through everywhere except where Blurb (or its menu) is.
 *
 * Hit-testing is done here in main by polling the cursor, instead of relying
 * on setIgnoreMouseEvents' `forward` option (macOS/Windows only). Same code
 * path on all three OSes.
 */
import { BrowserWindow, screen, type Display } from 'electron';
import path from 'node:path';
import type { PetHost } from '@blurb/host';
import type { OverlayFrame } from '../ipc-types';

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OverlayWin {
  win: BrowserWindow;
  display: Display;
  regions: Region[];
  interactive: boolean;
  hadPet: boolean;
}

export class OverlayManager {
  private wins = new Map<number, OverlayWin>();
  private visible = false;
  private dragging = false;
  private dragOffset = { x: 0, y: 0 };

  constructor(
    private host: PetHost,
    private load: (win: BrowserWindow, page: 'overlay') => void,
    private preload: string,
  ) {}

  get windows() {
    return [...this.wins.values()].map((o) => o.win);
  }

  bounds() {
    return [...this.wins.values()].map((o) => o.win.getBounds());
  }

  private create(display: Display): OverlayWin {
    const win = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.load(win, 'overlay');
    return { win, display, regions: [], interactive: false, hadPet: false };
  }

  /** Match windows to the current display layout. */
  sync() {
    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [id, o] of this.wins) {
      if (!ids.has(id)) {
        o.win.destroy();
        this.wins.delete(id);
      }
    }
    for (const d of displays) {
      const existing = this.wins.get(d.id);
      if (existing) {
        existing.display = d;
        existing.win.setBounds(d.bounds);
      } else this.wins.set(d.id, this.create(d));
    }
    if (this.visible) this.show();
  }

  show() {
    this.visible = true;
    if (!this.wins.size) this.sync();
    for (const o of this.wins.values()) o.win.showInactive();
  }

  hide() {
    this.visible = false;
    this.dragging = false;
    for (const o of this.wins.values()) {
      o.win.hide();
      o.hadPet = false;
    }
  }

  setRegions(webContentsId: number, regions: Region[]) {
    for (const o of this.wins.values()) if (o.win.webContents.id === webContentsId) o.regions = regions.slice(0, 8);
  }

  setFocus(webContentsId: number, focus: boolean) {
    for (const o of this.wins.values()) {
      if (o.win.webContents.id !== webContentsId) continue;
      o.win.setFocusable(focus);
      if (focus) o.win.focus();
      else o.win.blur();
    }
  }

  dragStart() {
    const d = this.host.sim.pet.desktop;
    if (!d) return;
    const c = screen.getCursorScreenPoint();
    this.dragOffset = { x: d.position.x - c.x, y: d.position.y - c.y };
    this.dragging = true;
    this.host.desktop.dragStart();
  }

  dragEnd() {
    if (!this.dragging) return;
    this.dragging = false;
    this.host.desktop.dragEnd();
  }

  /** ~30 Hz: push frames to the overlay showing Blurb, update click-through. */
  tick() {
    if (!this.visible) return;
    const pet = this.host.sim.pet;
    const d = pet.desktop;
    if (!d) return;
    const cursor = screen.getCursorScreenPoint();
    if (this.dragging) this.host.desktop.dragMove(cursor.x + this.dragOffset.x, cursor.y + this.dragOffset.y);
    const scale = this.host.desktop.scale;
    const look = this.host.sim.look();
    const halfW = ((look.shape.width + 10) * scale) / 2;
    const h = (look.shape.height + 8) * scale;
    const sp = pet.speech && pet.speech.expiresAt > Date.now() ? pet.speech : undefined;
    for (const o of this.wins.values()) {
      const b = o.display.bounds;
      const has = d.position.x >= b.x - halfW && d.position.x < b.x + b.width + halfW && d.position.y >= b.y && d.position.y <= b.y + b.height + h;
      if (has || o.hadPet) {
        const frame: OverlayFrame = {
          visible: has,
          x: d.position.x - b.x,
          y: d.position.y - b.y,
          scale,
          name: pet.name,
          activity: pet.activity,
          emotion: pet.emotion,
          gesture: pet.gesture,
          facing: pet.facing === 'left' ? 'l' : 'r',
          palette: look.palette,
          shape: look.shape,
          speech: sp ? { id: sp.id, text: sp.text, streaming: sp.streaming } : undefined,
        };
        o.win.webContents.send('blurb:overlay', frame);
        o.hadPet = has;
      }
      // click-through unless the cursor is over Blurb or an open menu
      const lx = cursor.x - b.x;
      const ly = cursor.y - b.y;
      const overPet = has && Math.abs(cursor.x - d.position.x) < halfW && cursor.y <= d.position.y + 4 && cursor.y >= d.position.y - h;
      const overUi = o.regions.some((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
      const want = this.dragging || overPet || overUi;
      if (want !== o.interactive) {
        o.interactive = want;
        o.win.setIgnoreMouseEvents(!want, { forward: true });
      }
    }
  }

  destroy() {
    for (const o of this.wins.values()) o.win.destroy();
    this.wins.clear();
  }
}

export const preloadPath = (dir: string) => path.join(dir, '../preload/index.cjs');
