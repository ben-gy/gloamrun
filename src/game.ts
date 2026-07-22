// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * game.ts — the Gloamrun simulation. Pure, deterministic, and the SAME object on
 * every peer.
 *
 * Authority model (host-authoritative star — see net-game.ts):
 *   - The HOST calls `hostStep(dt)`, which runs the whole world: monster spawns,
 *     monster AI, hero auto-fire, every projectile and collision, HP, downs and
 *     revives, and the floor/phase machine. It then broadcasts a snapshot.
 *   - A CLIENT never calls hostStep. It applies snapshots into these same arrays
 *     and predicts only its own hero's motion. Because the client's Game IS the
 *     full world (just fed from the host), a promoted peer already holds it — its
 *     takeover is "start calling hostStep", not "rebuild from a snapshot".
 *
 * Determinism: every random draw goes through `this.rng` (seeded from the shared
 * seed) or a per-floor rng seeded from (seed, floor). Never Math.random — a
 * desync in a co-op sim is the whole party disagreeing about the swarm.
 */

import { makeRng, randInt, randFloat, type Rng } from '@ben-gy/game-engine/rng';
import { baseStats, type HeroStats } from './upgrades';
import { tuning } from './tuning';
import type { Mode } from './modes';

export const HERO_R = 13;
export const SHOT_R = 5;
export const MSHOT_R = 6;
const STAIR_R = 34;
const REVIVE_R = 52;
const REVIVE_NEED = 2.5;
const IFRAME = 0.7;
const DASH_TIME = 0.16;
const DASH_SPEED = 520;

// ── monster archetypes ────────────────────────────────────────────────────────

export type MonsterKind = 'crawler' | 'spitter' | 'brute' | 'boss';

interface Archetype {
  hp: number;
  speed: number;
  r: number;
  touch: number; // contact damage
  ranged?: { range: number; cd: number; dmg: number; spread: number; count: number };
}

const ARCH: Record<MonsterKind, Archetype> = {
  crawler: { hp: 18, speed: 78, r: 12, touch: 1 },
  spitter: { hp: 14, speed: 52, r: 11, touch: 1, ranged: { range: 210, cd: 1.9, dmg: 1, spread: 0, count: 1 } },
  brute: { hp: 64, speed: 46, r: 18, touch: 2 },
  boss: { hp: 340, speed: 40, r: 34, touch: 2, ranged: { range: 460, cd: 1.5, dmg: 1, spread: 0.5, count: 5 } },
};

export interface Monster {
  id: number;
  kind: MonsterKind;
  elite: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  r: number;
  speed: number;
  touch: number;
  fireCd: number;
  hitCd: number; // contact-damage cooldown so a body doesn't multi-hit per frame
  /** render-smoothing position, client only. */
  rx: number;
  ry: number;
}

export interface Shot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  life: number;
  pierce: number;
  owner: number; // hero seat
  hit: Set<number>;
}

export interface MShot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  life: number;
  rx: number;
  ry: number;
}

export interface HeroContribution {
  dmg: number;
  kills: number;
  revives: number;
  downs: number;
  floors: number;
}

export interface Hero {
  i: number;
  name: string;
  bot: boolean;
  left: boolean;
  x: number;
  y: number;
  ax: number; // move intent x (-1..1)
  ay: number;
  aimx: number; // last facing (for muzzle fx)
  aimy: number;
  hp: number;
  down: boolean;
  reviveT: number;
  invT: number;
  fireCd: number;
  dashCd: number;
  dashT: number;
  wantDash: boolean;
  onStair: number; // seconds continuously on the stair
  stats: HeroStats;
  contrib: HeroContribution;
  /** render-smoothing position, client only. */
  rx: number;
  ry: number;
}

export type Phase = 'fighting' | 'cleared' | 'draft' | 'over';

export type Ev =
  | { k: 'fire'; i: number; x: number; y: number }
  | { k: 'mhit'; x: number; y: number }
  | { k: 'kill'; x: number; y: number; i: number; boss: boolean; elite: boolean }
  | { k: 'hurt'; i: number; x: number; y: number }
  | { k: 'down'; i: number; x: number; y: number }
  | { k: 'revive'; i: number; x: number; y: number }
  | { k: 'spawn'; x: number; y: number; boss: boolean }
  | { k: 'mshot'; x: number; y: number }
  | { k: 'clear'; floor: number }
  | { k: 'descend'; floor: number };

