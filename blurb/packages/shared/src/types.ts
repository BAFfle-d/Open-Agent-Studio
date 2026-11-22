/**
 * Core state schema for Blurb.
 *
 * Two rules shape everything in this file:
 *  1. The simulation owns `PetState` + `WorldState`. Views (desktop window,
 *     overlay, fan web viewer) only render and send *requests*.
 *  2. Anything that leaves the owner's machine goes through
 *     `toPublicState()` (public-state.ts), a whitelist projection. Types that
 *     are allowed to cross the wire are prefixed `Public*`.
 */

export type Vec2 = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

// ---------------------------------------------------------------------------
// Pet
// ---------------------------------------------------------------------------

export const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'thinking',
  'sleepy',
  'confused',
  'sad',
  'love',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const ACTIVITIES = [
  'idle',
  'walking',
  'sleeping',
  'eating',
  'reading',
  'coding',
  'playing',
  'building',
  'foraging',
  'checking_dropbox',
  'writing_note',
  'chatting',
  'being_pet',
  'dragged',
  'falling',
  // Desktop-overlay activities (abstracted when published).
  'desktop_wander',
  'desktop_window_sit',
  'desktop_chase_cursor',
  'desktop_nap',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** All needs are 0..100. Higher = more urgent, except `energy` and `fullness`. */
export interface Needs {
  /** 100 = fully rested. */
  energy: number;
  /** 100 = stuffed. */
  fullness: number;
  /** 100 = desperate to learn something. */
  curiosity: number;
  /** 100 = climbing the walls. */
  boredom: number;
  /** 100 = lonely. */
  social: number;
}

export type PetMode = 'windowed' | 'overlay';

export type Gesture = 'wave' | 'dance' | 'hop';

/** A blob body description. Every skin/shape Blurb can wear resolves to one of these. */
export interface ShapeSpec {
  /** Body width in sprite pixels (classic = 30). */
  width: number;
  /** Body height in sprite pixels (classic = 24). */
  height: number;
  /** Top silhouette. */
  peak: 'round' | 'pointy' | 'flat';
  /** -1..1, how much the top leans right (classic leans right a little). */
  lean: number;
  /** Bumps on the bottom edge, 0..4. */
  feet: number;
  /** Little nubs on top. */
  ears: 'none' | 'nubs' | 'tufts';
  /** Highlight stripe on the upper-left (the classic glossy look). */
  gloss: boolean;
}

export interface Appearance {
  /** Palette id from the drop box (e.g. 'red' | 'pink' | 'blue' | 'custom-xxxx'). */
  skinId: string;
  /** Shape id from the drop box (e.g. 'classic'). */
  shapeId: string;
}

export interface SpeechBubble {
  id: string;
  text: string;
  emotion: Emotion;
  /** 'private' bubbles NEVER leave the machine (owner chat, screen Q&A). */
  visibility: 'public' | 'private';
  /** Who the speech is addressed to (for UI only). */
  audience: 'self' | 'owner' | 'fan' | 'everyone';
  createdAt: number;
  expiresAt: number;
  /** Still streaming tokens. */
  streaming?: boolean;
}

export interface Inventory {
  /** Resource counts, e.g. { stick: 3, fluff: 1 }. */
  resources: Partial<Record<ResourceKind, number>>;
  /** Item the pet is carrying in its little arm, if any. */
  carrying?: string;
}

export interface PetState {
  id: string;
  name: string;
  mode: PetMode;
  /** World coordinates (windowed) — bottom-center of the sprite. */
  position: Vec2;
  velocity: Vec2;
  facing: 'left' | 'right';
  activity: Activity;
  /** Seconds remaining in the current timed activity. */
  activityTimer: number;
  emotion: Emotion;
  /** Short-lived emotion override from chat (e.g. "excited" for 6 s). */
  emotionUntil: number;
  /** One-shot body animation (wave hello, happy dance). */
  gesture?: Gesture;
  gestureUntil: number;
  needs: Needs;
  appearance: Appearance;
  /** Where the pet is heading and why. */
  goal?: PetGoal;
  speech?: SpeechBubble;
  inventory: Inventory;
  /** Desktop overlay state; null while in windowed mode. Never published. */
  desktop?: DesktopPetState;
}

export interface PetGoal {
  kind: 'use_object' | 'go_to' | 'pick_up' | 'wander';
  objectId?: string;
  x: number;
  reason: string;
}

/** Overlay-mode position lives in *global screen* coordinates. Local-only. */
export interface DesktopPetState {
  position: Vec2;
  velocity: Vec2;
  /** Surface the pet is standing on. */
  surface: 'taskbar' | 'window' | 'screen_bottom' | 'air';
  /** Opaque id of the window being sat on (never a title). */
  windowId?: string;
  displayId?: number;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export const OBJECT_KINDS = [
  'bed',
  'food_bowl',
  'bookshelf',
  'computer',
  'ball',
  'yarn',
  'plushie',
  'drop_box',
  'comm_box',
  'workbench',
  'tree',
  'bush',
  'flowers',
  'lamp',
  'rug',
  'plant_pot',
  'resource',
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export const RESOURCE_KINDS = ['stick', 'leaf', 'berry', 'pebble', 'fluff'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type Zone = 'house' | 'yard';

export interface WorldObject {
  id: string;
  kind: ObjectKind;
  /** Bottom-left anchor in world coordinates. */
  x: number;
  y: number;
  /** Primary color (hex). Recolorable by the owner, and by Blurb if allowed. */
  color: string;
  zone: Zone;
  /** Who put it here (affects what Blurb may do with it). */
  origin: 'world' | 'pet' | 'owner' | 'fan';
  /** Kind-specific data (bowl contents, resource kind, toy bounce, …). */
  data?: WorldObjectData;
}

export interface WorldObjectData {
  /** food_bowl: servings available. */
  servings?: number;
  /** resource: what it is. */
  resource?: ResourceKind;
  /** tree/bush: seconds until it can be foraged again. */
  regrowIn?: number;
  /** toys: animation impulse when triggered (ball bounce, yarn roll). */
  bounce?: number;
  /** comm_box: unread notes from Blurb. */
  unread?: number;
}

export interface WorldState {
  width: number;
  height: number;
  /** y coordinate of the floor line. */
  floorY: number;
  /** x where the house ends and the yard begins (the door). */
  doorX: number;
  objects: WorldObject[];
  /** Local time of day, 0..24 (fractional hours). */
  timeOfDay: number;
  /** Monotonic simulation clock in seconds. */
  clock: number;
}

// ---------------------------------------------------------------------------
// Drop box / comm box
// ---------------------------------------------------------------------------

export interface SkinDesign {
  id: string;
  name: string;
  palette: BlobPalette;
  origin: 'builtin' | 'owner' | 'pet';
}

export interface ShapeDesign {
  id: string;
  name: string;
  spec: ShapeSpec;
  origin: 'builtin' | 'owner' | 'pet';
}

export interface BlobPalette {
  outline: string;
  body: string;
  shade: string;
  deep: string;
  highlight: string;
  cheek: string;
  eye: string;
  sparkle: string;
}

/** Things waiting in the drop box for Blurb to collect. */
export interface DropBoxItem {
  id: string;
  kind: 'resource' | 'object' | 'treat';
  resource?: ResourceKind;
  objectKind?: ObjectKind;
  count: number;
  from: 'owner' | 'fan';
  /** Fan nickname, sanitized. */
  fromName?: string;
  addedAt: number;
}

export interface DropBox {
  skins: SkinDesign[];
  shapes: ShapeDesign[];
  items: DropBoxItem[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** A note Blurb leaves for the owner in the comm box. */
export interface CommNote {
  id: string;
  createdAt: number;
  text: string;
  /** If set, the note is an approval request. */
  request?: ApprovalRequest;
  read: boolean;
}

export interface ApprovalRequest {
  kind: 'shape';
  status: ApprovalStatus;
  design: ShapeDesign;
  decidedAt?: number;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatRole = 'owner' | 'pet' | 'fan' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Display name. For fans this is the sanitized nickname. */
  author: string;
  text: string;
  emotion?: Emotion;
  createdAt: number;
  /** Owner = 0 (highest). Fan = 10. System = 5. */
  priority: number;
  /** For fan messages flowing through moderation. */
  status?: 'pending' | 'approved' | 'rejected' | 'answered';
  /** 'private' messages never leave the machine. */
  visibility: 'public' | 'private';
  /** Optional image attachment (screen peek). Local only, never published. */
  image?: { mime: 'image/png' | 'image/jpeg'; base64: string };
  /** Pet replies: id of the message being answered. */
  replyTo?: string;
}

// ---------------------------------------------------------------------------
// LLM configuration
// ---------------------------------------------------------------------------

export const PROVIDER_IDS = [
  'rules',
  'ollama',
  'lmstudio',
  'llamacpp',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'custom',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface LLMConfig {
  provider: ProviderId;
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  /**
   * Name of the secret in the OS keychain (never the key itself).
   * The renderer only ever sees `hasApiKey`.
   */
  apiKeyRef?: string;
  temperature: number;
  maxTokens: number;
  /** For provider 'llamacpp': absolute path to the .gguf file. */
  ggufPath?: string;
  /** Model accepts image input (needed for screen questions). */
  vision: boolean;
}

export interface PersonalityConfig {
  name: string;
  /** Free-form persona prompt, owner-editable. */
  persona: string;
  /** 0..1 — how often Blurb speaks unprompted. */
  chattiness: number;
}

// ---------------------------------------------------------------------------
// Capabilities (what the owner has allowed Blurb to do)
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  'recolor_self',
  'change_skin',
  'change_shape',
  'design_shapes',
  'recolor_objects',
  'transform_objects',
  'rearrange',
  'build_copies',
  'forage',
  'desktop_explore',
  'chase_cursor',
  'sit_on_windows',
  'screen_questions',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySet = Record<Capability, boolean>;

// ---------------------------------------------------------------------------
// Fan interaction
// ---------------------------------------------------------------------------

export type FanMode = 'fan_chat' | 'treats_only' | 'view_only';

export const TREAT_KINDS = ['cookie', 'berry', 'fish_cracker'] as const;
export type TreatKind = (typeof TREAT_KINDS)[number];

export const TOY_KINDS = ['ball', 'yarn', 'plushie'] as const;
export type ToyKind = (typeof TOY_KINDS)[number];

export type FanAction =
  | { type: 'treat'; treat: TreatKind }
  | { type: 'toy'; toy: ToyKind }
  | { type: 'chat'; text: string };

export interface FanEvent {
  id: string;
  fanId: string;
  nickname: string;
  action: FanAction;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface RelayConfig {
  enabled: boolean;
  /** wss://your-server/ws */
  url: string;
  petId: string;
  /** Keychain ref for the owner token. */
  tokenRef?: string;
}

export interface FanSettings {
  mode: FanMode;
  /** If false, fan chat waits in the moderation queue until the owner approves it. */
  autoApproveChat: boolean;
  /** Share Blurb's replies to the owner on the public viewer. Default false. */
  shareOwnerChat: boolean;
}

export interface BehaviorSettings {
  /** Multiplier for need decay (1 = real time, 10 = demo speed). */
  simSpeed: number;
  /** Seconds between autonomous LLM "thoughts". 0 = rules only. */
  thinkIntervalSec: number;
  /** Let Blurb take an unprompted peek at the screen and comment. Off by default. */
  screenPeek: { enabled: boolean; intervalMin: number; allowCloud: boolean };
}

export interface AppSettings {
  llm: LLMConfig;
  personality: PersonalityConfig;
  capabilities: CapabilitySet;
  relay: RelayConfig;
  fans: FanSettings;
  behavior: BehaviorSettings;
}
