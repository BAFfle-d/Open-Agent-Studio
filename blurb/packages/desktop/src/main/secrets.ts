/**
 * API keys and the relay token live here, encrypted with Electron's
 * safeStorage (macOS Keychain, Windows DPAPI, libsecret/kwallet on Linux).
 *
 * The renderer never receives a secret back — only whether one is set.
 */
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type SecretRef = 'llm' | 'relay';

const file = () => path.join(app.getPath('userData'), 'secrets.json');

let cache: Record<string, string> | null = null;

async function readAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(file(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache!;
}

async function writeAll(data: Record<string, string>) {
  cache = data;
  const f = file();
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(`${f}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(`${f}.tmp`, f);
}

/** 'os' = real OS keychain encryption; 'weak' = Linux without a keyring (obfuscation only). */
export function storageStrength(): 'os' | 'weak' | 'unavailable' {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text' || backend === 'unknown') return 'weak';
  }
  return 'os';
}

export async function setSecret(ref: SecretRef, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('No secure storage is available on this system.');
  const all = await readAll();
  all[ref] = safeStorage.encryptString(value).toString('base64');
  await writeAll(all);
}

export async function getSecret(ref: string): Promise<string | undefined> {
  const all = await readAll();
  const v = all[ref];
  if (!v || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch {
    return undefined;
  }
}

export async function hasSecret(ref: SecretRef): Promise<boolean> {
  return !!(await readAll())[ref];
}

export async function clearSecret(ref: SecretRef): Promise<void> {
  const all = await readAll();
  delete all[ref];
  await writeAll(all);
}