export interface Seat {
  name: string;
  bot: boolean;
}

export interface GameCfg {
  seed: number;
  mode: Mode;
  seats: Seat[];
}

/** Base room half-extents (before mode scale). */
const BASE_HW = 340;
const BASE_HH = 230;

export class Game {
  readonly seed: number;
  readonly mode: Mode;
  readonly hw: number;
  readonly hh: number;
  private rng: Rng;

  heroes: Hero[] = [];
  monsters: Monster[] = [];
  shots: Shot[] = [];
  mshots: MShot[] = [];

  floor = 1;
  phase: Phase = 'fighting';
  over = false;
  overReason = '';
  /** Deepest floor the party actually started fighting on. */
  reached = 1;

  /** Wall-clock seconds spent this run (host-authoritative, for the HUD/pacing). */
  t = 0;

  /** The full deterministic monster list for the current floor. */
  private queue: Monster[] = [];
  spawnIdx = 0;
  private spawnTimer = 0;
  private clearT = 0; // seconds since the floor was cleared

  /** seat -> chosen upgrade id for the current draft. */
  picks = new Map<number, string>();

  private nextShotId = 1;
  private nextMShotId = 1;

  events: Ev[] = [];

  constructor(cfg: GameCfg) {
    this.seed = cfg.seed;
    this.mode = cfg.mode;
    this.rng = makeRng(cfg.seed ^ 0x1a2b3c4d);
    this.hw = Math.round(BASE_HW * cfg.mode.roomScale);
    this.hh = Math.round(BASE_HH * cfg.mode.roomScale);

    this.heroes = cfg.seats.map((s, i) => this.makeHero(i, s, cfg.seats.length));
    this.beginFloor(1);
  }

  private makeHero(i: number, s: Seat, total: number): Hero {
    // Heroes ring the centre so nobody spawns on top of a teammate or in a wall.
    const n = Math.max(1, total);
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const ring = n > 1 ? 46 : 0;
    const x = Math.cos(angle) * ring;
    const y = Math.sin(angle) * ring;
    const stats = baseStats();
    return {
      i,
      name: s.name,
      bot: s.bot,
      left: false,
      x,
      y,
      ax: 0,
      ay: 0,
      aimx: 0,
      aimy: -1,
      hp: stats.maxHp,
      down: false,
      reviveT: 0,
      invT: 0,
      fireCd: 0,
      dashCd: 0,
      dashT: 0,
      wantDash: false,
      onStair: 0,
      stats,
      contrib: { dmg: 0, kills: 0, revives: 0, downs: 0, floors: 1 },
      rx: x,
      ry: y,
    };
  }

  // ── floor generation ───────────────────────────────────────────────────────

  /** Number of living (present, not left) heroes — the swarm scales to this. */
  livingSeats(): number {
    return Math.max(1, this.heroes.filter((h) => !h.left).length);
  }

  private isBossFloor(floor: number): boolean {
    return floor % this.mode.bossEvery === 0;
  }

