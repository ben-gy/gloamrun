/**
 * bot.ts — an AI hero good enough to referee the difficulty curve.
 *
 * This is the "player" the balance sim runs a few hundred times per party size
 * (tests/balance.test.ts). It is not meant to be a perfect player — it is meant
 * to be a CONSISTENT one, so that when P(reach floor N) moves, it moved because
 * the dungeon changed, not because the bot got luckier. Every draw is seeded.
 *
 * The behaviour: keep moving, kite the nearest threat, dash out of a corner,
 * and cross the room to stand over a downed teammate when it is safe-ish. It is
 * also what fills a seat if a game ever wants an AI ally, so it lives in src/.
 */

import { Game, type Hero, type Monster } from './game';
import { UPGRADES, type Upgrade } from './upgrades';
import type { Rng } from '@ben-gy/game-engine/rng';

export interface Intent {
  ax: number;
  ay: number;
  dash: boolean;
}

const DANGER = 96;
const DASH_TRIGGER = 46;

export function botIntent(g: Game, i: number, rng: Rng): Intent {
  const h = g.heroes[i];
  if (!h || h.left || h.down) return { ax: 0, ay: 0, dash: false };

  // During the walk to the stair, head for the centre.
  if (g.phase === 'cleared') {
    const d = Math.hypot(h.x, h.y);
    if (d < 6) return { ax: 0, ay: 0, dash: false };
    return { ax: -h.x / d, ay: -h.y / d, dash: false };
  }

  let ax = 0;
  let ay = 0;
  let dash = false;

  const threat = nearest(g.monsters, h.x, h.y);
  if (threat) {
    const dx = h.x - threat.x;
    const dy = h.y - threat.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < DANGER) {
      // Flee, but perpendicular-ish so we circle rather than back into a wall.
      const away = { x: dx / d, y: dy / d };
      const strafe = { x: -away.y, y: away.x };
      const s = rng() < 0.5 ? 1 : -1;
      ax = away.x * 0.7 + strafe.x * s * 0.7;
      ay = away.y * 0.7 + strafe.y * s * 0.7;
      if (d < DASH_TRIGGER && h.dashCd <= 0) dash = true;
    } else {
      // Reposition toward the centre so we don't get pinned on an edge.
      const cd = Math.hypot(h.x, h.y) || 1;
      ax = (-h.x / cd) * 0.5 + (rng() - 0.5);
      ay = (-h.y / cd) * 0.5 + (rng() - 0.5);
    }
  } else {
    ax = rng() - 0.5;
    ay = rng() - 0.5;
  }

  // Bias toward reviving a downed teammate when the coast is not too hot.
  const downed = g.heroes.find(
    (o) => !o.left && o.down && o.i !== i && Math.hypot(o.x - h.x, o.y - h.y) < 260,
  );
  if (downed && (!threat || Math.hypot(h.x - threat.x, h.y - threat.y) > DANGER)) {
    const dx = downed.x - h.x;
    const dy = downed.y - h.y;
    const d = Math.hypot(dx, dy) || 1;
    ax = dx / d;
    ay = dy / d;
  }

  // Keep away from walls.
  if (Math.abs(h.x) > g.hw - 40) ax -= Math.sign(h.x) * 0.8;
  if (Math.abs(h.y) > g.hh - 40) ay -= Math.sign(h.y) * 0.8;

  const len = Math.hypot(ax, ay) || 1;
  return { ax: ax / len, ay: ay / len, dash };
}

function nearest(ms: Monster[], x: number, y: number): Monster | null {
  let best: Monster | null = null;
  let bd = Infinity;
  for (const m of ms) {
    const d = (m.x - x) ** 2 + (m.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

/** A bot's draft choice: value survival early, damage once it can take a hit. */
export function botPick(h: Hero, floor: number, options: Upgrade[], rng: Rng): Upgrade {
  void UPGRADES;
  const score = (u: Upgrade): number => {
    const base: Record<string, number> = {
      hp: h.stats.maxHp <= 5 ? 3 : 1.5,
      dmg: 2.4,
      rate: 2.2,
      multishot: 2.6,
      dash: 1.6,
      speed: 1.4,
      pierce: 1.5,
      projspeed: 1,
      crit: 1.6,
      lifesteal: floor > 4 ? 2 : 1,
    };
    return (base[u.id] ?? 1) * (0.8 + rng() * 0.4);
  };
  return options.slice().sort((a, b) => score(b) - score(a))[0] ?? options[0];
}
