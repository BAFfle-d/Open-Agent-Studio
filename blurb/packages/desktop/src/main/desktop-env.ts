/**
 * Real-desktop geometry for overlay mode: displays, cursor, window rects.
 *
 * Window titles and owning apps are dropped at THIS boundary — the provider
 * returns ids + rectangles only, so no title ever reaches the sim, the LLM,
 * or the network.
 */
import { execFile } from 'node:child_process';
import { screen } from 'electron';
import type { DesktopEnv, DisplayInfo, WindowInfo } from '@blurb/engine';

type GetWindows = {
  openWindows?: (o?: object) => Promise<Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; owner?: { processId?: number } }>>;
  activeWindow?: (o?: object) => Promise<{ id: number; bounds: { x: number; y: number; width: number; height: number }; owner?: { processId?: number } } | undefined>;
};

export class DesktopEnvProvider {
  private displays: DisplayInfo[] = [];
  private windows: WindowInfo[] = [];
  private gw?: GetWindows | null;
  private polling = false;
  private timer?: ReturnType<typeof setInterval>;
  /** Our own overlay/main windows, excluded from "sit-able" windows. */
  ownBounds: () => Array<{ x: number; y: number; width: number; height: number }> = () => [];
  status: 'ok' | 'no-window-info' = 'ok';

  start() {
    this.refreshDisplays();
    screen.on('display-added', () => this.refreshDisplays());
    screen.on('display-removed', () => this.refreshDisplays());
    screen.on('display-metrics-changed', () => this.refreshDisplays());
    this.timer = setInterval(() => void this.pollWindows(), 500);
  }

  stop() {
    clearInterval(this.timer);
  }

  refreshDisplays() {
    const primary = screen.getPrimaryDisplay().id;
    this.displays = screen
      .getAllDisplays()
      .sort((a, b) => (a.id === primary ? -1 : b.id === primary ? 1 : a.bounds.x - b.bounds.x))
      .map((d) => ({ id: d.id, bounds: { ...d.bounds }, workArea: { ...d.workArea } }));
  }

  get env(): DesktopEnv {
    return { displays: this.displays, windows: this.windows, cursor: screen.getCursorScreenPoint() };
  }

  private isOwn(b: { x: number; y: number; width: number; height: number }) {
    return this.ownBounds().some((o) => o.x === b.x && o.y === b.y && o.width === b.width && o.height === b.height);
  }

  private async pollWindows() {
    if (this.polling) return;
    this.polling = true;
    try {
      const list = await this.fetchWindows();
      this.windows = list.filter((w) => w.bounds.width > 80 && w.bounds.height > 60 && !this.isOwn(w.bounds));
      this.status = 'ok';
    } catch {
      this.windows = [];
      this.status = 'no-window-info';
    } finally {
      this.polling = false;
    }
  }

  private async fetchWindows(): Promise<WindowInfo[]> {
    if (this.gw === undefined) {
      try {
        // Optional native dependency; Blurb works without it (no window-sitting).
        this.gw = (await import('get-windows')) as unknown as GetWindows;
      } catch {
        this.gw = null;
      }
    }
    const opts = { accessibilityPermission: false, screenRecordingPermission: false };
    if (this.gw?.openWindows && process.platform !== 'linux') {
      const ws = await this.gw.openWindows(opts);
      return ws.filter((w) => w.owner?.processId !== process.pid).slice(0, 12).map((w) => ({ id: String(w.id), bounds: { ...w.bounds } }));
    }
    if (this.gw?.activeWindow) {
      const w = await this.gw.activeWindow(opts);
      return w && w.owner?.processId !== process.pid ? [{ id: String(w.id), bounds: { ...w.bounds } }] : [];
    }
    if (process.platform === 'linux') return this.xdotoolActive();
    return [];
  }

  /** X11 fallback. On Wayland there is no portable way to read other windows' geometry. */
  private xdotoolActive(): Promise<WindowInfo[]> {
    return new Promise((resolve) => {
      execFile('xdotool', ['getactivewindow', 'getwindowgeometry', '--shell'], { timeout: 400 }, (err, out) => {
        if (err) return resolve([]);
        const v = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split('=')));
        const b = { x: Number(v.X), y: Number(v.Y), width: Number(v.WIDTH), height: Number(v.HEIGHT) };
        if (!Number.isFinite(b.x)) return resolve([]);
        resolve([{ id: String(v.WINDOW), bounds: b }]);
      });
    });
  }
}