  /** Generate the full monster queue for a floor — deterministic in (seed,floor). */
  private buildQueue(floor: number): Monster[] {
    const rng = makeRng((this.seed ^ 0x51ed270b) + floor * 2654435761);
    const m = this.mode;
    const seats = this.livingSeats();
    // The ramp COMPOUNDS: gentle for the first few floors so a solo player can
    // find their feet, then superlinear so even a full party of revivers is
    // eventually overwhelmed rather than kiting an endless, harmless swarm. The
    // sim proved a linear ramp let 4-player parties run to the floor cap ~40% of
    // the time — never a game. See tests/balance.test.ts.
    // Two terms with two jobs. The linear+superlinear part shapes the early
    // ramp a player actually feels. The EXPONENTIAL part (dormant for the first
    // five floors, then 5%/floor) exists purely to guarantee termination: hero
    // upgrades compound multiplicatively, so without a term that also grows
    // geometrically a great party's DPS outruns the swarm forever and the run
    // never ends. The sim proved exactly that — see tests/balance.test.ts.
    const hpRamp =
      (1 + (floor - 1) * 0.3 + Math.pow(Math.max(0, floor - 1), 1.5) * 0.03) *
      Math.pow(tuning().RAMP_EXP, Math.max(0, floor - 5));
    // Deep monsters get FAST — kiting alone must stop working, or the swarm can
    // never actually corner anyone (heroes move 150; a base crawler starts at 78
    // and passes hero speed around floor ~13, which is where the dash stops being
    // a luxury and becomes the only way out).
    const spdRamp = Math.min(2.2, 1 + (floor - 1) * 0.055);
    // Contact damage climbs with depth so a couple of mistakes actually down you
    // — the revive loop has to have teeth or a party is immortal.
    const touchBonus = Math.floor(floor / 4);
    // Party scaling: more monsters AND tougher ones, so four guns do not simply
    // out-DPS a swarm sized for one.
    const partyMul = 0.55 + 0.45 * seats;
    const partyHp = 1 + (seats - 1) * 0.16;
    const out: Monster[] = [];
    let idx = 0;
    const push = (kind: MonsterKind, forceElite = false): void => {
      const a = ARCH[kind];
      const eliteChance = Math.min(0.5, m.eliteBase + floor * 0.012);
      const elite = forceElite || (kind !== 'boss' && rng() < eliteChance);
      const em = elite ? 2 : 1;
      // Spawn on the room perimeter at a random point.
      const side = randInt(rng, 0, 3);
      const t = rng();
      let x = 0;
      let y = 0;
      if (side === 0) { x = -this.hw + 6; y = (t * 2 - 1) * this.hh; }
      else if (side === 1) { x = this.hw - 6; y = (t * 2 - 1) * this.hh; }
      else if (side === 2) { y = -this.hh + 6; x = (t * 2 - 1) * this.hw; }
      else { y = this.hh - 6; x = (t * 2 - 1) * this.hw; }
      const hp = Math.round(a.hp * hpRamp * m.hpMul * partyHp * em);
      out.push({
        id: floor * 1000 + idx++,
        kind,
        elite,
        x, y, vx: 0, vy: 0, rx: x, ry: y,
        hp,
        maxHp: hp,
        r: a.r * (elite ? 1.2 : 1),
        speed: a.speed * spdRamp * m.spdMul * (elite ? 1.12 : 1),
        touch: a.touch + touchBonus + (elite ? 1 : 0),
        fireCd: randFloat(rng, 0.4, 1.6),
        hitCd: 0,
      });
    };

    if (this.isBossFloor(floor)) {
      push('boss');
      const guards = Math.round((2 + floor * 0.3) * seats * 0.6);
      for (let i = 0; i < guards; i++) push(rng() < 0.5 ? 'crawler' : 'spitter');
    } else {
      const count = Math.round((m.waveBase + m.waveGrow * (floor - 1)) * partyMul);
      for (let i = 0; i < count; i++) {
        const roll = rng();
        let kind: MonsterKind = 'crawler';
        // Deeper floors mix in ranged and tanks.
        const spitP = Math.min(0.4, 0.12 + floor * 0.02);
        const bruteP = floor >= 3 ? Math.min(0.28, 0.05 + (floor - 2) * 0.03) : 0;
        if (roll < bruteP) kind = 'brute';
        else if (roll < bruteP + spitP) kind = 'spitter';
        push(kind);
      }
    }
    return out;
  }

  private beginFloor(floor: number): void {
    this.floor = floor;
    this.reached = Math.max(this.reached, floor);
    this.phase = 'fighting';
    this.queue = this.buildQueue(floor);
    this.spawnIdx = 0;
    this.spawnTimer = 0;
    this.clearT = 0;
    this.monsters = [];
    this.mshots = [];
    this.shots = [];
    this.picks.clear();
    for (const h of this.heroes) {
      if (h.left) continue;
      h.onStair = 0;
      h.contrib.floors = floor;
    }
    if (this.isBossFloor(floor)) this.events.push({ k: 'spawn', x: 0, y: -this.hh, boss: true });
  }

  // ── intent (set by Session before hostStep) ─────────────────────────────────

