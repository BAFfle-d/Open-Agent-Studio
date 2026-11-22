/**
 * PetHost — everything that runs on the owner's machine, minus the UI:
 * the simulation loop, the AI brain (owner chat, fan replies, autonomous
 * thoughts, computer sessions, screen questions), fan moderation, memory,
 * persistence, and relay publishing.
 *
 * The Electron main process wraps this with windows + IPC + keychain.
 * scripts/headless-pet.ts runs it with no UI at all.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_SKINS,
  DEFAULT_SETTINGS,
  LIMITS,
  OBJECT_DEFS,
  TagStreamParser,
  extractProgramJson,
  makeId,
  normalizeText,
  parseTagged,
  screenFanChat,
  toPublicState,
  type AppSettings,
  type ChatMessage,
  type Emotion,
  type FanEvent,
  type FanMode,
  type ParsedTag,
  type PublicState,
} from '@blurb/shared';
import { DesktopSim, PetSim, phrase, type DesktopEnv, type SimEvent, type SimSnapshot } from '@blurb/engine';
import {
  ChatQueue,
  MemoryStore,
  createProvider,
  explainError,
  fanReplyMessages,
  isLocalConfig,
  ownerChatMessages,
  programMessages,
  summarizeMessages,
  thoughtMessages,
  type LLMMessage,
  type LLMProvider,
  type PromptContext,
} from '@blurb/llm';
import { RelayClient, type RelayStatus, type WSLike } from './relay-client.js';

export interface HostAdapters {
  dataDir: string;
  getSecret(ref: string): Promise<string | undefined>;
  createSocket(url: string): WSLike;
  /** Overlay mode: displays, window rects (no titles), cursor. */
  desktopEnv?(): DesktopEnv | null;
  /** Screenshot for screen questions/peeks. Never sent to the relay. */
  captureScreen?(): Promise<{ mime: 'image/png' | 'image/jpeg'; base64: string } | null>;
}

export interface ModerationItem {
  event: FanEvent;
  status: 'pending' | 'approved' | 'rejected' | 'answered' | 'failed';
  note?: string;
}

export type HostEvent =
  | { type: 'chat'; message: ChatMessage }
  | { type: 'moderation'; items: ModerationItem[] }
  | { type: 'relay'; status: RelayStatus; viewers: number }
  | { type: 'brain'; status: 'idle' | 'thinking' | 'error'; message?: string }
  | { type: 'sim'; event: SimEvent }
  | { type: 'fan'; text: string };

interface ChatJob {
  kind: 'owner' | 'fan';
  messageId: string;
  text: string;
  image?: ChatMessage['image'];
  event?: FanEvent;
}

const TICK_MS = 33;
const PUBLISH_MS = 100;
const SAVE_MS = 30_000;

export class PetHost {
  sim: PetSim;
  desktop: DesktopSim;
  memory: MemoryStore;
  settings: AppSettings;
  provider: LLMProvider | null = null;
  relay?: RelayClient;
  moderation: ModerationItem[] = [];
  ownerLog: ChatMessage[] = [];

  private listeners = new Set<(e: HostEvent) => void>();
  private queue: ChatQueue<ChatJob>;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private lastTick = Date.now();
  private nextThought = Date.now() + 20_000;
  private nextPeek = 0;
  private lastOwnerChat = 0;
  private ownerSinceSummary = 0;
  private brainBusy = false;
  private relayKey = '';

  constructor(
    settings: AppSettings,
    private adapters: HostAdapters,
    snapshot?: SimSnapshot,
  ) {
    this.settings = structuredClone(settings);
    this.sim = new PetSim(snapshot);
    this.desktop = new DesktopSim(this.sim);
    this.memory = new MemoryStore(path.join(adapters.dataDir, 'memory.json'));
    this.queue = new ChatQueue<ChatJob>((item, signal) => this.runChat(item.payload, signal));
    this.sim.on((event) => this.emit({ type: 'sim', event }));
    this.sim.programProvider = async (pctx) => {
      if (!this.provider) return null;
      const text = await this.provider.complete({ messages: programMessages(this.promptContext(), pctx), maxTokens: 300, temperature: 0.9 });
      return extractProgramJson(text);
    };
  }

