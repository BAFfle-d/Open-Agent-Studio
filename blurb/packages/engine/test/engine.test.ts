import { describe, expect, it } from 'vitest';
import { WORLD } from '@blurb/shared';
import { DesktopSim, PetSim, type DesktopEnv } from '../src/index.js';

/** Deterministic RNG so behavior tests are stable. */
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function run(sim: PetSim, seconds: number, step = 0.1) {
  const t0 = Date.now();
  for (let t = 0; t < seconds; t += step) sim.tick(step, t0 + t * 1000);
}

function makeSim() {
  const sim = new PetSim();
  sim.rng = seeded();
  sim.hourOverride = 14;
  return sim;
}

describe('PetSim needs & decisions', () => {
  it('a hungry Blurb walks to the bowl and eats', () => {
    const sim = makeSim();
    sim.pet.needs = { energy: 90, fullness: 5, curiosity: 10, boredom: 10, social: 10 };
    const before = sim.world.objects.find((o) => o.kind === 'food_bowl')!.data!.servings!;
    const seen = new Set<string>();
    sim.on((e) => e.type === 'activity' && seen.add(e.activity));
    run(sim, 30);
    expect(seen.has('eating')).toBe(true);
    expect(sim.world.objects.find((o) => o.kind === 'food_bowl')!.data!.servings).toBeLessThan(before);
    expect(sim.pet.needs.fullness).toBeGreaterThan(20);
  });

  it('a tired Blurb naps and recovers energy', () => {
    const sim = makeSim();
    sim.pet.needs = { energy: 5, fullness: 90, curiosity: 10, boredom: 10, social: 10 };
    run(sim, 20);
    expect(sim.pet.activity).toBe('sleeping');
    run(sim, 90);
    expect(sim.pet.needs.energy).toBeGreaterThan(60);
  });

  it('treats fill the bowl and earn a public thank-you', () => {
    const sim = makeSim();
    const speeches: string[] = [];
    sim.on((e) => e.type === 'speech' && e.speech.visibility === 'public' && speeches.push(e.speech.text));
    const bowl = sim.world.objects.find((o) => o.kind === 'food_bowl')!;
    const before = bowl.data!.servings!;
    sim.giveTreat('cookie', 'Sunny', 'fan');
    expect(bowl.data!.servings).toBe(before + 1);
    expect(speeches.join(' ')).toMatch(/Sunny/);
  });

  it('drag and drop: Blurb falls back to the floor', () => {
    const sim = makeSim();
    sim.dragStart();
    sim.dragMove(200, 120);
    sim.dragMove(200, 60);
    expect(sim.pet.activity).toBe('dragged');
    sim.dragEnd();
    expect(sim.pet.activity).toBe('falling');
    run(sim, 3);
    expect(sim.pet.position.y).toBe(WORLD.floorY);
    expect(sim.pet.activity).not.toBe('falling');
  });
});