  setIntent(i: number, ax: number, ay: number, dash: boolean): void {
    const h = this.heroes[i];
    if (!h || h.left) return;
    const len = Math.hypot(ax, ay);
    if (len > 1e-4) {
      h.ax = ax / Math.max(1, len);
      h.ay = ay / Math.max(1, len);
      h.aimx = h.ax;
      h.aimy = h.ay;
    } else {
      h.ax = 0;
      h.ay = 0;
    }
    if (dash) h.wantDash = true;
  }

  // ── the authoritative step (host only) ──────────────────────────────────────

  hostStep(dt: number): void {
    if (this.over) return;
    this.t += dt;

    if (this.phase === 'draft') {
      // The world is frozen while everyone drafts; only revive-safety and the
      // wipe check are irrelevant here. Nothing to sim.
      this.stepHeroesIdle(dt);
      return;
    }

    this.stepHeroes(dt);
    if (this.phase === 'fighting') {
      this.release(dt);
      this.stepMonsters(dt);
      this.stepShots(dt);
      this.stepMShots(dt);
      this.checkClear();
    } else if (this.phase === 'cleared') {
      // No monsters, but shots/mshots finish their flight and heroes walk to the
      // stair.
      this.stepShots(dt);
      this.stepMShots(dt);
      this.checkDescend(dt);
    }

    this.checkWipe();
  }

  /** Heroes during the draft: cooldowns tick, but no movement matters. */
  private stepHeroesIdle(dt: number): void {
    for (const h of this.heroes) {
      if (h.left) continue;
      h.invT = Math.max(0, h.invT - dt);
      h.dashCd = Math.max(0, h.dashCd - dt);
    }
  }

  private stepHeroes(dt: number): void {
    for (const h of this.heroes) {
      if (h.left) continue;
      h.invT = Math.max(0, h.invT - dt);
      h.dashCd = Math.max(0, h.dashCd - dt);
      h.fireCd = Math.max(0, h.fireCd - dt);
      if (h.dashT > 0) h.dashT = Math.max(0, h.dashT - dt);

      if (h.down) {
        h.ax = 0;
        h.ay = 0;
        h.wantDash = false;
        this.stepRevive(h, dt);
        continue;
      }

      // Dash: a burst of speed with i-frames, on cooldown.
      if (h.wantDash && h.dashCd <= 0 && (h.ax || h.ay)) {
        h.dashT = DASH_TIME;
        h.dashCd = h.stats.dashCd;
        h.invT = Math.max(h.invT, DASH_TIME + 0.05);
      }
      h.wantDash = false;

      const speed = h.dashT > 0 ? DASH_SPEED : h.stats.moveSpeed;
      h.x += h.ax * speed * dt;
      h.y += h.ay * speed * dt;
      h.x = clamp(h.x, -this.hw + HERO_R, this.hw - HERO_R);
      h.y = clamp(h.y, -this.hh + HERO_R, this.hh - HERO_R);

      // Auto-fire at the nearest monster.
      if (this.phase === 'fighting') this.tryFire(h, dt);
    }
  }

  private stepRevive(h: Hero, dt: number): void {
    // A downed hero is revived by any alive teammate standing over them.
    let reviver: Hero | null = null;
    for (const o of this.heroes) {
      if (o.left || o.down || o.i === h.i) continue;
      if (dist(o.x, o.y, h.x, h.y) <= REVIVE_R) {
        reviver = o;
        break;
      }
    }
    if (reviver) {
      h.reviveT += dt;
      if (h.reviveT >= REVIVE_NEED) {
        h.down = false;
        h.reviveT = 0;
        h.hp = Math.max(1, Math.ceil(h.stats.maxHp * 0.5));
        h.invT = 1.2;
        reviver.contrib.revives += 1;
        this.events.push({ k: 'revive', i: h.i, x: h.x, y: h.y });
      }
    } else {
      h.reviveT = Math.max(0, h.reviveT - dt * 0.6);
    }
  }

