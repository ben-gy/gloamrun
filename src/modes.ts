// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the three shapes a run of Gloamrun can take.
 *
 * A mode must change how the game PLAYS, not just a number. The spread here is
 * about ONE question: what is the room asking of you?
 *
 *  - Delve      the default. A roomy floor, a moderate swarm, a boss every five.
 *               You have space to kite, so it is a reading-the-room game.
 *  - Onslaught  a bigger floor with FAR more monsters alive at once and a faster
 *               ramp. There is no kiting your way out of a crowd this size — it is
 *               a crowd-control game, and the DASH is a lifeline, not a luxury.
 *  - Gauntlet   a small, tight floor with fewer but much tougher, faster, elite
 *               monsters. Nowhere to run and every monster is a real threat, so it
 *               is a precision game: one bad dodge and you are down.
 *
 * The numbers below (roomScale, waveBase/waveGrow, hpMul/spdMul, eliteBase, the
 * boss cadence) are the levers the balance sim (tests/balance.test.ts) referees.
 * The mode a room plays is the HOST's, frozen into the round start — see
 * rematch.ts — so two peers can never disagree about the floor they are on.
 */

export interface Mode {
  id: string;
  name: string;
  /** One line, player-facing. */
  blurb: string;
  /** Room half-extent in world units (a scale on the base 520x360 room). */
  roomScale: number;
  /** Monsters that spawn on floor 1. */
  waveBase: number;
  /** Extra monsters per floor. */
  waveGrow: number;
  /** Hardest number of monsters alive at once (the rest queue in). */
  maxAlive: number;
  /** Monster HP multiplier — compounds with the per-floor ramp. */
  hpMul: number;
  /** Monster speed multiplier. */
  spdMul: number;
  /** Chance a monster spawns as an elite on floor 1 (rises with depth). */
  eliteBase: number;
  /** A boss floor every N floors. */
  bossEvery: number;
}

export const MODES: Record<string, Mode> = {
  delve: {
    id: 'delve',
    name: 'Delve',
    blurb: 'Roomy floors · a steady swarm · boss every 5 — space to read the room.',
    roomScale: 1,
    waveBase: 6,
    waveGrow: 2,
    maxAlive: 10,
    hpMul: 1,
    spdMul: 1,
    eliteBase: 0.05,
    bossEvery: 5,
  },
  onslaught: {
    id: 'onslaught',
    name: 'Onslaught',
    blurb: 'Wide floors · huge crowds · fast ramp — dash or drown.',
    roomScale: 1.28,
    waveBase: 10,
    waveGrow: 4,
    maxAlive: 22,
    hpMul: 0.85,
    spdMul: 1.05,
    eliteBase: 0.04,
    bossEvery: 5,
  },
  gauntlet: {
    id: 'gauntlet',
    name: 'Gauntlet',
    blurb: 'Tight floors · few but brutal elites · nowhere to hide.',
    roomScale: 0.82,
    waveBase: 4,
    waveGrow: 1,
    maxAlive: 7,
    hpMul: 1.5,
    spdMul: 1.18,
    eliteBase: 0.18,
    bossEvery: 4,
  },
};

export const DEFAULT_MODE = MODES.delve;

export const MODE_LIST: Mode[] = [MODES.delve, MODES.onslaught, MODES.gauntlet];

/** Room cap. Co-op has no seat-fairness problem, so this is purely about mesh
 *  size — a full WebRTC mesh is N^2 connections, and 4 keeps a phone cool. */
export const MAX_PLAYERS = 4;

/**
 * Resolve a mode id that arrived off the wire or out of storage.
 *
 * `MODES[id] || DEFAULT` is a trap: 'constructor' and 'toString' are truthy
 * inherited properties, so an untrusted id can hand the generator an object with
 * no `roomScale`. Object.hasOwn is the guard, and an unknown id falls back rather
 * than reaching the sim as undefined.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return DEFAULT_MODE;
}
