/**
 * takeover.test.ts — CONTRACT GATE: the host leaving must not freeze the run.
 *
 * The automated half of the gate (the other half is closing the host tab in a
 * two-tab smoke test). It exists because rhythm-relay shipped with host transfer
 * impossible-by-construction — createNet was called with no onHostChange — and
 * every test was green.
 *
 * Gloamrun is a host-authoritative STAR: a client renders snapshots and does not
 * run the monster sim, so — unlike a predict-everything game — an orphaned client
 * that is NEVER promoted genuinely would not advance. That is fine, because
 * net.ts promotes EXACTLY ONE survivor the instant the host leaves (proven in
 * host-election.test.ts). This test proves the other half: that the promoted peer
 * takes over and the run keeps going and can still end.
 *
 * The design that makes it testable at all: createSession takes an optional net,
 * so the whole thing runs with no network, no relay, no browser. Promotion is
 * setHost(true) — exactly what net.ts's onHostChange calls.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSession, type SessionSeat } from '../src/net-game';
import { Game, type Seat } from '../src/game';
import { MODES } from '../src/modes';
import type { Net, PeerId } from '../src/engine/net';

function silentNet(selfId: PeerId, host: PeerId | null, sent?: Record<string, unknown[]>): Net {
  return {
    selfId,
    peers: () => [selfId],
    host: () => host,
    isHost: () => host === selfId,
    hostSettled: () => host !== null,
    count: () => 1,
    channel: <T>(name: string) => {
      const send = ((d: T) => {
        if (sent) (sent[name] ??= []).push(d);
      }) as ((d: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
      send.off = () => {};
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  };
}

const seats = (n: number): Seat[] => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: false }));
const sseats = (n: number): SessionSeat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, bot: false }));

function mk(isHost: boolean, party = 1) {
  const mode = MODES.delve;
  const g = new Game({ seed: 5, mode, seats: seats(party) });
  const onEnd = vi.fn();
  const onHostChange = vi.fn();
  const sent: Record<string, unknown[]> = {};
  const s = createSession({
    game: g,
    me: 0,
    seats: sseats(party),
    net: silentNet('p0', isHost ? 'p0' : 'other', sent),
    host: isHost,
    seed: 5,
    onEnd,
    onHostChange,
  });
  return { g, s, onEnd, onHostChange, sent, mode };
}

/** Drive `secs` of wall clock through the session, as rAF + the keepalive would. */
function pump(s: { pump: (n: number) => void }, from: number, secs: number, stepMs = 16): number {
  let t = from;
  const end = from + secs * 1000;
  while (t < end) {
    s.pump(t);
    t += stepMs;
  }
  s.pump(t);
  return t;
}

describe('before promotion, a client does not drive the world', () => {
  it('does not spawn monsters — that is the host’s job', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 4);
    expect(g.monsters).toHaveLength(0);
    expect(g.over).toBe(false);
  });

  it('never narrates the world', () => {
    const { s, sent } = mk(false);
    pump(s, 1000, 3);
    expect(sent.snap ?? [], 'a guest must not broadcast snapshots').toHaveLength(0);
  });
});

describe('after promotion, the survivor takes over and the run can finish', () => {
  it('setHost(true) makes it host', () => {
    const { s, onHostChange } = mk(false);
    expect(s.isHost()).toBe(false);
    s.setHost(true);
    expect(s.isHost()).toBe(true);
    expect(onHostChange).toHaveBeenCalledWith(true);
  });

  it('starts spawning the swarm the moment it is promoted', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 2);
    expect(g.monsters).toHaveLength(0); // was inert as a client
    s.setHost(true);
    pump(s, 1000 + 2000, 3);
    expect(g.monsters.length).toBeGreaterThan(0);
  });

  it('starts BROADCASTING the world — the duty that actually transfers', () => {
    // Verified by mutation: make setHost a no-op and this goes red.
    const { s, sent } = mk(false);
    pump(s, 1000, 3);
    expect(sent.snap ?? []).toHaveLength(0);
    s.setHost(true);
    pump(s, 4000, 2);
    expect((sent.snap ?? []).length, 'a promoted host must broadcast').toBeGreaterThan(0);
  });

  it('the run can still REACH game-over after the host vanishes', () => {
    // The point is that the board is NOT frozen after a takeover: it advances to
    // an ending. We disarm the hero (dmg 0) so it cannot out-DPS the swarm and is
    // reliably overwhelmed in a bounded time — realistic endings are the balance
    // sim's job; this test only needs to prove the promoted host drives to `over`.
    const { g, s, onEnd } = mk(false);
    g.heroes[0].stats.dmg = 0;
    pump(s, 1000, 3);
    expect(g.over).toBe(false);
    s.setHost(true);
    pump(s, 4000, 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('demotion is honoured too — two hosts must never both narrate', () => {
    const { s, onHostChange } = mk(true);
    expect(s.isHost()).toBe(true);
    s.setHost(false);
    expect(s.isHost()).toBe(false);
    expect(onHostChange).toHaveBeenCalledWith(false);
  });

  it('setHost is idempotent', () => {
    const { s, onHostChange } = mk(false);
    s.setHost(true);
    s.setHost(true);
    s.setHost(true);
    expect(onHostChange).toHaveBeenCalledTimes(1);
  });
});

describe('a peer leaving degrades, never freezes', () => {
  it('dissolves the leaver’s hero', () => {
    const { g, s } = mk(true, 2);
    s.onPeerLeave('p1');
    expect(g.heroes[1].left).toBe(true);
  });

  it('ignores a leave from someone who was never seated', () => {
    const { g, s } = mk(true, 2);
    const before = g.heroes.map((h) => h.left);
    s.onPeerLeave('a-stranger');
    expect(g.heroes.map((h) => h.left)).toEqual(before);
  });

  it('a two-player run continues after one leaves, and the survivor can finish', () => {
    const { g, s, onEnd } = mk(true, 2);
    g.heroes[0].stats.dmg = 0; // disarm so the lone survivor is reliably overwhelmed
    pump(s, 0, 2);
    s.onPeerLeave('p1'); // one delver drops
    expect(g.heroes[0].left).toBe(false);
    pump(s, 2000, 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('solo is the same code path', () => {
  it('runs with no net at all, spawns a swarm, and reaches an ending', () => {
    const mode = MODES.delve;
    const g = new Game({ seed: 9, mode, seats: seats(1) });
    const onEnd = vi.fn();
    const s = createSession({ game: g, me: 0, seats: sseats(1), seed: 9, onEnd });
    expect(s.isHost()).toBe(true); // solo is always its own authority
    pump(s, 0, 3);
    expect(g.monsters.length).toBeGreaterThan(0); // it was a real dungeon
    g.heroes[0].stats.dmg = 0; // disarm so the ending arrives in bounded time
    pump(s, 3000, 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('the local player can act — moving changes where the hero is', () => {
    const g = new Game({ seed: 9, mode: MODES.delve, seats: seats(1) });
    const s = createSession({ game: g, me: 0, seats: sseats(1), seed: 9, onEnd: vi.fn() });
    const at = { x: g.heroes[0].x, y: g.heroes[0].y };
    s.intent(1, 0, false);
    pump(s, 0, 1);
    expect(g.heroes[0].x).not.toBe(at.x);
  });
});