  private tryFire(h: Hero, _dt: number): void {
    if (h.fireCd > 0) return;
    const target = this.nearestMonster(h.x, h.y);
    if (!target) return;
    h.fireCd = 1 / h.stats.fireRate;
    const baseAng = Math.atan2(target.y - h.y, target.x - h.x);
    h.aimx = Math.cos(baseAng);
    h.aimy = Math.sin(baseAng);
    const n = Math.max(1, Math.round(h.stats.shots));
    const spread = n > 1 ? 0.22 : 0;
    for (let k = 0; k < n; k++) {
      const off = n > 1 ? (k - (n - 1) / 2) * spread : 0;
      const ang = baseAng + off;
      const crit = this.rng() < h.stats.crit;
      this.shots.push({
        id: this.nextShotId++,
        x: h.x + Math.cos(ang) * (HERO_R + 2),
        y: h.y + Math.sin(ang) * (HERO_R + 2),
        vx: Math.cos(ang) * h.stats.projSpeed,
        vy: Math.sin(ang) * h.stats.projSpeed,
        dmg: h.stats.dmg * (crit ? 3 : 1),
        life: 1.3,
        pierce: h.stats.pierce,
        owner: h.i,
        hit: new Set(),
      });
    }
    this.events.push({ k: 'fire', i: h.i, x: h.x, y: h.y });
  }

