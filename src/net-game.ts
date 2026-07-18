/**
 * net-game.ts — one Session drives a run, solo or peer-to-peer.
 *
 * ONE path, deliberately. rhythm-relay shipped broken because its co-op shape got
 * bespoke netcode that never had host transfer wired in. So solo here is simply
 * "a Session whose net is undefined": the same code, unable to drift from the
 * multiplayer one.
 *
 * ── authority ────────────────────────────────────────────────────────────────
 *
 * Host-authoritative star. The HOST runs the entire world in `game.hostStep`:
 * monster spawns, AI, hero auto-fire, every collision, HP, downs, the floor
 * machine and the draft gate. It broadcasts a compact FULL snapshot at ~14Hz.
 *
 * A CLIENT sends only its INPUT (move dir + dash) on 'in' and its draft choice on
 * 'pick'. It renders the snapshot, predicting its OWN hero's motion locally so
 * moving feels instant, and easing everything else toward the snapshot. Because a
 * client's Game holds the whole world (fed from snapshots), a promoted peer does
 * not reconstruct anything — `setHost(true)` just starts it calling hostStep and
 * broadcasting. That is the takeover, and it is why it is one line.
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 *
 * There is no fixed round length — a run ends on a party WIPE — so the "clock"
 * is only cosmetic pacing. The end condition (`game.over`) is state, not time, so
 * a backgrounded host cannot hang the run: the keepalive interval in main.ts
 * pumps the sim off setInterval, not rAF alone.
 */

import { Game, HERO_R } from './game';
import { botIntent, botPick } from './bot';
import { draftFor, upgradeOf } from './upgrades';
import { makeRng, type Rng } from './engine/rng';
import type { Net, PeerId } from './engine/net';

const DASH_SPEED = 520;

/** Host -> all: the full world, small enough to send whole at 14Hz. */
interface Snap {
  f: number; // floor
  ph: number; // phase code
  t: number; // run clock
  si: number; // spawnIdx
  rc: number; // reached
  ov: number; // over? 1/0
  rs?: string; // over reason
  /** heroes flat: [x,y,hp,maxHp,flags] per seat. flags bit0=down bit1=left. */
  H: number[];
  /** monsters flat: [id,kind,elite,x,y,hp,maxHp] */
  M: number[];
  /** monster shots flat: [x,y,vx,vy,life] */
  S: number[];
  /** hero shots, positions only for rendering: [x,y,owner] */
  P: number[];
  /** picks this draft: seat|id pairs, so a lobby can show who has chosen. */
  pk?: [number, string][];
}

/** Client -> host: my input this tick. */
interface InMsg {
  ax: number;
  ay: number;
  d?: 1; // dash pressed
}

/** Client -> all: my draft choice. */
interface PickMsg {
  s: number; // seat
  u: string; // upgrade id
}

const PHASES = ['fighting', 'cleared', 'draft', 'over'] as const;
const KINDS = ['crawler', 'spitter', 'brute', 'boss'] as const;

export interface SessionSeat {
  id?: PeerId;
  bot: boolean;
}

export interface SessionCfg {
  game: Game;
  /** The local player's seat, or -1 for a pure spectator. */
  me: number;
  seats: SessionSeat[];
  /** Absent = solo. */
  net?: Net;
  /** True if this peer starts the round as host. Ignored when solo. */
  host?: boolean;
  seed: number;
  /** Fires once, on every peer, when the run is over. */
  onEnd: () => void;
  /** Promotion/demotion, so the UI can say "you're the host now". */
  onHostChange?: (isHost: boolean) => void;
}

export interface Session {
  pump(nowMs: number): void;
  intent(ax: number, ay: number, dash: boolean): void;
  /** Local player picks a draft card (id). */
  choose(id: string): void;
  setHost(isHost: boolean): void;
  onPeerLeave(id: PeerId): void;
  isHost(): boolean;
  destroy(): void;
}

