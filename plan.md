# Game Plan: Gloamrun

## Overview
- **Name:** Gloamrun
- **Repo name:** gloamrun
- **Tagline:** Descend the gloam together — a co-op crawl where you fight deeper floor by floor, revive each other, and see how far the dark lets you go.
- **Genre (directory category):** arcade

## Core Loop
Top-down. You (and up to 3 friends) drop into floor 1 of an endless procedurally
generated dungeon. Each floor is one room: monsters pour in, you clear them all,
a stair-glyph opens at the centre, you step on it to descend. Between floors you
**draft** one of three upgrades. Every floor the monsters get more numerous,
tougher and faster. You **auto-fire** at the nearest monster, so the whole game
is in your feet — position, kite, dodge. **Dash** (i-frames) is your only escape.
Take too many hits and you go **down**; a teammate standing over you revives you.
When the last standing player falls, the run is over. The dungeon is the opponent
and it always wins eventually — the only question is how deep you got.

- **Win condition:** none — it's a depth score-attack. "Winning" is beating your
  best floor.
- **Lose condition:** party wipe (all living players down at once). Solo: you go
  down = run over.
- **Tension:** auto-fire means you can never stop moving; every floor is a fresh
  swarm you have to read; a downed teammate is a gamble between saving them and
  getting swarmed yourself.

## Controls
- **Desktop:** WASD / arrows to move. Auto-fire at the nearest monster (no aim
  button). Space / click = **Dash**. P / Esc = pause.
- **Mobile:** virtual D-pad (from `input.ts`) to move, a big **DASH** button.
  Auto-fire needs no aiming, which is exactly what makes it play on a thumb.

## Multiplayer
- **Mode:** live P2P (also fully solo, and there's no async mode — the draw is
  descending *together* in real time).
- **If live P2P — shape:** **co-op** (players vs the dungeon). Chosen over versus
  because the whole fantasy is *delving together*: two friends want to fight the
  dark side-by-side and revive each other, not knock each other out. Co-op also
  dodges the seat-balance problem entirely (no seat can open luckier — everyone
  faces the same swarm) and degrades gracefully (a peer dropping just makes the
  run harder, never breaks the match). Shared-world-non-hostile was rejected
  because the game needs a fail state to have stakes; versus was rejected because
  scoring-is-easy is not a design reason.
- **If co-op:**
  - **The opponent** is the difficulty curve: monster count, HP, speed and elite
    frequency all ramp with floor depth, with a boss every 5 floors. Tuned by a
    sim, not by eye (see `tests/balance.test.ts`).
  - **Shared fate:** the run ends only on a **party wipe** — all living players
    down simultaneously. An individual who goes down is *revivable*, not
    eliminated, so one player's mistake is a scramble for the others, not the end.
  - **What stops one player soloing it while the others watch:** the swarm scales
    with **living** party size, so a lone survivor faces a floor built for the
    whole party — you genuinely cannot carry four seats alone for long. Clearing
    a floor **revives everyone** to partial HP (floors are checkpoints), so the
    incentive is to survive *together* to the stairs, not to hog kills.
  - **Where the tension comes from with no PvP:** the swarm, the dwindling HP
    bars, and the revive gamble. Deciding whether to dash across a room full of
    spitters to pick up a downed friend *is* the game.
- **If live P2P:**
  - Players **1–4**; topology **host-authoritative star**. The host owns the
    monster simulation (spawns, AI, HP, monster projectiles), the floor/phase
    state, the shared clock and the draft gate; it broadcasts a compact full
    snapshot. Clients send their **input** (move dir + dash + which hero) and
    render/interpolate the snapshot, with light client-side prediction of their
    OWN hero's motion so dodging stays responsive.
  - **Channels (≤12 bytes):** `snap` (host→all world), `in` (client→host input),
    `pick` (client→all draft choice), plus rematch's `rv`/`rs`/`rq`.
  - **Late joiner:** a peer joining mid-run gets the next snapshot (full state)
    and slots into a spectator until the next floor, where it takes a seat. A
    peer dropping dissolves its hero and the swarm rescales down.
  - **Host leaves:** `net.ts` re-elects the min-id survivor and fires
    `onHostChange`; the promoted peer already holds the full world from the last
    snapshot, so its `Session.setHost(true)` adopts that state as canonical,
    re-anchors the floor clock, and resumes running the monster sim + broadcasting
    — the run keeps going and can still reach game-over.
- **End of round → rematch (live P2P):** "Play again" uses `patterns/rematch.ts`
  and **never touches the room** — same Net, same mesh, a new round number + seed
  + frozen roster. While waiting, a peer sees who has readied and a visible grace
  countdown; if one declines/closes the tab the round starts without them (grace
  timer, host can force-start); if the **host** leaves at results the promoted
  peer runs the rematch inheriting no tally. A running **match tally** persists
  across rounds (deepest floor the party reached each run). "Back to lobby" does
  not leave the room.

## Juice Plan
- Procedural SFX (`sound.ts` extended): shot, hit, monster-death, hurt, down,
  revive, floor-clear chime, descend whoosh, boss-roar, upgrade-pick, game-over.
- Screen shake on taking a hit and on boss death; hit-stop on a monster kill and
  a bigger one on going down.
- Particles: muzzle spark on fire, blood/ichor burst on monster death, a ring on
  descend, a heal shimmer on revive, dash after-image trail.
- Tweened HP bars, floating damage/combo pops, a pulsing stair-glyph, a screen
  vignette that tightens as the party's total HP drops.
- Palette: Okabe-Ito hero colours over a cold slate dungeon; monster ichor in a
  warm magenta so it reads against everything. Colour-blind-safe.

## Style Direction
**Vibe:** neon-in-the-dark dungeon (clean vector shapes, glow, no pixel art).
**Palette:** slate `#0b1220` floor, torch-amber accents, Okabe-Ito player colours
(sky/orange/green/vermillion), magenta monster ichor. Colour-blind-safe pairs.
**Theme:** dark (it's a dungeon).
**Reference feel:** the readable-at-a-glance swarm of a good twin-stick, the
instant-play of a Doodle game, the "one more floor" of a tight roguelite.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** Canvas 2D (continuous motion, many entities, particles).
- **Engine modules copied from patterns/:** loop, input, net, rematch, lobby,
  rng, sound, storage, identity, mobile.
- **Persistence:** localStorage — best floor per mode, mute, name, seen-help.

## Non-Goals
- No meta-progression / persistent unlocks between runs (a run is self-contained).
- No inventory or equipment screen — upgrades are a fast 1-of-3 draft.
- No procedural *narrative*; the dungeon is mechanical.
- No async/seed-share mode this pass.

## How To Play (player-facing copy)
- **Move to fight.** You fire at the nearest monster automatically — your job is
  to keep moving and not get cornered.
- **Dash** (Space / the DASH button) for a quick dodge with a moment of
  invulnerability. It's on a short cooldown — time it.
- **Clear the floor**, step on the glowing stair, pick an upgrade, go deeper.
- **Co-op:** stand over a downed friend to revive them. The run ends only when
  everyone still standing goes down at once. See how deep you get.