  private nearestMonster(x: number, y: number): Monster | null {
    let best: Monster | null = null;
    let bd = Infinity;
    for (const m of this.monsters) {
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }

  private nearestHero(x: number, y: number): Hero | null {
    let best: Hero | null = null;
    let bd = Infinity;
    for (const h of this.heroes) {
      if (h.left || h.down) continue;
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  // ── monsters ────────────────────────────────────────────────────────────────

  /**
   * How many monsters may be alive at once. Grows with depth and party size so a
   * geared four-gun party cannot simply kite a fixed-size swarm forever — the sim
   * showed a flat maxAlive left Delve parties immortal past floor ~10. Hard-capped
   * so it never melts a phone.
   */
  private aliveCap(): number {
    const seats = this.livingSeats();
    return Math.min(28, Math.round(this.mode.maxAlive + Math.floor((this.floor - 1) / 3) * (1 + seats * 0.6)));
  }

  private release(dt: number): void {
    this.spawnTimer -= dt;
    const cadence = 0.35;
    const cap = this.aliveCap();
    while (
      this.spawnIdx < this.queue.length &&
      this.monsters.length < cap &&
      this.spawnTimer <= 0
    ) {
      const m = this.queue[this.spawnIdx++];
      this.monsters.push(m);
      this.spawnTimer = cadence;
      this.events.push({ k: 'spawn', x: m.x, y: m.y, boss: m.kind === 'boss' });
    }
  }

  private stepMonsters(dt: number): void {
    for (const m of this.monsters) {
      m.hitCd = Math.max(0, m.hitCd - dt);
      const target = this.nearestHero(m.x, m.y);
      const a = ARCH[m.kind];
      if (target) {
        const dx = target.x - m.x;
        const dy = target.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        if (a.ranged) {
          // Ranged monsters hold their preferred range and fire.
          const want = a.ranged.range * 0.75;
          let dir = 0;
          if (d > a.ranged.range) dir = 1; // close in
          else if (d < want * 0.7) dir = -1; // back off
          m.vx = (dx / d) * m.speed * dir;
          m.vy = (dy / d) * m.speed * dir;
          m.fireCd -= dt;
          if (m.fireCd <= 0 && d <= a.ranged.range) {
            m.fireCd = a.ranged.cd;
            this.monsterFire(m, dx / d, dy / d, a.ranged);
          }
        } else {
          m.vx = (dx / d) * m.speed;
          m.vy = (dy / d) * m.speed;
        }
      } else {
        m.vx = 0;
        m.vy = 0;
      }
      m.x = clamp(m.x + m.vx * dt, -this.hw + m.r, this.hw - m.r);
      m.y = clamp(m.y + m.vy * dt, -this.hh + m.r, this.hh - m.r);

      // Contact damage.
      if (m.hitCd <= 0) {
        for (const h of this.heroes) {
          if (h.left || h.down || h.invT > 0) continue;
          if (dist(m.x, m.y, h.x, h.y) <= m.r + HERO_R) {
            this.hurt(h, m.touch);
            m.hitCd = 0.6;
            break;
          }
        }
      }
    }
  }

  private monsterFire(m: Monster, dx: number, dy: number, r: NonNullable<Archetype['ranged']>): void {
    const base = Math.atan2(dy, dx);
    for (let k = 0; k < r.count; k++) {
      const off = r.count > 1 ? (k - (r.count - 1) / 2) * r.spread : 0;
      const ang = base + off;
      // Bolts speed up with depth, so late-floor volleys can no longer be strolled
      // out of the way of.
      const spd = Math.min(320, 185 + this.floor * 7);
      this.mshots.push({
        id: this.nextMShotId++,
        x: m.x + Math.cos(ang) * (m.r + 2),
        y: m.y + Math.sin(ang) * (m.r + 2),
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        dmg: r.dmg,
        life: 3,
        rx: m.x,
        ry: m.y,
      });
    }
    this.events.push({ k: 'mshot', x: m.x, y: m.y });
  }

  private stepShots(dt: number): void {
    const keep: Shot[] = [];
    for (const s of this.shots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      let dead = s.life <= 0 || Math.abs(s.x) > this.hw + 20 || Math.abs(s.y) > this.hh + 20;
      if (!dead) {
        for (const m of this.monsters) {
          if (s.hit.has(m.id)) continue;
          if (dist(s.x, s.y, m.x, m.y) <= SHOT_R + m.r) {
            s.hit.add(m.id);
            this.damageMonster(m, s.dmg, s.owner);
            this.events.push({ k: 'mhit', x: s.x, y: s.y });
            if (s.pierce > 0) s.pierce -= 1;
            else {
              dead = true;
              break;
            }
          }
        }
      }
      if (!dead) keep.push(s);
    }
    this.shots = keep;
    // Drop dead monsters after damage resolution.
    this.monsters = this.monsters.filter((m) => m.hp > 0);
  }

  private damageMonster(m: Monster, dmg: number, by: number): void {
    m.hp -= dmg;
    const owner = this.heroes[by];
    if (owner) owner.contrib.dmg += dmg;
    if (m.hp <= 0) {
      if (owner) {
        owner.contrib.kills += 1;
        if (owner.stats.lifesteal > 0 && this.rng() < owner.stats.lifesteal && !owner.down) {
          owner.hp = Math.min(owner.stats.maxHp, owner.hp + 1);
        }
      }
      this.events.push({ k: 'kill', x: m.x, y: m.y, i: by, boss: m.kind === 'boss', elite: m.elite });
    }
  }

  private stepMShots(dt: number): void {
    const keep: MShot[] = [];
    for (const s of this.mshots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      let dead = s.life <= 0 || Math.abs(s.x) > this.hw + 20 || Math.abs(s.y) > this.hh + 20;
      if (!dead) {
        for (const h of this.heroes) {
          if (h.left || h.down || h.invT > 0) continue;
          if (dist(s.x, s.y, h.x, h.y) <= MSHOT_R + HERO_R) {
            this.hurt(h, s.dmg);
            dead = true;
            break;
          }
        }
      }
      if (!dead) keep.push(s);
    }
    this.mshots = keep;
  }

  private hurt(h: Hero, dmg: number): void {
    if (h.down || h.invT > 0 || h.left) return;
    h.hp -= dmg;
    h.invT = IFRAME;
    if (h.hp <= 0) {
      h.hp = 0;
      h.down = true;
      h.reviveT = 0;
      h.contrib.downs += 1;
      this.events.push({ k: 'down', i: h.i, x: h.x, y: h.y });
    } else {
      this.events.push({ k: 'hurt', i: h.i, x: h.x, y: h.y });
    }
  }

  // ── phase machine ───────────────────────────────────────────────────────────

  private checkClear(): void {
    if (this.spawnIdx >= this.queue.length && this.monsters.length === 0) {
      this.phase = 'cleared';
      this.clearT = 0;
      // Floors are checkpoints: clearing one revives everyone who was down.
      for (const h of this.heroes) {
        if (h.left) continue;
        if (h.down) {
          h.down = false;
          h.hp = Math.max(1, Math.ceil(h.stats.maxHp * 0.5));
          this.events.push({ k: 'revive', i: h.i, x: h.x, y: h.y });
        }
        h.onStair = 0;
      }
      this.events.push({ k: 'clear', floor: this.floor });
    }
  }

  private checkDescend(dt: number): void {
    this.clearT += dt;
    let anyOnStair = false;
    let allOnStair = true;
    let alive = 0;
    for (const h of this.heroes) {
      if (h.left) continue;
      alive++;
      const on = dist(h.x, h.y, 0, 0) <= STAIR_R;
      if (on) {
        h.onStair += dt;
        anyOnStair = true;
      } else {
        h.onStair = 0;
        allOnStair = false;
      }
    }
    // Everyone on the stair descends at once. A laggard cannot hang the party
    // forever: once someone has held the stair for a grace window, it goes.
    const forced = anyOnStair && this.clearT > 8 && this.heroes.some((h) => !h.left && h.onStair > 4);
    if (alive > 0 && (allOnStair || forced)) this.enterDraft();
  }

  private enterDraft(): void {
    this.phase = 'draft';
    this.picks.clear();
  }

  /** Record a seat's draft choice and apply it. Idempotent per seat. */
  pickUpgrade(seat: number, id: string, apply: (s: HeroStats) => void): void {
    if (this.phase !== 'draft') return;
    const h = this.heroes[seat];
    if (!h || h.left || this.picks.has(seat)) return;
    this.picks.set(seat, id);
    const before = h.stats.maxHp;
    apply(h.stats);
    // The Iron Heart card heals to full; any maxHp gain tops the hero up by the
    // delta so it is never a downgrade to your current bar.
    if (h.stats.maxHp > before) h.hp = Math.min(h.stats.maxHp, h.hp + (h.stats.maxHp - before));
  }

  /** True once every present hero has drafted (host decides to descend). */
  allPicked(): boolean {
    for (const h of this.heroes) {
      if (h.left) continue;
      if (!this.picks.has(h.i)) return false;
    }
    return true;
  }

  /** Advance to the next floor. Host-driven (on allPicked or a grace timeout). */
  descend(): void {
    if (this.phase !== 'draft' || this.over) return;
    this.events.push({ k: 'descend', floor: this.floor + 1 });
    this.beginFloor(this.floor + 1);
  }

  private checkWipe(): void {
    if (this.over) return;
    const present = this.heroes.filter((h) => !h.left);
    if (present.length === 0) return;
    if (present.every((h) => h.down)) {
      this.over = true;
      this.phase = 'over';
      const killer = this.deadliest();
      this.overReason = killer;
    }
  }

  private deadliest(): string {
    // A short human-readable cause for the results screen.
    if (this.isBossFloor(this.floor) && this.monsters.some((m) => m.kind === 'boss')) {
      return `the Floor ${this.floor} boss`;
    }
    const counts: Record<string, number> = {};
    for (const m of this.monsters) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const label: Record<string, string> = {
      crawler: 'a swarm of crawlers',
      spitter: 'a volley of spitters',
      brute: 'the brutes',
      boss: 'the boss',
    };
    return top ? label[top[0]] ?? 'the swarm' : 'the swarm';
  }

  // ── queries ──────────────────────────────────────────────────────────────────

  aliveCount(): number {
    return this.heroes.filter((h) => !h.left && !h.down).length;
  }

  /** Party health fraction, for the vignette. */
  partyHealth(): number {
    const present = this.heroes.filter((h) => !h.left);
    if (!present.length) return 0;
    let hp = 0;
    let max = 0;
    for (const h of present) {
      hp += h.down ? 0 : h.hp;
      max += h.stats.maxHp;
    }
    return max > 0 ? hp / max : 0;
  }

  /**
   * Client-side: keep floor/queue/spawnIdx aligned with the host's snapshot so a
   * promoted peer can continue the exact spawn sequence. Does NOT touch monsters
   * or heroes — the snapshot owns those.
   */
  syncFloor(floor: number, spawnIdx: number): void {
    if (floor !== this.floor) {
      this.floor = floor;
      this.reached = Math.max(this.reached, floor);
      this.queue = this.buildQueue(floor);
      this.spawnTimer = 0;
    }
    this.spawnIdx = Math.min(this.queue.length, Math.max(this.spawnIdx, spawnIdx));
  }

  /** Mark a hero as gone (peer left). Its slot dissolves. */
  dissolve(i: number): void {
    const h = this.heroes[i];
    if (!h || h.left) return;
    h.left = true;
    h.down = false;
    h.ax = 0;
    h.ay = 0;
    // Losing a player rescales the swarm on the NEXT floor (queue is per-floor).
    this.checkWipe();
    if (this.phase === 'cleared') this.clearT = 99; // don't hang on a ghost seat
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}
