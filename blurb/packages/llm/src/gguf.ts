/**
 * Local GGUF support (Node / Electron main only).
 *
 *  1. Find .gguf files already on disk (Hugging Face cache, LM Studio, GPT4All,
 *     ~/models, ~/Downloads, Blurb's own models folder).
 *  2. Search / download GGUF files from the Hugging Face Hub.
 *  3. Serve a chosen file through llama.cpp's `llama-server`, which exposes an
 *     OpenAI-compatible API — so a raw .gguf uses the exact same provider code
 *     path as Ollama or OpenAI.
 *
 * Deliberate choice: we shell out to llama-server instead of embedding
 * node-llama-cpp. It keeps the app free of a ~100 MB native module, lets the
 * user pick their own GPU build, and crashes in the model can't take Blurb down.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface GgufFile {
  path: string;
  name: string;
  sizeBytes: number;
  source: string;
}

export function defaultModelDirs(extra: string[] = []): Array<{ dir: string; source: string }> {
  const home = os.homedir();
  const dirs: Array<{ dir: string; source: string }> = [
    ...extra.map((dir) => ({ dir, source: 'Blurb models' })),
    { dir: process.env.HF_HUB_CACHE ?? path.join(process.env.HF_HOME ?? path.join(home, '.cache', 'huggingface'), 'hub'), source: 'Hugging Face cache' },
    { dir: path.join(home, '.lmstudio', 'models'), source: 'LM Studio' },
    { dir: path.join(home, '.cache', 'lm-studio', 'models'), source: 'LM Studio' },
    { dir: path.join(home, 'models'), source: '~/models' },
    { dir: path.join(home, 'Models'), source: '~/Models' },
    { dir: path.join(home, 'Downloads'), source: 'Downloads' },
  ];
  if (process.platform === 'darwin') dirs.push({ dir: path.join(home, 'Library', 'Application Support', 'nomic.ai', 'GPT4All'), source: 'GPT4All' });
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) dirs.push({ dir: path.join(process.env.LOCALAPPDATA, 'nomic.ai', 'GPT4All'), source: 'GPT4All' });
  if (process.platform === 'linux') dirs.push({ dir: path.join(home, '.local', 'share', 'nomic.ai', 'GPT4All'), source: 'GPT4All' });
  return dirs;
}

/** Shards other than the first, and vision projectors, aren't standalone models. */
function isPrimaryGguf(name: string) {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.gguf')) return false;
  if (lower.includes('mmproj')) return false;
  const shard = /-(\d{5})-of-(\d{5})\.gguf$/.exec(lower);
  return !shard || shard[1] === '00001';
}

export async function scanForGguf(
  dirs = defaultModelDirs(),
  opts: { maxDepth?: number; maxFiles?: number; maxDirs?: number } = {},
): Promise<GgufFile[]> {
  const maxDepth = opts.maxDepth ?? 6;
  const maxFiles = opts.maxFiles ?? 200;
  let budget = opts.maxDirs ?? 4000;
  const found = new Map<string, GgufFile>();

  async function walk(dir: string, depth: number, source: string) {
    if (depth > maxDepth || found.size >= maxFiles || budget-- <= 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && depth > 0) continue;
      if (e.name === 'node_modules' || e.name === 'blobs') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1, source);
      else if ((e.isFile() || e.isSymbolicLink()) && isPrimaryGguf(e.name)) {
        try {
          const st = await fs.stat(full); // follows HF-cache symlinks
          const real = await fs.realpath(full);
          if (st.size < 10 * 1024 * 1024 || found.has(real)) continue;
          found.set(real, { path: full, name: e.name, sizeBytes: st.size, source });
        } catch {
          /* broken link */
        }
      }
    }
  }

  for (const { dir, source } of dirs) {
    if (existsSync(dir)) await walk(dir, 0, source);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// llama-server
// ---------------------------------------------------------------------------

export function findLlamaServer(): string | null {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const candidates = [
    process.env.BLURB_LLAMA_SERVER,
    ...(process.env.PATH ?? '').split(path.delimiter).map((p) => path.join(p, exe)),
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export type LlamaStatus = 'stopped' | 'starting' | 'ready' | 'error';

export class LlamaServer {
  private proc?: ChildProcess;
  status: LlamaStatus = 'stopped';
  modelPath?: string;
  lastError?: string;
  private log: string[] = [];

  constructor(
    private bin: string,
    readonly port: number,
  ) {}

  get tail() {
    return this.log.slice(-20).join('');
  }

  async start(modelPath: string, opts: { ctx?: number; gpuLayers?: number; timeoutMs?: number } = {}): Promise<void> {
    if (this.proc && this.modelPath === modelPath && this.status === 'ready') return;
    await this.stop();
    this.status = 'starting';
    this.modelPath = modelPath;
    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(this.port), '-c', String(opts.ctx ?? 4096)];
    if (opts.gpuLayers !== undefined) args.push('-ngl', String(opts.gpuLayers));
    const proc = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const push = (b: Buffer) => {
      this.log.push(b.toString());
      if (this.log.length > 200) this.log.shift();
    };
    proc.stdout?.on('data', push);
    proc.stderr?.on('data', push);
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.status = code === 0 ? 'stopped' : 'error';
        if (code) this.lastError = `llama-server exited (${code}). ${this.tail.slice(-400)}`;
        this.proc = undefined;
      }
    });
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(this.lastError ?? 'llama-server stopped');
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (r.ok) {
          this.status = 'ready';
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    await this.stop();
    this.status = 'error';
    throw new Error('llama-server did not become ready in time');
  }

  async stop() {
    const p = this.proc;
    this.proc = undefined;
    if (!p) return;
    p.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (p.exitCode === null) p.kill('SIGKILL');
    this.status = 'stopped';
  }
}

// ---------------------------------------------------------------------------
// Hugging Face Hub
// ---------------------------------------------------------------------------

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_RE = /^[A-Za-z0-9_./-]+\.gguf$/;

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
}

export async function searchHfGguf(query: string, signal?: AbortSignal): Promise<HfModel[]> {
  const url = new URL('https://huggingface.co/api/models');
  url.searchParams.set('search', query.slice(0, 80));
  url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('limit', '20');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Hugging Face search failed (${res.status})`);
  const json = (await res.json()) as Array<{ id: string; downloads?: number; likes?: number }>;
  return json.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0 }));
}

export async function listHfGgufFiles(repo: string, signal?: AbortSignal): Promise<Array<{ file: string; sizeBytes?: number }>> {
  if (!REPO_RE.test(repo)) throw new Error('Invalid repository id');
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal });
  if (!res.ok) throw new Error(`Couldn't list ${repo} (${res.status})`);
  const json = (await res.json()) as { siblings?: Array<{ rfilename: string; size?: number }> };
  return (json.siblings ?? [])
    .filter((s) => isPrimaryGguf(path.basename(s.rfilename)))
    .map((s) => ({ file: s.rfilename, sizeBytes: s.size }));
}

export async function downloadHfGguf(
  repo: string,
  file: string,
  destDir: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!REPO_RE.test(repo) || !FILE_RE.test(file) || file.includes('..')) throw new Error('Invalid repo or file name');
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(file));
  if (!dest.startsWith(path.resolve(destDir))) throw new Error('Invalid destination');
  const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  const tmp = `${dest}.part`;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress(received, total);
  });
  try {
    await pipeline(body, createWriteStream(tmp), { signal });
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return dest;
}
