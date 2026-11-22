/**
 * The only bridge between web content and the app. Channels are allowlisted;
 * the renderer gets functions, never ipcRenderer itself.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { INVOKE_CHANNELS, SEND_CHANNELS, type BlurbApi } from '../ipc-types';

const api: Record<string, unknown> = {};
for (const ch of INVOKE_CHANNELS) api[ch] = (...args: unknown[]) => ipcRenderer.invoke(`blurb:${ch}`, ...args);
for (const ch of SEND_CHANNELS) api[ch] = (...args: unknown[]) => ipcRenderer.send(`blurb:${ch}`, ...args);

function sub<T>(channel: string) {
  return (cb: (v: T) => void) => {
    const fn = (_e: IpcRendererEvent, v: T) => cb(v);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  };
}
api.onState = sub('blurb:state');
api.onEvent = sub('blurb:event');
api.onOverlay = sub('blurb:overlay');

contextBridge.exposeInMainWorld('blurb', api as unknown as BlurbApi);
