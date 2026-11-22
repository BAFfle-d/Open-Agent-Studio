/** IPC contract shared by main, preload and renderers (types only). */
import type { ModerationItem, HostEvent } from '@blurb/host';
import type { ProviderPreset } from '@blurb/llm';
import type {
  AppSettings,
  Appearance,
  BlobPalette,
  ChatMessage,
  CommNote,
  DropBox,
  DropBoxItem,
  FanMode,
  Inventory,
  ObjectKind,
  ProviderId,
  PublicState,
  ResourceKind,
  ShapeSpec,
} from '@blurb/shared';

export interface WorldInfo {
  dropBox: DropBox;
  notes: CommNote[];
  outbox: number;
  inventory: Inventory;
  appearance: Appearance;
  look: { palette: BlobPalette; shape: ShapeSpec };
}

export interface InitData {
  settings: AppSettings;
  hasApiKey: boolean;
  hasRelayToken: boolean;
  secureStorage: 'os' | 'weak' | 'unavailable';
  ownerLog: ChatMessage[];
  world: WorldInfo;
  moderation: ModerationItem[];
  relay: { status: string; viewers: number };
  brain: { status: string; message?: string };
  presets: Record<ProviderId, ProviderPreset>;
  platform: string;
  llamaServer: string | null;
}

export type DesktopEvent =
  | HostEvent
  | { type: 'world'; world: WorldInfo }
  | { type: 'llama'; status: string; message?: string }
  | { type: 'download'; file: string; received: number; total: number; done?: boolean; error?: string };

export interface OverlayFrame {
  visible: boolean;
  /** Feet position in this overlay window's local coordinates (CSS px). */
  x: number;
  y: number;
  scale: number;
  name: string;
  activity: string;
  emotion: PublicState['pet']['emotion'];
  gesture?: PublicState['pet']['gesture'];
  facing: 'l' | 'r';
  palette: BlobPalette;
  shape: ShapeSpec;
  speech?: { id: string; text: string; streaming?: boolean };
}

export type PlaceKind = ObjectKind | `resource:${ResourceKind}`;

export interface GgufInfo {
  path: string;
  name: string;
  sizeBytes: number;
  source: string;
}

/** Everything the renderer can ask main to do. */
export interface BlurbApi {
  init(): Promise<InitData>;
  onState(cb: (s: PublicState) => void): () => void;
  onEvent(cb: (e: DesktopEvent) => void): () => void;
  onOverlay(cb: (f: OverlayFrame) => void): () => void;

  chat(text: string): Promise<void>;
  askScreen(question: string): Promise<void>;

  petStart(): Promise<void>;
  petContinue(): Promise<void>;
  dragStart(): Promise<void>;
  dragMove(x: number, y: number): Promise<void>;
  dragEnd(): Promise<void>;

  useObject(id: string): Promise<boolean>;
  moveObject(id: string, x: number): Promise<boolean>;
  recolorObject(id: string, color: string): Promise<boolean>;
  removeObject(id: string): Promise<boolean>;
  place(kind: PlaceKind, x: number): Promise<boolean>;
  dropToBox(item: Pick<DropBoxItem, 'kind' | 'resource' | 'objectKind' | 'count'>): Promise<void>;
  giveTreat(): Promise<void>;

  setSkin(id: string): Promise<boolean>;
  setShape(id: string): Promise<boolean>;
  decideShape(noteId: string, approve: boolean): Promise<boolean>;
  markNotesRead(): Promise<void>;

  moderate(eventId: string, approve: boolean): Promise<boolean>;
  setFanMode(mode: FanMode): Promise<void>;

  saveSettings(s: AppSettings): Promise<AppSettings>;
  setSecret(ref: 'llm' | 'relay', value: string): Promise<{ ok: boolean; error?: string }>;
  clearSecret(ref: 'llm' | 'relay'): Promise<void>;
  listModels(draft: AppSettings['llm']): Promise<{ ok: boolean; models: string[]; error?: string }>;
  testBrain(draft: AppSettings['llm']): Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  scanGguf(): Promise<GgufInfo[]>;
  hfSearch(q: string): Promise<Array<{ id: string; downloads: number }>>;
  hfFiles(repo: string): Promise<Array<{ file: string; sizeBytes?: number }>>;
  hfDownload(repo: string, file: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  memoryList(): Promise<Array<{ id: string; kind: string; text: string; createdAt: number }>>;
  memoryDelete(id: string): Promise<void>;
  memoryClear(): Promise<void>;
  goOut(): Promise<void>;

  // overlay window only
  overlayRegions(regions: Array<{ x: number; y: number; w: number; h: number }>): void;
  overlayFocus(focus: boolean): void;
  overlayPet(): Promise<void>;
  overlayDragStart(): Promise<void>;
  overlayDragEnd(): Promise<void>;
  overlayNap(): Promise<void>;
  goHome(): Promise<void>;
}

export const INVOKE_CHANNELS = [
  'init', 'chat', 'askScreen', 'petStart', 'petContinue', 'dragStart', 'dragMove', 'dragEnd',
  'useObject', 'moveObject', 'recolorObject', 'removeObject', 'place', 'dropToBox', 'giveTreat',
  'setSkin', 'setShape', 'decideShape', 'markNotesRead', 'moderate', 'setFanMode',
  'saveSettings', 'setSecret', 'clearSecret', 'listModels', 'testBrain', 'scanGguf', 'hfSearch', 'hfFiles', 'hfDownload',
  'memoryList', 'memoryDelete', 'memoryClear', 'goOut',
  'overlayPet', 'overlayDragStart', 'overlayDragEnd', 'overlayNap', 'goHome',
] as const;

export const SEND_CHANNELS = ['overlayRegions', 'overlayFocus'] as const;