describe('BlurbScript execution & approvals', () => {
  it('applies a validated program and refuses the rest', () => {
    const sim = makeSim();
    const r = sim.runProgram([
      { op: 'transform', target: 'tree-1', into: 'bush' },
      { op: 'recolor', target: 'bed-1', color: '#00ff00' },
      { op: 'fly', height: 100 },
    ]);
    expect(r.ops).toHaveLength(2);
    expect(r.rejected).toHaveLength(1);
    expect(sim.world.objects.find((o) => o.id === 'tree-1')!.kind).toBe('bush');
    expect(sim.world.objects.find((o) => o.id === 'bed-1')!.color).toBe('#00ff00');
  });

  it('designed shapes need owner approval before Blurb can wear them', () => {
    const sim = makeSim();
    sim.runProgram([{ op: 'design_shape', name: 'Mochi', spec: { width: 26, height: 20, peak: 'flat', feet: 3, ears: 'nubs', lean: 0, gloss: true } }]);
    expect(sim.outbox).toHaveLength(1);
    expect(sim.dropBox.shapes).toHaveLength(1);
    // Blurb walks to the comm box to deliver it
    run(sim, 30);
    expect(sim.outbox).toHaveLength(0);
    const note = sim.notes.find((n) => n.request)!;
    expect(note.request!.status).toBe('pending');
    expect(sim.world.objects.find((o) => o.kind === 'comm_box')!.data!.unread).toBe(1);
    // trying to wear it before approval is refused
    expect(sim.runProgram([{ op: 'set_shape', shape: note.request!.design.id }]).ops).toHaveLength(0);
    sim.decideShape(note.id, true);
    expect(sim.dropBox.shapes.map((s) => s.name)).toContain('Mochi');
    expect(sim.pet.appearance.shapeId).toBe(note.request!.design.id);
  });

  it('a computer session runs a rule program when no LLM is configured', () => {
    const sim = makeSim();
    sim.pet.needs = { energy: 90, fullness: 90, curiosity: 100, boredom: 100, social: 0 };
    sim.world.objects = sim.world.objects.filter((o) => !['bookshelf', 'ball', 'yarn', 'plushie', 'tree', 'bush', 'resource', 'workbench'].includes(o.kind));
    let programs = 0;
    sim.on((e) => e.type === 'program' && programs++);
    run(sim, 40);
    expect(programs).toBeGreaterThan(0);
  });

  it('fan-context replies cannot trigger privileged actions', () => {
    const sim = makeSim();
    sim.applyTags([{ type: 'action', action: 'code' }, { type: 'action', action: 'goto', arg: 'computer-1' }], 'fan');
    expect(sim.pet.activity).not.toBe('walking');
    sim.applyTags([{ type: 'action', action: 'dance' }], 'fan');
    expect(sim.pet.gesture).toBe('dance');
    sim.applyTags([{ type: 'action', action: 'code' }], 'owner');
    expect(sim.pet.activity).toBe('walking');
    expect(sim.pet.goal?.objectId).toBe('computer-1');
  });
});

describe('DesktopSim', () => {
  const env = (windows: DesktopEnv['windows'] = []): DesktopEnv => ({
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    windows,
    cursor: { x: 500, y: 500 },
  });

  it('enters on the taskbar and stays on surfaces (never flies)', () => {
    const sim = makeSim();
    sim.setMode('overlay');
    const d = new DesktopSim(sim);
    const e = env();
    d.enter(e);
    for (let i = 0; i < 600; i++) {
      d.step(0.05, e);
      const p = sim.pet.desktop!.position;
      if (d.mode !== 'fall' && d.mode !== 'dragged') expect(p.y).toBe(1040);
    }
  });

  it('climbs onto a window, rides it, and falls when it closes', () => {
    const sim = makeSim();
    sim.setMode('overlay');
    sim.pet.needs = { energy: 100, fullness: 100, curiosity: 100, boredom: 0, social: 0 };
    sim.capabilities.chase_cursor = false;
    const d = new DesktopSim(sim);
    const win = { id: 'w1', bounds: { x: 600, y: 500, width: 700, height: 400 } };
    let e = env([win]);
    d.enter(e);
    let sat = false;
    for (let i = 0; i < 2000 && !sat; i++) {
      d.step(0.05, e);
      sat = d.mode === 'sit';
    }
    expect(sat).toBe(true);
    expect(sim.pet.desktop!.position.y).toBe(500);
    // window moves → Blurb rides along
    e = env([{ id: 'w1', bounds: { ...win.bounds, y: 450, x: 650 } }]);
    d.step(0.05, e);
    expect(sim.pet.desktop!.position.y).toBe(450);
    // window closes → falls to the taskbar
    e = env([]);
    for (let i = 0; i < 100; i++) d.step(0.05, e);
    expect(sim.pet.desktop!.position.y).toBe(1040);
  });

  it('naps in a corner when exploring is switched off', () => {
    const sim = makeSim();
    sim.setMode('overlay');
    sim.capabilities.desktop_explore = false;
    const d = new DesktopSim(sim);
    const e = env();
    d.enter(e);
    for (let i = 0; i < 400; i++) d.step(0.05, e);
    expect(sim.pet.activity).toBe('desktop_nap');
  });
});