const W_HZ = 14;
const IN_HZ = 20;
const STEP = 1 / 60;
const MAX_CATCHUP = 8;
const DRAFT_GRACE = 15000;

export function createSession(cfg: SessionCfg): Session {
  const { game: g, me, seats, net } = cfg;
  let host = net ? !!cfg.host : true;

  const brng: Rng = makeRng(cfg.seed ^ 0x2f9a1b);
  const seatOf = new Map<PeerId, number>();
  for (const [i, s] of seats.entries()) if (s.id) seatOf.set(s.id, i);

  let started = 0;
  let last = 0;
  let acc = 0;
  let wAcc = 0;
  let inAcc = 0;
  let ended = false;
  let draftGraceAt = 0;

  // Local player's input.
  let ax = 0;
  let ay = 0;
  let dashQ = false;
  /** Latest input per remote seat (host only). */
  const inputs = new Map<number, InMsg>();

  // ── wire ──────────────────────────────────────────────────────────────────

  const sendSnap = net?.channel<Snap>('snap', (msg, from) => {
    if (host || from !== net.host()) return;
    applySnap(msg);
  });

  const sendIn = net?.channel<InMsg>('in', (msg, from) => {
    const i = seatOf.get(from);
    if (i == null) return;
    inputs.set(i, msg);
  });

  const sendPick = net?.channel<PickMsg>('pick', (msg, from) => {
    const i = seatOf.get(from);
    if (i == null || i !== msg.s) return;
    applyPick(msg.s, msg.u);
  });

  function applyPick(seat: number, id: string): void {
    const up = upgradeOf(id);
    if (!up) return;
    g.pickUpgrade(seat, id, up.apply);
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  function buildSnap(): Snap {
    const H: number[] = [];
    for (const h of g.heroes) {
      const flags = (h.down ? 1 : 0) | (h.left ? 2 : 0);
      H.push(Math.round(h.x), Math.round(h.y), h.hp, h.stats.maxHp, flags);
    }
    const M: number[] = [];
    for (const m of g.monsters) {
      M.push(m.id, KINDS.indexOf(m.kind), m.elite ? 1 : 0, Math.round(m.x), Math.round(m.y), Math.round(m.hp), m.maxHp);
    }
    const S: number[] = [];
    for (const s of g.mshots) S.push(Math.round(s.x), Math.round(s.y), Math.round(s.vx), Math.round(s.vy), Math.round(s.life * 100) / 100);
    const P: number[] = [];
    for (const s of g.shots) P.push(Math.round(s.x), Math.round(s.y), s.owner);
    const snap: Snap = {
      f: g.floor,
      ph: PHASES.indexOf(g.phase),
      t: Math.round(g.t * 10) / 10,
      si: g.spawnIdx,
      rc: g.reached,
      ov: g.over ? 1 : 0,
      H,
      M,
      S,
      P,
    };
    if (g.over) snap.rs = g.overReason;
    if (g.phase === 'draft') snap.pk = [...g.picks.entries()];
    return snap;
  }

  function applySnap(s: Snap): void {
    g.syncFloor(s.f, s.si);
    g.phase = PHASES[s.ph] ?? 'fighting';
    g.t = s.t;
    g.reached = Math.max(g.reached, s.rc);
    g.over = s.ov === 1;
    if (s.rs) g.overReason = s.rs;

    // Heroes. Own hero: keep predicted position (reconcile), take hp/down.
    for (let i = 0; i < g.heroes.length; i++) {
      const h = g.heroes[i];
      const b = i * 5;
      if (b + 4 >= s.H.length) continue;
      const sx = s.H[b];
      const sy = s.H[b + 1];
      h.hp = s.H[b + 2];
      h.stats.maxHp = s.H[b + 3];
      const flags = s.H[b + 4];
      h.down = (flags & 1) === 1;
      h.left = (flags & 2) === 2;
      if (i === me && !h.down) {
        // Reconcile our own prediction toward the host softly; snap if far.
        const err = Math.hypot(h.x - sx, h.y - sy);
        if (err > 70) {
          h.x = sx;
          h.y = sy;
        } else {
          h.x += (sx - h.x) * 0.25;
          h.y += (sy - h.y) * 0.25;
        }
      } else {
        h.x = sx;
        h.y = sy;
      }
    }

    // Monsters — update by id so render smoothing (rx,ry) survives.
    const byId = new Map(g.monsters.map((m) => [m.id, m]));
    const next: typeof g.monsters = [];
    for (let k = 0; k + 6 < s.M.length; k += 7) {
      const id = s.M[k];
      const existing = byId.get(id);
      const kind = KINDS[s.M[k + 1]] ?? 'crawler';
      const x = s.M[k + 3];
      const y = s.M[k + 4];
      if (existing) {
        existing.x = x;
        existing.y = y;
        existing.hp = s.M[k + 5];
        existing.elite = s.M[k + 2] === 1;
        next.push(existing);
      } else {
        next.push({
          id,
          kind,
          elite: s.M[k + 2] === 1,
          x, y, vx: 0, vy: 0, rx: x, ry: y,
          hp: s.M[k + 5],
          maxHp: s.M[k + 6],
          r: kind === 'boss' ? 34 : kind === 'brute' ? 18 : kind === 'crawler' ? 12 : 11,
          speed: 0,
          touch: 0,
          fireCd: 0,
          hitCd: 0,
        });
      }
    }
    g.monsters = next;

    // Monster shots — rebuilt each snap (short-lived, cheap). Kept with vx/vy so
    // the renderer can advance them smoothly between the 14Hz snapshots.
    g.mshots = [];
    for (let k = 0; k + 4 < s.S.length; k += 5) {
      g.mshots.push({
        id: k,
        x: s.S[k], y: s.S[k + 1], vx: s.S[k + 2], vy: s.S[k + 3], dmg: 0, life: s.S[k + 4],
        rx: s.S[k], ry: s.S[k + 1],
      });
    }

    // Hero shots — positions only, purely for rendering (host owns the real ones).
    g.shots = [];
    for (let k = 0; k + 2 < s.P.length; k += 3) {
      g.shots.push({
        id: k,
        x: s.P[k], y: s.P[k + 1], vx: 0, vy: 0, dmg: 0, life: 1, pierce: 0,
        owner: s.P[k + 2], hit: new Set(),
      });
    }

    if (s.pk) {
      g.picks.clear();
      for (const [seat, id] of s.pk) g.picks.set(seat, id);
    }
  }

  // ── draft resolution (host) ───────────────────────────────────────────────

  function resolveDraft(): void {
    if (g.phase !== 'draft') {
      draftGraceAt = 0;
      return;
    }
    // Bots draft instantly.
    for (const [i, s] of seats.entries()) {
      const h = g.heroes[i];
      if (!h || h.left) continue;
      if (s.bot && !g.picks.has(i)) {
        const opts = draftFor(cfg.seed, g.floor, i);
        const chosen = botPick(h, g.floor, opts, brng);
        g.pickUpgrade(i, chosen.id, chosen.apply);
      }
    }
    // The grace timer is a MULTIPLAYER escape hatch — it starts a floor without a
    // straggler who never taps. Solo, there is no straggler: wait for the player's
    // pick as long as they like, or they'd be shoved down the stairs mid-read and
    // silently lose the upgrade.
    const multi = g.livingSeats() > 1;
    if (multi && draftGraceAt === 0) draftGraceAt = g.t * 1000 + DRAFT_GRACE;
    if (g.allPicked() || (multi && g.t * 1000 >= draftGraceAt)) {
      draftGraceAt = 0;
      g.descend();
    }
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  function setIntents(): void {
    // Local player.
    if (me >= 0) g.setIntent(me, ax, ay, dashQ);
    dashQ = false;
    // Bots (host owns them) and remote humans (from their 'in').
    for (const [i, s] of seats.entries()) {
      if (i === me) continue;
      if (s.bot) {
        const it = botIntent(g, i, brng);
        g.setIntent(i, it.ax, it.ay, it.dash);
      } else {
        const inp = inputs.get(i);
        if (inp) g.setIntent(i, inp.ax, inp.ay, !!inp.d);
      }
    }
  }

  function predictOwn(dt: number): void {
    // Client-side prediction of the local hero's motion only — everything else
    // comes from the host. Movement, not damage: HP is authoritative.
    if (me < 0) return;
    if (g.phase === 'draft' || g.phase === 'over') return;
    const h = g.heroes[me];
    if (!h || h.left || h.down) return;
    const len = Math.hypot(ax, ay);
    if (len < 1e-4) return;
    const speed = h.dashT > 0 ? DASH_SPEED : h.stats.moveSpeed;
    h.x = clamp(h.x + (ax / Math.max(1, len)) * speed * dt, -g.hw + HERO_R, g.hw - HERO_R);
    h.y = clamp(h.y + (ay / Math.max(1, len)) * speed * dt, -g.hh + HERO_R, g.hh - HERO_R);
  }

  return {
    pump(nowMs) {
      if (ended) return;
      if (!started) {
        started = nowMs;
        last = nowMs;
        if (host) broadcast();
        return;
      }
      const dt = Math.min(0.25, (nowMs - last) / 1000);
      last = nowMs;

      if (host) {
        acc += dt;
        let steps = 0;
        while (acc >= STEP && steps < MAX_CATCHUP) {
          setIntents();
          g.hostStep(STEP);
          resolveDraft();
          acc -= STEP;
          steps++;
        }
        if (steps >= MAX_CATCHUP) acc = 0;

        wAcc += dt;
        if (net && wAcc >= 1 / W_HZ) {
          wAcc = 0;
          broadcast();
        }
      } else {
        predictOwn(dt);
        // Send input to the host.
        inAcc += dt;
        if (net && inAcc >= 1 / IN_HZ && me >= 0) {
          inAcc = 0;
          const msg: InMsg = { ax: Math.round(ax * 100) / 100, ay: Math.round(ay * 100) / 100 };
          if (dashQ) msg.d = 1;
          sendIn?.(msg);
          dashQ = false;
        }
      }

      if (g.over && !ended) {
        ended = true;
        cfg.onEnd();
      }
    },

    intent(nx, ny, d) {
      ax = nx;
      ay = ny;
      dashQ = dashQ || d;
    },

    choose(id) {
      if (me < 0) return;
      applyPick(me, id); // apply locally for our own prediction/HUD
      sendPick?.({ s: me, u: id });
    },

    setHost(isHost) {
      if (isHost === host) return;
      host = isHost;
      if (host) {
        // THE TAKEOVER. This peer already holds the full world from the last
        // snapshot. Adopt it as canonical and start driving + broadcasting; bots
        // and spawns resume on the next hostStep. syncFloor already rebuilt the
        // queue for the current floor from the shared seed.
        acc = 0;
        wAcc = 0;
        draftGraceAt = 0;
        inputs.clear();
        broadcast();
      }
      cfg.onHostChange?.(host);
    },

    onPeerLeave(id) {
      const i = seatOf.get(id);
      if (i == null) return;
      g.dissolve(i);
      inputs.delete(i);
    },

    isHost: () => host,

    destroy() {
      ended = true;
      (sendSnap as unknown as { off?: () => void })?.off?.();
      (sendIn as unknown as { off?: () => void })?.off?.();
      (sendPick as unknown as { off?: () => void })?.off?.();
    },
  };

  function broadcast(): void {
    if (!net || !host) return;
    sendSnap?.(buildSnap());
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
