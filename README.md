# Gloamrun

**Descend the gloam together — a co-op dungeon crawler you can play instantly, solo or with friends over a peer-to-peer link.**

🎮 Play: https://gloamrun.benrichardson.dev

## What it is
Gloamrun is an endless co-op dungeon crawl. You drop into floor 1 of a
procedurally generated dungeon and go as deep as you can. Each floor is one room:
a swarm of monsters pours in, you clear them, a stair-glyph opens at the centre,
you step on it and descend. Between floors you **draft** one of three upgrades.
Every floor the monsters get more numerous, tougher and faster, with a boss every
five. The dungeon is the opponent and it always wins in the end — the only
question is how deep you got.

You **auto-fire** at the nearest monster, so the whole game is in your feet:
position, kite, dodge. **Dash** (with a moment of invulnerability) is your only
escape. Take too many hits and you go **down** — and in co-op a teammate can
stand over you to revive you. The run ends only when the last standing delver
falls, so one player's mistake is a scramble for the others, not the end.

It's fun solo in the first five seconds, and better with friends: 2–4 of you drop
into the *same* dungeon, revive each other, and see how far the dark lets you go.

## How to play
- **Move to fight.** You fire at the nearest monster automatically — your job is
  to keep moving and not get cornered.
- **Desktop:** WASD / arrows to move, **Space** to dash, P/Esc to pause.
- **Mobile:** an on-screen D-pad to move and a big **⚡** dash button.
- **Clear the floor**, step on the glowing stair, pick an upgrade, go deeper.
- **Co-op:** stand over a downed friend to revive them.

## Multiplayer
Live **peer-to-peer** co-op for 2–4 players — no server. One player creates a
room and shares the 4-character code (or the invite link); friends type the code
to join. Your browsers connect directly over WebRTC; a free public signaling
relay only brokers the initial handshake, after which nothing about your run
touches anyone's server and nothing is stored.

The dungeon is host-authoritative: one peer runs the monster simulation and
broadcasts a compact snapshot, everyone else sends their input and renders it. If
the host leaves, a surviving peer is promoted automatically and the run keeps
going — it never freezes. The whole session lives in one room: "Play again" starts
a fresh run inside it, never a reconnect.

The difficulty curve is the real opponent, so it's tuned with a simulation rather
than by eye: a few hundred AI-party runs assert the curve is a smooth ramp
(nobody wipes on floor 1, a great four-player party still eventually falls, every
run terminates). See `tests/balance.test.ts`.

## Tech
- Vite 6 + vanilla TypeScript
- Canvas 2D rendering, procedural audio, particles + screen shake
- Shared engine: fixed-timestep loop, unified input, seedable RNG, Trystero P2P
  netcode with automatic host transfer
- Vitest for logic, P2P-sync determinism, host-election, host-transfer, rematch,
  room-code and a difficulty-curve balance sim
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
npm run icons   # regenerate the PWA icons from the game's mark
```

## License
MIT
