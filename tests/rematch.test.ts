/**
 * rematch.test.ts — the multi-round protocol, driven with N simulated peers.
 *
 * What this covers and what it deliberately does not:
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, the host's mode travelling frozen, host handover mid-results.
 *    This is our logic and a fake bus exercises it honestly.
 *
 *  - NOT COVERED: the transport bug that started all this. A fake bus sits ABOVE
 *    Trystero's room cache, so it structurally cannot contain that defect and
 *    would happily go green while the real game was broken. Two other tests own
 *    that: trystero-rejoin.test.ts pins the Trystero behaviour itself, and
 *    net-lifecycle.test.ts asserts the "one join per session" invariant that
 *    makes the trap unreachable — no network model required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import { MODES } from '../src/modes';

/** A shared in-memory bus. Delivery is synchronous — we are testing protocol
 *  decisions, not timing. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** Roster watchers, per peer — the fan-out behind Net.onPeersChange. */
  rosterCbs = new Map<PeerId, Set<(peers: PeerId[]) => void>>();

  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.announceRoster();
  }

  part(id: PeerId): void {
    this.peers.delete(id);
    this.rosterCbs.delete(id);
    this.announceRoster();
  }

  /** Tell every remaining peer the roster moved. rematch.ts uses this both to
   *  re-arm its settle window and to unicast a live round to a late arrival. */
  announceRoster(): void {
    const roster = this.roster();
    for (const [id, cbs] of this.rosterCbs) {
      if (!this.peers.has(id)) continue;
      for (const cb of [...cbs]) cb(roster);
    }
  }

  watchRoster(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    if (!this.rosterCbs.has(id)) this.rosterCbs.set(id, new Set());
    this.rosterCbs.get(id)!.add(cb);
    return () => this.rosterCbs.get(id)?.delete(cb);
  }

  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }

  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }

  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    // Same election rule as the real net.ts: lexicographically smallest id.
    host: () => bus.roster()[0] ?? null,
    isHost: () => bus.roster()[0] === selfId,
    // These peers are all wired to each other from the first tick; net.ts's
    // settling window is its own business and host-election.test.ts owns it.
    hostSettled: () => true,
    // One steady term. Epoch conflicts are net.ts's problem, not the round
    // protocol's — rematch.ts only ever reads it for the debug HUD.
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    onPeersChange: (cb) => bus.watchRoster(selfId, cb),
    takeover: () => {
      /* a bus peer cannot be un-elected; host() is a pure function of the roster */
    },
    netDiag: () => ({
      selfId,
      host: bus.roster()[0] ?? null,
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

/** Morsel's round opts are `{ mode: <mode id> }`. RoundInfo.opts is generic and
 *  unknown by design, so unwrap it here rather than in every assertion. */
const modeOf = (i: RoundInfo): string | undefined => (i.opts as { mode?: string } | undefined)?.mode;

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

function table(
  ids: PeerId[],
  opts: { minPlayers?: number; modes?: Record<string, string> } = {},
): Seat[] {
  const bus = new Bus();
  return ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      // Each peer reports the mode ITS OWN menu is set to. Only the host's may
      // ever reach the dish — that is the whole point of roundOpts.
      roundOpts: opts.modes ? () => ({ mode: opts.modes![id] }) : undefined,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

/**
 * Drive the clock past the roster-settle window and the poll tick that follows.
 *
 * Engine v1.1.0 no longer starts a round the instant the last vote lands. The
 * host waits for the roster to hold still for ROSTER_SETTLE_MS (4s), re-checked
 * by a 1.5s poll, because freezing a roster out of a half-formed mesh is exactly
 * what "ejected everyone when the round started" was: peers whose data channels
 * opened a beat late were not in the frozen list, and Trystero only delivers to
 * channels that are already open, so they never even heard the start.
 *
 * So auto-start is now asynchronous by design. Call this after the votes.
 */
const settle = (): void => {
  vi.advanceTimersByTime(6000);
};

let seats: Seat[];
beforeEach(() => {
  seats = [];
  // Every case now needs a controllable clock, not just the countdown ones —
  // the settle window above is on the critical path of every auto-start.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRounds — starting a round', () => {
  it('starts once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Auto-start fires off the votes alone; nobody had to press Start.
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so player indices match on every peer', () => {
    // Morsel seats blobs on a ring in roster order and seat i is a pure rotation
    // of seat 0 — two peers disagreeing about who is seat 0 is two peers driving
    // each other's blob.
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());
    settle();

    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // even given all the time in the world, two of three is not quorum
    expect(seats.every((s) => s.got.length === 0)).toBe(true);

    seats[2].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('fills a full 4-player table with one seed and one roster', () => {
    seats = table(['a', 'b', 'c', 'd'], { minPlayers: 4 });
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats.map((s) => s.got.length)).toEqual([1, 1, 1, 1]);
    const seeds = new Set(seats.map((s) => s.got[0].seed));
    expect(seeds.size).toBe(1);
    for (const s of seats) expect(s.got[0].players.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
  });

  it('lets the host start early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(0); // c has not voted — no auto-start

    // go() is a deliberate human decision, so it bypasses the settle window:
    // the host looking at the lobby IS the confirmation the roster is real.
    seats[0].rounds.go(); // host forces it
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    // 'b' is not the host; forge a start and make sure nobody honours it.
    seats[1].net.channel('rs', () => {})({
      round: 1,
      seed: 42,
      roster: [{ id: 'b', name: 'B' }],
    } as never);
    settle();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe("createRounds — the host's mode travels frozen", () => {
  it("gives every peer the HOST's mode, not the one their own menu is set to", () => {
    // The guest is sitting on Gauntlet. It must play the host's Delve, because a
    // mode decides the ROOM SIZE and the swarm cap: if the guest believed its own
    // menu it would lay a tight 0.82-scale room off the same seed as the host's
    // roomy one and cap the swarm differently — two peers in different dungeons.
    seats = table(['a', 'b'], { modes: { a: 'delve', b: 'gauntlet' } });
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats[0].net.isHost()).toBe(true);
    for (const s of seats) expect(modeOf(s.got[0])).toBe('delve');
    // …and it resolves to a real mode on both sides, not a fallback.
    for (const s of seats) expect(MODES[modeOf(s.got[0])!].roomScale).toBe(1);
  });

  it('follows the mode when the HOST is the one on Gauntlet', () => {
    seats = table(['a', 'b'], { modes: { a: 'gauntlet', b: 'delve' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) expect(modeOf(s.got[0])).toBe('gauntlet');
    expect(MODES.gauntlet.maxAlive).toBe(7); // the difference that matters
  });

  it('carries the mode into every rematch, not just the first round', () => {
    seats = table(['a', 'b'], { modes: { a: 'onslaught', b: 'gauntlet' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    for (const s of seats) expect(modeOf(s.got[1])).toBe('onslaught');
  });

  it('re-reads the host mode each round, so a change takes effect', () => {
    const bus = new Bus();
    let hostMode = 'onslaught';
    const net = mockNet(bus, 'a');
    const guest = mockNet(bus, 'b');
    const got: RoundInfo[] = [];
    const host = createRounds({
      net,
      playerName: 'A',
      roundOpts: () => ({ mode: hostMode }),
      onRound: (i) => got.push(i),
    });
    const other = createRounds({ net: guest, playerName: 'B', onRound: () => {} });

    host.vote();
    other.vote();
    settle();
    expect(modeOf(got[0])).toBe('onslaught');

    host.finish();
    other.finish();
    hostMode = 'gauntlet'; // the host changed its mind at the results screen
    host.vote();
    other.vote();
    settle();
    expect(modeOf(got[1])).toBe('gauntlet');
  });

  it("gossips the host's mode into every peer's state, before any round starts", () => {
    // A lobby must be able to render what it is about to play. Showing the
    // guest's OWN menu selection as if it were the host's is a confident lie.
    seats = table(['a', 'b'], { modes: { a: 'gauntlet', b: 'delve' } });
    for (const s of seats) expect(s.rounds.state().hostOpts).toEqual({ mode: 'gauntlet' });
  });

  it('hands back an undefined opts when a game does not use them', () => {
    // rematch.ts is engine code shared across games; a game with no settings
    // must not have to know that roundOpts exists.
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].got[0].opts).toBeUndefined();
    expect(seats[1].got[0].opts).toBeUndefined();
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Both players hit "Play again" — the exact sequence the user reported.
    seats.forEach((s) => s.rounds.vote());
    settle();

    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    // The symptom was TWO hosts. There must be exactly one, every round.
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    // …and a fresh dish, not a replay of round 1.
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it('lets a peer that LEFT and rejoined mid-match ready up again', () => {
    // The soft-deadlock found in Morsel's live two-tab smoke test. Sequence: the
    // host leaves, the guest is promoted, and then the peer who left reopens the
    // link to rejoin. The rejoiner's rounds instance is brand new — round 0 —
    // while the incumbent is already a round or two in. Before the fix, the
    // rejoiner's votes were "for" a round the room had finished, silently
    // dropped, and it could never reach quorum however many times it readied up.
    //
    // Rebuilt on the shared bus: 'a' and 'b' play round 1 together; then 'b'
    // leaves and a FRESH 'b' (new createRounds, round 0) rejoins. 'a' stays host
    // (a < b) at round 1. The rejoiner must catch up to the host's timeline and
    // a rematch must start.
    const bus = new Bus();
    const mk = (id: PeerId) => {
      const net = mockNet(bus, id);
      const seat: Seat = { id, net, rounds: null as never, got: [] };
      seat.rounds = createRounds({
        net,
        playerName: id.toUpperCase(),
        minPlayers: 2,
        onRound: (info) => seat.got.push(info),
      });
      return seat;
    };

    const a = mk('a');
    let b = mk('b');
    a.rounds.vote();
    b.rounds.vote();
    settle();
    expect(a.got[0].round).toBe(1); // round 1 played by both

    // 'b' closes the tab: detach its receivers and drop it from the room.
    b.rounds.destroy();
    void b.net.leave();

    a.rounds.finish(); // 'a' (host) returns to its results screen, reopens voting

    // A brand-new 'b' rejoins from scratch — round 0.
    b = mk('b');

    // Both hit Play again. Without the catch-up this hangs: 'b' votes for round 1,
    // 'a' expects round 2, the votes never meet.
    a.rounds.vote();
    b.rounds.vote();
    settle(); // the rejoin itself moved the roster, so the window restarted here

    expect(b.got.length, 'the rejoiner reached a new round').toBe(1);
    expect(a.got.length).toBe(2);
    expect(a.got[1].round).toBe(2);
    expect(b.got[0].round).toBe(2);
    expect(a.got[1].seed).toBe(b.got[0].seed);
    expect([a, b].filter((s) => s.got[s.got.length - 1].isHost)).toHaveLength(1);
  });

  it("keeps both peers in each other's roster across the rematch", () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // "Neither can see each other" — assert the opposite, directly.
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    const seed = seats[0].got[0].seed;

    // Replay round 1's start — e.g. a duplicate delivery, or both peers pressing
    // at the same instant. The monotonic guard must swallow it.
    seats[0].net.channel('rs', () => {})({
      round: 1,
      seed: 999,
      roster: [{ id: 'a', name: 'A' }],
    } as never);
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote()); // round 1 playing; no finish()
    settle();
    seats.forEach((s) => s.rounds.vote()); // premature "play again"
    settle();
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1); // still waiting on c

    seats[2].net.leave(); // c closes the tab
    seats[0].rounds.vote(); // any nudge re-tallies
    settle(); // c leaving moved the roster, so the quiet window restarted

    // A departed peer must be dropped, not held for — and must not land in the
    // frozen roster as a seat nobody is driving.
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    expect(seats[0].net.isHost()).toBe(true);

    seats[0].net.leave(); // the host walks away between rounds
    expect(seats[1].net.isHost()).toBe(true); // b is promoted by min-id election

    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle();

    // The promoted host must be able to run the rematch — inheriting no tally
    // from the old host is the classic way this deadlocks.
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
    expect(seats[2].got[1].isHost).toBe(false);
    expect(seats[1].got[1].seed).toBe(seats[2].got[1].seed);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    // Two of three hit "Play again". The third is still reading the scores —
    // which is the whole point of them, and takes a while. The OLD rule demanded
    // unanimity forever, so this hung the room with no way out but the menu.
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle(); // quorum without unanimity — the grace countdown arms here
    expect(seats[0].got.length).toBe(1); // not yet — the countdown is running

    const s = seats[0].rounds.state();
    expect(s.startsInMs).not.toBeNull(); // and it is VISIBLE, not a silent hang
    expect(s.startsInMs!).toBeGreaterThan(0);

    vi.advanceTimersByTime(8100);

    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();

    // Unanimity must not be punished with the 8s straggler countdown on top of
    // the settle window.
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // No settle() — go() must be immediate even inside the quiet window, or the
    // host's own "Start now" button would appear to do nothing for 4 seconds.
    seats[0].rounds.go(); // host is not made to wait out the countdown

    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].rounds.state().startsInMs!).toBeGreaterThan(0);

    seats[1].rounds.unvote(); // changed their mind
    expect(seats[0].rounds.state().startsInMs).toBeNull();

    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1); // nothing started below quorum
  });

  it('a peer who readies up mid-countdown still lands in the roster', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[2].rounds.vote(); // the straggler taps just in time
    settle();

    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    settle();

    // A destroyed Rounds must not keep driving a screen that is gone.
    expect(seats[1].got.length).toBe(0);
  });
});