  static async load(settings: AppSettings, adapters: HostAdapters): Promise<PetHost> {
    let snap: SimSnapshot | undefined;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(adapters.dataDir, 'world.json'), 'utf8')) as SimSnapshot;
      if (raw?.version === 1 && raw.pet && raw.world?.objects) snap = raw;
    } catch {
      /* first run */
    }
    const host = new PetHost(settings, adapters, snap);
    await host.memory.load();
    for (const m of host.memory.ownerChat().slice(-20)) {
      host.ownerLog.push({
        id: makeId('hist'),
        role: m.role === 'user' ? 'owner' : 'pet',
        author: m.role === 'user' ? 'You' : settings.personality.name,
        text: m.content,
        createdAt: m.at,
        priority: 0,
        visibility: 'private',
      });
    }
    await host.applySettings(settings);
    return host;
  }

  on(fn: (e: HostEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: HostEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  start() {
    this.lastTick = Date.now();
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.publish(), PUBLISH_MS));
    this.timers.push(setInterval(() => void this.save(), SAVE_MS));
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.queue.cancelAll();
    this.relay?.stop();
    await this.save();
    await this.memory.flush();
  }

  async save() {
    await fs.mkdir(this.adapters.dataDir, { recursive: true });
    const file = path.join(this.adapters.dataDir, 'world.json');
    await fs.writeFile(`${file}.tmp`, JSON.stringify(this.sim.snapshot()), 'utf8');
    await fs.rename(`${file}.tmp`, file);
  }

  private tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.sim.tick(dt, now);
    if (this.sim.pet.mode === 'overlay') {
      const env = this.adapters.desktopEnv?.();
      if (env) this.desktop.step(dt, env);
    }
    if (now >= this.nextThought) void this.think();
    if (this.sim.pet.mode === 'overlay' && this.nextPeek && now >= this.nextPeek) void this.peek();
  }

  // -------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------

  async applySettings(next: AppSettings) {
    const prevMode = this.settings.fans.mode;
    this.settings = structuredClone(next);
    const s = this.settings;
    this.sim.capabilities = { ...s.capabilities };
    this.sim.simSpeed = Math.max(0.1, Math.min(60, s.behavior.simSpeed));
    this.sim.chattiness = s.personality.chattiness;
    this.sim.pet.name = s.personality.name || 'Blurb';
    if (!this.sim.dropBox.skins.length) this.sim.dropBox.skins = structuredClone(BUILTIN_SKINS);

    const key = s.llm.apiKeyRef ? await this.adapters.getSecret(s.llm.apiKeyRef) : undefined;
    this.provider = createProvider(s.llm, key);
    this.emit({ type: 'brain', status: 'idle', message: this.brainLabel() });

    // Relay: (re)connect only if the connection details changed.
    const token = s.relay.tokenRef ? await this.adapters.getSecret(s.relay.tokenRef) : undefined;
    const relayKey = s.relay.enabled && token ? `${s.relay.url}|${s.relay.petId}|${token}` : '';
    if (relayKey !== this.relayKey) {
      this.relay?.stop();
      this.relay = undefined;
      this.relayKey = relayKey;
      if (relayKey) {
        this.relay = new RelayClient({ url: s.relay.url, petId: s.relay.petId, token: token!, createSocket: this.adapters.createSocket });
        this.relay.onFanEvent = (e) => this.onFanEvent(e);
        this.relay.onStatus = (st, viewers) => this.emit({ type: 'relay', status: st, viewers });
        this.relay.start();
      } else this.emit({ type: 'relay', status: 'off', viewers: 0 });
    }
    if (prevMode !== s.fans.mode) this.relay?.fanMode(s.fans.mode);

    this.nextThought = Date.now() + this.thoughtDelay();
    const peek = s.behavior.screenPeek;
    this.nextPeek = peek.enabled && this.adapters.captureScreen ? Date.now() + peek.intervalMin * 60_000 : 0;
  }

  brainLabel(): string {
    const l = this.settings.llm;
    if (this.provider) return `${l.provider} · ${l.model || 'no model'}`;
    return l.provider === 'rules' ? 'rule brain' : `${l.provider}: needs setup`;
  }

  setFanMode(mode: FanMode) {
    this.settings.fans.mode = mode;
    this.relay?.fanMode(mode);
  }

  // -------------------------------------------------------------------------
  // views
  // -------------------------------------------------------------------------

  /** What fans see. Strict whitelist projection. */
  publicState(): PublicState {
    return toPublicState(this.sim.pet, this.sim.world, this.sim.look(), this.settings.fans.mode, Date.now());
  }

  /** What the owner's own window renders: public view + private speech. */
  localState(): PublicState {
    const s = this.publicState();
    const sp = this.sim.pet.speech;
    if (sp && sp.visibility === 'private' && sp.expiresAt > Date.now() && this.sim.pet.mode === 'windowed') {
      s.pet.speech = { id: sp.id, text: sp.text, emotion: sp.emotion, streaming: sp.streaming || undefined };
    }
    return s;
  }

  private publish() {
    this.relay?.publish(this.publicState());
  }

  setMode(mode: 'windowed' | 'overlay') {
    if (this.sim.pet.mode === mode) return;
    this.sim.setMode(mode);
    if (mode === 'overlay') {
      const env = this.adapters.desktopEnv?.();
      if (env) this.desktop.enter(env);
    }
  }

  // -------------------------------------------------------------------------
  // owner chat
  // -------------------------------------------------------------------------

  private pushOwnerLog(m: ChatMessage) {
    this.ownerLog.push(m);
    if (this.ownerLog.length > 100) this.ownerLog.shift();
    this.emit({ type: 'chat', message: m });
  }

  ownerSay(text: string, opts: { image?: ChatMessage['image'] } = {}) {
    const clean = normalizeText(text, LIMITS.ownerChatMaxLen);
    if (!clean && !opts.image) return;
    this.lastOwnerChat = Date.now();
    const msg: ChatMessage = {
      id: makeId('own'),
      role: 'owner',
      author: 'You',
      text: clean || '(shared a screenshot)',
      createdAt: Date.now(),
      priority: 0,
      visibility: 'private',
      image: opts.image,
    };
    this.pushOwnerLog({ ...msg, image: undefined });
    this.queue.push({ id: msg.id, priority: 0, enqueuedAt: Date.now(), payload: { kind: 'owner', messageId: msg.id, text: msg.text, image: opts.image } });
  }

  private promptContext(includeMemories = true, query = ''): PromptContext {
    return {
      personality: this.settings.personality,
      pet: this.sim.pet,
      objects: this.sim.world.objects,
      hour: this.sim.world.timeOfDay,
      recentEvents: this.sim.recentEvents(),
      memories: includeMemories ? this.memory.recall(query || this.sim.recentEvents().join(' '), 5).map((m) => m.text) : [],
      capabilities: this.sim.capabilities,
      pendingApprovals: this.sim.notes.filter((n) => n.request?.status === 'pending'),
    };
  }

  private async runChat(job: ChatJob, signal: AbortSignal) {
    if (job.kind === 'owner') return this.runOwnerChat(job, signal);
    return this.runFanChat(job, signal);
  }

  /** Stream a reply into a speech bubble + a chat message. */
  private async streamReply(
    messages: LLMMessage[],
    opts: { visibility: 'public' | 'private'; audience: 'owner' | 'fan'; source: 'owner' | 'fan'; replyTo: string; signal: AbortSignal },
  ): Promise<{ text: string; emotion: Emotion; aborted: boolean }> {
    const reply: ChatMessage = {
      id: makeId('pet'),
      role: 'pet',
      author: this.settings.personality.name,
      text: '',
      createdAt: Date.now(),
      priority: 0,
      visibility: opts.visibility,
      replyTo: opts.replyTo,
    };
    const speechId = this.sim.beginSpeech(opts.visibility, opts.audience);
    const parser = new TagStreamParser();
    const tags: ParsedTag[] = [];
    let text = '';
    this.brainBusy = true;
    this.emit({ type: 'brain', status: 'thinking' });
    try {
      for await (const delta of this.provider!.stream({
        messages,
        temperature: this.settings.llm.temperature,
        maxTokens: this.settings.llm.maxTokens,
        signal: opts.signal,
      })) {
        const r = parser.push(delta);
        if (r.tags.length) {
          tags.push(...r.tags);
          this.sim.applyTags(r.tags.filter((t) => t.type === 'emotion'), opts.source);
        }
        if (r.text) {
          text += r.text;
          this.sim.appendSpeech(speechId, r.text);
          if (opts.audience === 'owner') this.emit({ type: 'chat', message: { ...reply, text: text.trimStart() } });
        }
      }
      text += parser.end().text;
      this.emit({ type: 'brain', status: 'idle' });
    } catch (e) {
      if (opts.signal.aborted) {
        this.sim.endSpeech(speechId);
        return { text, emotion: this.sim.pet.emotion, aborted: true };
      }
      const msg = explainError(e, this.settings.llm.baseUrl || 'http://localhost');
      this.emit({ type: 'brain', status: 'error', message: msg });
      text = text || `(my brain hiccuped: ${msg})`;
    } finally {
      this.brainBusy = false;
    }
    text = text.replace(/[ \t]{2,}/g, ' ').trim();
    this.sim.pet.speech && (this.sim.pet.speech.text = text);
    this.sim.endSpeech(speechId);
    this.sim.applyTags(tags.filter((t) => t.type === 'action'), opts.source);
    const emotion = this.sim.pet.emotion;
    if (opts.audience === 'owner') this.emit({ type: 'chat', message: { ...reply, text, emotion } });
    return { text, emotion, aborted: false };
  }

  private async runOwnerChat(job: ChatJob, signal: AbortSignal) {
    const visibility = job.image || !this.settings.fans.shareOwnerChat ? 'private' : 'public';
    if (job.image && (!this.provider || !this.settings.llm.vision || !this.sim.capabilities.screen_questions)) {
      const why = !this.sim.capabilities.screen_questions
        ? 'Screen questions are switched off in my permissions.'
        : 'My current brain can’t see pictures. Pick a vision model in Settings and tick “vision”.';
      return this.ruleReply(job, why, 'confused', visibility);
    }
    if (!this.provider) return this.ruleOwnerReply(job, visibility);

    const history: LLMMessage[] = this.memory
      .ownerChat()
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    const ctx = this.promptContext(true, job.text);
    const { text, aborted } = await this.streamReply(ownerChatMessages(ctx, history, job.text, job.image), {
      visibility,
      audience: 'owner',
      source: 'owner',
      replyTo: job.messageId,
      signal,
    });
    if (aborted) return;
    this.memory.pushOwnerChat('user', job.image ? `${job.text} [shared a screenshot]` : job.text);
    this.memory.pushOwnerChat('assistant', text);
    if (++this.ownerSinceSummary >= 8) {
      this.ownerSinceSummary = 0;
      void this.summarize();
    }
  }

  private ruleReply(job: ChatJob, text: string, emotion: Emotion, visibility: 'public' | 'private') {
    this.sim.say(text, { emotion, visibility, audience: 'owner' });
    this.pushOwnerLog({ id: makeId('pet'), role: 'pet', author: this.settings.personality.name, text, emotion, createdAt: Date.now(), priority: 0, visibility, replyTo: job.messageId });
    this.memory.pushOwnerChat('user', job.text);
    this.memory.pushOwnerChat('assistant', text);
  }

  /** Small keyword brain so chat still does something without an LLM. */
  private ruleOwnerReply(job: ChatJob, visibility: 'public' | 'private') {
    const t = job.text.toLowerCase();
    const rng = this.sim.rng;
    const act = (a: Extract<ParsedTag, { type: 'action' }>['action']) => this.sim.applyTags([{ type: 'action', action: a }], 'owner');
    const skin = BUILTIN_SKINS.find((s) => t.includes(s.id) || t.includes(s.name.toLowerCase()));
    if (skin && /(turn|go|change|be|wear|color|colour|skin)/.test(t)) {
      this.sim.setSkin(skin.id);
      return this.ruleReply(job, `Ta-da! ${skin.name} mode!`, 'excited', visibility);
    }
    const intents: Array<[RegExp, () => [string, Emotion]]> = [
      [/\b(hi|hello|hey|yo|morning|evening)\b/, () => (this.sim.gesture('wave'), ['Hi hi! I missed you!', 'happy'])],
      [/how are you|how're you|how do you feel|feeling/, () => [this.describeMood(), this.sim.pet.emotion]],
      [/nap|sleep|bed|rest/, () => (act('nap'), ['Okay… nap time. Zzz.', 'sleepy'])],
      [/eat|food|hungry|snack/, () => (act('eat'), ['Snack time!', 'excited'])],
      [/play|ball|toy|yarn/, () => (act('play'), ['Play! Play! Play!', 'excited'])],
      [/read|book/, () => (act('read'), ['Ooh, story time.', 'happy'])],
      [/code|computer|tinker|program/, () => (act('code'), ['To the computer! Beep boop.', 'thinking'])],
      [/forage|tree|bush|gather/, () => (act('forage'), ['Off to forage!', 'happy'])],
      [/build|make|craft/, () => (act('build'), ['To the workbench!', 'excited'])],
      [/dance|party/, () => (act('dance'), ['💃 Wiggle wiggle!', 'excited'])],
      [/love you|good (blob|boy|girl|pet)|cute/, () => (this.sim.gesture('dance', 2), ['Aww! I love you too!', 'love'])],
      [/drop ?box|mail|delivery/, () => (act('check_dropbox'), ['Checking the drop box!', 'excited'])],
    ];
    for (const [re, fn] of intents) {
      if (re.test(t)) {
        const [text, emotion] = fn();
        return this.ruleReply(job, text, emotion, visibility);
      }
    }
    return this.ruleReply(job, `${phrase('bored', rng)} (I’m on my simple rule brain — connect an AI in Settings and I can really chat!)`, 'confused', visibility);
  }

  private describeMood(): string {
    const n = this.sim.pet.needs;
    const bits: string[] = [];
    if (n.energy < 30) bits.push('sleepy');
    if (n.fullness < 30) bits.push('hungry');
    if (n.boredom > 70) bits.push('a bit bored');
    if (n.social > 70) bits.push('lonely');
    if (n.curiosity > 70) bits.push('super curious');
    return bits.length ? `I'm feeling ${bits.join(', ')}.` : 'I feel great! Full tummy, lots of energy.';
  }

  private async summarize() {
    if (!this.provider) return;
    const transcript = this.memory
      .ownerChat()
      .slice(-16)
      .map((m) => `${m.role === 'user' ? 'Owner' : this.settings.personality.name}: ${m.content}`)
      .join('\n');
    try {
      const out = await this.provider.complete({ messages: summarizeMessages(transcript), maxTokens: 160, temperature: 0.2 });
      for (const line of out.split('\n').map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 3)) {
        this.memory.add('owner_fact', line, 1.5);
      }
    } catch {
      /* best effort */
    }
  }

  // -------------------------------------------------------------------------
  // fans
  // -------------------------------------------------------------------------

  private onFanEvent(e: FanEvent) {
    const mode = this.settings.fans.mode;
    const a = e.action;
    // Defense in depth: re-check the mode and re-screen text locally.
    if (mode === 'view_only' || (mode === 'treats_only' && a.type === 'chat')) {
      this.relay?.fanResult(e.id, e.fanId, 'rejected', 'Not allowed right now.');
      return;
    }
    if (a.type === 'treat') {
      this.sim.giveTreat(a.treat, e.nickname, 'fan');
      this.emit({ type: 'fan', text: `${e.nickname} gave a ${a.treat.replace('_', ' ')}` });
      this.memory.add('fan', `Visitor ${e.nickname} gave me a ${a.treat.replace('_', ' ')}`, 0.3);
      return;
    }
    if (a.type === 'toy') {
      this.sim.triggerToy(a.toy, e.nickname);
      this.emit({ type: 'fan', text: `${e.nickname} played with the ${a.toy}` });
      return;
    }
    const screened = screenFanChat(a.text);
    if (!screened.ok) {
      this.relay?.fanResult(e.id, e.fanId, 'rejected', 'That message can’t be sent.');
      return;
    }
    const item: ModerationItem = { event: { ...e, action: { type: 'chat', text: screened.text } }, status: 'pending' };
    this.moderation.unshift(item);
    this.moderation = this.moderation.slice(0, 100);
    if (this.settings.fans.autoApproveChat) this.moderate(e.id, true);
    else this.emit({ type: 'moderation', items: this.moderation });
  }

  moderate(eventId: string, approve: boolean) {
    const item = this.moderation.find((m) => m.event.id === eventId);
    if (!item || item.status !== 'pending') return false;
    item.status = approve ? 'approved' : 'rejected';
    this.relay?.fanResult(eventId, item.event.fanId, item.status);
    this.emit({ type: 'moderation', items: this.moderation });
    if (approve && item.event.action.type === 'chat') {
      this.queue.push({
        id: eventId,
        priority: 10,
        enqueuedAt: Date.now(),
        payload: { kind: 'fan', messageId: eventId, text: item.event.action.text, event: item.event },
      });
    }
    return true;
  }

  private async runFanChat(job: ChatJob, signal: AbortSignal) {
    const e = job.event!;
    const item = this.moderation.find((m) => m.event.id === e.id);
    let text: string;
    let emotion: Emotion;
    if (!this.provider) {
      const t = job.text.toLowerCase();
      text = /\b(hi|hello|hey)\b/.test(t) ? `Hi ${e.nickname}! Thanks for visiting!` : `Thanks for the message, ${e.nickname}! *happy wiggle*`;
      emotion = 'happy';
      this.sim.say(text, { emotion, visibility: 'public', audience: 'fan' });
      this.sim.gesture('wave', 2);
    } else {
      const r = await this.streamReply(fanReplyMessages(this.promptContext(false), e.nickname, job.text), {
        visibility: 'public',
        audience: 'fan',
        source: 'fan',
        replyTo: e.id,
        signal,
      });
      if (r.aborted) return; // owner preempted; ChatQueue will retry once
      text = r.text;
      emotion = r.emotion;
    }
    // Final check on what goes public: strip tags, cap length.
    const pub = parseTagged(text).text.slice(0, 600);
    if (pub) {
      this.relay?.chat({ id: makeId('pet'), role: 'pet', author: this.settings.personality.name, text: `@${e.nickname} ${pub}`, emotion, createdAt: Date.now(), replyTo: e.id });
    }
    this.relay?.fanResult(e.id, e.fanId, 'answered');
    if (item) item.status = 'answered';
    this.emit({ type: 'moderation', items: this.moderation });
    this.memory.add('fan', `Visitor ${e.nickname} said "${job.text.slice(0, 80)}"`, 0.4);
  }

  // -------------------------------------------------------------------------
  // autonomous thoughts & screen peeks
  // -------------------------------------------------------------------------

  private thoughtDelay() {
    const s = this.settings.behavior.thinkIntervalSec;
    return s > 0 ? (s * (0.7 + Math.random() * 0.6)) * 1000 : 60_000;
  }

  private async think() {
    this.nextThought = Date.now() + this.thoughtDelay();
    const p = this.sim.pet;
    if (!this.provider || this.settings.behavior.thinkIntervalSec <= 0 || this.brainBusy || this.queue.busy || this.queue.size) return;
    if (p.mode !== 'windowed' || !['idle', 'walking'].includes(p.activity)) return;
    if (Date.now() - this.lastOwnerChat < 30_000) return;
    this.brainBusy = true;
    try {
      // No memories here: thoughts are spoken in the (public) world.
      const out = await this.provider.complete({ messages: thoughtMessages(this.promptContext(false)), maxTokens: 90, temperature: 0.9 });
      const r = parseTagged(out);
      this.sim.applyTags([...(r.emotion ? [{ type: 'emotion' as const, emotion: r.emotion }] : []), ...r.actions.slice(0, 1)], 'self');
      if (r.text && Math.random() < 0.4 + this.settings.personality.chattiness * 0.6) {
        this.sim.say(r.text.slice(0, 200), { emotion: r.emotion, visibility: 'public', audience: 'self' });
      }
    } catch (e) {
      this.emit({ type: 'brain', status: 'error', message: explainError(e, this.settings.llm.baseUrl || 'http://localhost') });
    } finally {
      this.brainBusy = false;
    }
  }

  /** Optional unprompted look at the screen. Off by default; private bubble only. */
  private async peek() {
    const cfg = this.settings.behavior.screenPeek;
    this.nextPeek = Date.now() + cfg.intervalMin * 60_000;
    if (!cfg.enabled || !this.provider || !this.settings.llm.vision || !this.sim.capabilities.screen_questions) return;
    if (!cfg.allowCloud && !isLocalConfig(this.settings.llm)) return;
    if (this.brainBusy || this.queue.busy) return;
    const img = await this.adapters.captureScreen?.();
    if (!img) return;
    const ctx = this.promptContext(false);
    const ctrl = new AbortController();
    await this.streamReply(
      ownerChatMessages(ctx, [], 'You just peeked at my screen (screenshot attached). Make ONE short, friendly, curious comment or question about it. Do not read out private details like names, emails, or numbers.', img),
      { visibility: 'private', audience: 'owner', source: 'owner', replyTo: 'peek', signal: ctrl.signal },
    );
  }

  /** Owner-triggered "ask Blurb about my screen". */
  async askAboutScreen(question: string) {
    const img = await this.adapters.captureScreen?.();
    if (!img) return this.ownerSay(question || 'What do you see on my screen?');
    this.ownerSay(question || 'What do you see on my screen?', { image: img });
  }

  // -------------------------------------------------------------------------
  // misc owner actions
  // -------------------------------------------------------------------------

  describeObject(id: string): string {
    const o = this.sim.world.objects.find((x) => x.id === id);
    if (!o) return '';
    return `${OBJECT_DEFS[o.kind].label} (${o.color})`;
  }
}
