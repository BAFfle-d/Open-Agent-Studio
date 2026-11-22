import type { BlurbApi } from '../../ipc-types';

declare global {
  interface Window {
    blurb: BlurbApi;
  }
}

export const api: BlurbApi = window.blurb;
