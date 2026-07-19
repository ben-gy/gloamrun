/**
 * main.ts — bootstrap and screen wiring. Owns no game logic.
 *
 * Shape: menu -> (solo | room entry -> lobby) -> countdown -> run (floors +
 * drafts) -> results -> (rematch inside the same room | back to lobby | menu).
 *
 * The rule that governs this file: ONE ROOM PER SESSION. The Net is created once
 * on entering a room and lives until you leave for the menu. "Play again" never
 * touches it — rematch.ts versions runs inside the living room.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';

import { Game, type Seat } from './game';
import { MODE_LIST, MAX_PLAYERS, modeOf, DEFAULT_MODE, type Mode } from './modes';
import { createSession, type Session, type SessionSeat } from './net-game';
import { createRenderer } from './render';
import { createFx } from './fx';
import { createSfx } from './sound';
import { startCountdown, type Countdown } from './countdown';
import { draftFor } from './upgrades';
import {
  summarize,
  tallyRun,
  emptyTally,
  renderSummary,
  shareText,
  type MatchTally,
} from './results';
import { createInput, type Input } from '@ben-gy/game-engine/input';
import { createStore } from '@ben-gy/game-engine/storage';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds } from '@ben-gy/game-engine/rematch';
import { resolveName, withName } from '@ben-gy/game-engine/identity';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import {
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  clearRoomInUrl,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { newSeed } from '@ben-gy/game-engine/rng';

hardenViewport();

const SLUG = 'gloamrun';

/**
 * TURN, fetched once at boot and installed BEFORE any mesh exists on the page.
 *
 * Trystero pre-builds a single global pool of peer connections from the config
 * of whichever joinRoom fires first, so a mesh created before this lands is
 * STUN-only for its initiating half — for good, and invisibly, since the other
 * half still works. A phone on carrier CGNAT then sits in the right room code
 * seeing nobody. The fetch is session-cached and fails open to [] after 3s, so
 * awaiting it can delay a join but can never block one.
 */
const turnReady: Promise<void> = getTurnConfig().then(setTurnConfig);

const store = createStore(SLUG);
const app = document.querySelector<HTMLDivElement>('#app')!;

const DELVER_NAMES = ['Ash', 'Wren', 'Kesh', 'Bramble', 'Nix', 'Fen', 'Rook', 'Vale'];

const sfx = createSfx(store.get('muted', false));
let myName = resolveName(store, () => DELVER_NAMES[0]);

let net: Net | null = null;
let rounds: Rounds | null = null;
let session: Session | null = null;
let game: Game | null = null;
let countdown: Countdown | null = null;
let tally: MatchTally = emptyTally();
let mySeat = 0;
let runSeed = 0;
let roomCode = '';
let mode: Mode = modeOf(store.get('mode', DEFAULT_MODE.id));
let deepLinkUsed = false;

const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

const FOOTER = `<footer class="site-footer">
  Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
  · <a class="hub-link" href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
</footer>`;

function shell(inner: string): void {
  app.innerHTML = `<div class="main-content">${inner}</div>${FOOTER}`;
  const hub = app.querySelector<HTMLAnchorElement>('.hub-link');
  if (hub) hub.href = withName('https://hub.benrichardson.dev', myName);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardownRoom();
  clearRoomInUrl();

  shell(`
    <div class="menu">
      <h1 class="title">Gloamrun</h1>
      <p class="tagline">Descend the gloam together. Fight deeper, revive each other,<br/>see how far the dark lets you go.</p>

      <div class="modes" role="radiogroup" aria-label="Mode">
        ${MODE_LIST.map(
          (m) => `<button class="mode${m.id === mode.id ? ' on' : ''}" role="radio"
            aria-checked="${m.id === mode.id}" data-mode="${m.id}">
            <b>${m.name}</b><span>${esc(m.blurb)}</span></button>`,
        ).join('')}
      </div>

      <div class="menu-actions">
        <button class="btn primary" id="play">Play</button>
        <button class="btn" id="friends">Play with friends</button>
      </div>

      <label class="namebox">Your name
        <input id="name" maxlength="12" value="${esc(myName)}" autocomplete="off" spellcheck="false" />
      </label>

      <div class="menu-links">
        <button class="btn ghost" id="how">How to play</button>
        <button class="btn ghost" id="about">About</button>
        <button class="btn ghost" id="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      </div>
      <p class="best">${bestLine()}</p>
    </div>`);

  for (const b of app.querySelectorAll<HTMLElement>('.mode')) {
    b.addEventListener('click', () => {
      mode = modeOf(b.dataset.mode);
      store.set('mode', mode.id);
      sfx.unlock();
      sfx.play('select');
      showMenu();
    });
  }

  app.querySelector('#play')!.addEventListener('click', () => {
    sfx.unlock();
    startSolo();
  });
  app.querySelector('#friends')!.addEventListener('click', () => {
    sfx.unlock();
    showRoomEntry();
  });
  app.querySelector('#how')!.addEventListener('click', () => showHelp());
  app.querySelector('#about')!.addEventListener('click', showAbout);
  app.querySelector('#mute')!.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    sfx.unlock();
    sfx.play('select');
    showMenu();
  });

  const name = app.querySelector<HTMLInputElement>('#name')!;
  name.addEventListener('change', () => {
    myName = name.value.trim().slice(0, 12) || DELVER_NAMES[0];
    store.set('name', myName);
    name.value = myName;
  });

  if (!store.get('seen-help', false)) showHelp();
}

function bestLine(): string {
  const best = store.get<number>(`best:${mode.id}`, 0);
  return best > 0 ? `Deepest ${mode.name} run: floor ${best}` : '';
}

// ── help / about ────────────────────────────────────────────────────────────

function modal(title: string, body: string): void {
  const m = el(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-card">
      <h2>${esc(title)}</h2>
      ${body}
      <button class="btn primary modal-x">Got it</button>
    </div>
  </div>`);
  document.body.appendChild(m);
  const close = (): void => m.remove();
  m.querySelector('.modal-x')!.addEventListener('click', close);
  m.addEventListener('click', (e) => {
    if (e.target === m) close();
  });
}

function showHelp(): void {
  store.set('seen-help', true);
  modal(
    'How to play',
    `<ul class="how">
      <li><b>Move to fight.</b> You fire at the nearest monster automatically — your job is to keep moving and not get cornered.</li>
      <li><b>Dash</b> (Space / the ⚡ button) for a quick dodge with a moment of invulnerability. Short cooldown — time it.</li>
      <li><b>Clear the floor</b>, step on the glowing stair, pick an upgrade, go deeper. Every floor is harder.</li>
      <li><b>Co-op:</b> stand over a downed friend to revive them. The run ends only when everyone still standing goes down at once.</li>
    </ul>
    <p class="how-ctl"><b>Move:</b> WASD / arrows, or the on-screen pad. <b>Dash:</b> Space or ⚡.</p>`,
  );
}

function showAbout(): void {
  modal(
    'About Gloamrun',
    `<p>An endless co-op dungeon crawl. Descend floor by floor against an ever-worsening swarm — how deep can you get?</p>
     <p>Play solo, or share a room code with up to ${MAX_PLAYERS} friends and delve together.</p>
     <p class="fine">Multiplayer is <b>peer-to-peer</b>: your browsers talk directly over WebRTC and there is no game server. A free public signaling relay only brokers the first handshake — after that nothing about your run touches anyone's server, and nothing is stored.</p>
     <p class="fine">No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.</p>
     <p class="fine">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>`,
  );
}

// ── room entry + lobby ──────────────────────────────────────────────────────

function showRoomEntry(): void {
  teardownRoom();
  shell('<div class="screen" id="entry"></div>');
  createRoomEntry({
    container: app.querySelector<HTMLElement>('#entry')!,
    onSubmit: (code, created) => void enterRoom(normalizeRoomCode(code), created),
    onCancel: showMenu,
    subtitle: `Start a room and share the code, or type a friend's. Up to ${MAX_PLAYERS} delvers.`,
  });
}

/** Bumped on every room entry/teardown, so a slow TURN fetch cannot resurrect a
 *  room the player already backed out of. */
let roomToken = 0;

async function enterRoom(code: string, created: boolean): Promise<void> {
  teardownRoom(); // bumps roomToken, invalidating any join still awaiting TURN
  const token = roomToken;
  roomCode = code;
  setRoomInUrl(code);

  // The mesh must not exist until TURN is installed, so hold the screen rather
  // than joining turnless. Normally instant — the credential is session-cached.
  shell('<div class="screen connecting"><span class="spinner"></span> Opening the gate…</div>');
  await turnReady;
  if (token !== roomToken) return;

  net = createNet(
    { appId: roomAppId(SLUG), roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        session?.setHost(isSelfHost);
        if (session && isSelfHost) flashHud("The host left — you're leading now");
      },
      onPeerLeave: (id) => session?.onPeerLeave(id),
    },
  );

  rounds = createRounds({
    net,
    playerName: myName,
    minPlayers: 2,
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => {
      const opts = info.opts as { mode?: unknown } | undefined;
      startRun(info.seed, modeOf(opts?.mode), info.players, info.isHost);
    },
  });

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  shell('<div class="screen" id="lobby"></div>');
  const box = app.querySelector<HTMLElement>('#lobby')!;
  const lobby = createLobby({
    container: box,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    onCancel: showMenu,
  });

  const strip = el('<div class="lobby-mode"></div>');
  box.appendChild(strip);
  const paint = (): void => {
    if (!rounds || !net) return;
    const s = rounds.state();
    const hostOpts = s.hostOpts as { mode?: unknown } | null;
    const shown = modeOf(hostOpts?.mode);
    strip.innerHTML = net.isHost()
      ? `<span class="lm-label">Your dungeon (everyone delves this)</span>
         <div class="lm-modes">${MODE_LIST.map(
           (m) => `<button class="lm${m.id === mode.id ? ' on' : ''}" data-mode="${m.id}">${m.name}</button>`,
         ).join('')}</div>
         <span class="lm-blurb">${esc(mode.blurb)}</span>`
      : hostOpts
        ? `<span class="lm-label">The host picked</span>
           <div class="lm-modes"><button class="lm on" disabled>${shown.name}</button></div>
           <span class="lm-blurb">${esc(shown.blurb)}</span>`
        : `<span class="lm-label"><span class="spinner sm"></span> Waiting for the host's dungeon…</span>`;
    for (const b of strip.querySelectorAll<HTMLElement>('.lm[data-mode]')) {
      b.addEventListener('click', () => {
        mode = modeOf(b.dataset.mode);
        store.set('mode', mode.id);
        sfx.play('select');
        paint();
      });
    }
  };
  paint();
  const poll = setInterval(paint, 700);

  cleanupLobby = () => {
    clearInterval(poll);
    lobby.destroy();
  };
}

let cleanupLobby: (() => void) | null = null;

// ── the run ─────────────────────────────────────────────────────────────────

function startSolo(): void {
  teardownRoom();
  const seed = newSeed();
  startRun(seed, mode, [{ id: 'solo', name: myName }], true);
}

function startRun(
  seed: number,
  m: Mode,
  players: { id: string; name: string }[],
  isHost: boolean,
): void {
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();

  runSeed = seed;
  const seats: Seat[] = players.map((p) => ({ name: p.name, bot: false }));
  const sseats: SessionSeat[] = players.map((p) => ({ id: p.id, bot: false }));

  const me = net ? players.findIndex((p) => p.id === net!.selfId) : 0;
  mySeat = me >= 0 ? me : 0;
  game = new Game({ seed, mode: m, seats });
  const g = game;

  session = createSession({
    game: g,
    me: mySeat,
    seats: sseats,
    net: net ?? undefined,
    host: isHost,
    seed,
    onEnd: () => showResults(),
    onHostChange: (h) => {
      if (h) flashHud("You're leading now");
    },
  });

  showGame(g, mySeat, m);
}

function showGame(g: Game, me: number, m: Mode): void {
  shell(`
    <div class="play">
      <canvas id="cv" class="drag-surface"></canvas>
      <div class="hud">
        <div class="hud-l">
          <div class="floor" id="floor">Floor 1</div>
          <div class="mode-tag">${esc(m.name)}</div>
        </div>
        <div class="hud-r">
          <button class="icon" id="pause" aria-label="Pause">II</button>
        </div>
      </div>
      <div class="stair-prompt" id="stairp" hidden></div>
      <div class="flash" id="flash" role="status" aria-live="polite"></div>
      <div class="big" id="big" hidden></div>
      <div class="draft" id="draft" hidden></div>
      <div class="overlay" id="pausebox" hidden>
        <div class="modal-card">
          <h2>Paused</h2>
          <button class="btn primary" id="resume">Resume</button>
          <button class="btn" id="restart">Restart</button>
          <button class="btn ghost" id="quit">Menu</button>
        </div>
      </div>
    </div>`);

  const canvas = app.querySelector<HTMLCanvasElement>('#cv')!;
  const renderer = createRenderer(canvas);
  const fx = createFx();
  const input: Input = createInput({
    target: canvas,
    keys: {
      KeyW: 'up', ArrowUp: 'up',
      KeyS: 'down', ArrowDown: 'down',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
      Space: 'dash',
      KeyP: 'pause', Escape: 'pause',
      KeyM: 'mute',
    },
    buttons: [{ action: 'dash', label: '⚡' }],
  });

  const floorEl = app.querySelector<HTMLElement>('#floor')!;
  const bigEl = app.querySelector<HTMLElement>('#big')!;
  const stairEl = app.querySelector<HTMLElement>('#stairp')!;
  const draftEl = app.querySelector<HTMLElement>('#draft')!;
  const pauseBox = app.querySelector<HTMLElement>('#pausebox')!;
  let paused = false;
  let running = false;
  let lastPhase = g.phase;
  let lastFloor = g.floor;
  let draftShown = false;

  app.querySelector('#pause')!.addEventListener('click', () => setPaused(true));
  app.querySelector('#resume')!.addEventListener('click', () => setPaused(false));
  app.querySelector('#restart')!.addEventListener('click', () => {
    if (net) {
      setPaused(false);
      return; // a shared run is not one player's to restart
    }
    cleanupGame?.();
    startSolo();
  });
  app.querySelector('#quit')!.addEventListener('click', () => {
    cleanupGame?.();
    showMenu();
  });

  function setPaused(p: boolean): void {
    paused = p && !net; // in a room the world does not stop for you
    pauseBox.hidden = !p;
  }

  const resize = (): void => {
    const r = canvas.parentElement!.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    renderer.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement!);
  resize();

  // 3-2-1-GO before the first floor. The audio carries it.
  bigEl.hidden = false;
  countdown = startCountdown({
    onBeat: (n) => {
      bigEl.textContent = n > 0 ? String(n) : 'DELVE';
      bigEl.className = 'big pop';
      void bigEl.offsetWidth;
      bigEl.className = 'big pop go';
      sfx.play(n > 0 ? 'beat' : 'go');
    },
    onDone: () => {
      running = true;
      bigEl.hidden = true;
    },
  });

  function renderDraft(): void {
    const opts = draftFor(runSeed, g.floor, me);
    const chosen = g.picks.get(me);
    const present = g.heroes.filter((h) => !h.left);
    const picked = present.filter((h) => g.picks.has(h.i)).length;
    draftEl.innerHTML = `
      <div class="draft-card">
        <h2>Floor ${g.floor} cleared</h2>
        <p class="draft-sub">${chosen ? 'Waiting for the party…' : 'Choose an upgrade'}</p>
        <div class="draft-opts">
          ${opts
            .map(
              (u) => `<button class="up${chosen === u.id ? ' picked' : ''}" data-up="${u.id}" ${chosen ? 'disabled' : ''}>
                <b>${esc(u.name)}</b><span>${esc(u.desc)}</span></button>`,
            )
            .join('')}
        </div>
        ${present.length > 1 ? `<p class="draft-wait">${picked}/${present.length} delvers ready…</p>` : ''}
      </div>`;
    for (const b of draftEl.querySelectorAll<HTMLElement>('.up[data-up]')) {
      b.addEventListener('click', () => {
        if (g.picks.has(me)) return;
        sfx.play('pick');
        session?.choose(b.dataset.up!);
        renderDraft();
      });
    }
  }

  function syncOverlays(): void {
    // Floor banner + descend feedback.
    if (g.floor !== lastFloor) {
      lastFloor = g.floor;
      floorEl.textContent = `Floor ${g.floor}`;
      floorEl.classList.remove('bump');
      void floorEl.offsetWidth;
      floorEl.classList.add('bump');
    }

    if (g.phase !== lastPhase) {
      if (g.phase === 'cleared') sfx.play('clear');
      if (g.phase === 'draft' && lastPhase !== 'draft') sfx.play('clear');
      if (lastPhase === 'draft' && g.phase === 'fighting') sfx.play('descend');
      lastPhase = g.phase;
    }

    // Stair prompt (cleared, before draft).
    if (g.phase === 'cleared') {
      const present = g.heroes.filter((h) => !h.left);
      const onStair = present.filter((h) => Math.hypot(h.x, h.y) <= 34).length;
      stairEl.hidden = false;
      stairEl.textContent =
        present.length > 1
          ? `Get everyone to the stair — ${onStair}/${present.length}`
          : 'Step on the stair to descend';
    } else {
      stairEl.hidden = true;
    }

    // Draft overlay.
    if (g.phase === 'draft') {
      if (!draftShown) {
        draftShown = true;
        draftEl.hidden = false;
        renderDraft();
      } else {
        renderDraft();
      }
    } else if (draftShown) {
      draftShown = false;
      draftEl.hidden = true;
    }
  }

  // Keepalive pump off setInterval so a backgrounded host still advances the run
  // (rAF pauses when the tab is hidden). The run's end is state, not a clock, so
  // this cannot spin forever.
  const keep = setInterval(() => {
    if (running && !paused) session?.pump(performance.now());
    syncOverlays();
  }, 200);

  let lastFrame = performance.now();
  let rafId = 0;
  const frame = (): void => {
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (running && !paused && fx.stopped() <= 0) {
      // Feed input to the sim.
      if (g.phase !== 'draft' && g.phase !== 'over') {
        const wantDash = input.state.down.has('dash') || input.state.pressed.has('dash');
        session?.intent(input.state.axis.x, input.state.axis.y, wantDash);
      }
      session?.pump(now);
    }

    if (input.state.pressed.has('pause')) setPaused(pauseBox.hidden ? true : false);
    if (input.state.pressed.has('mute')) {
      sfx.setMuted(!sfx.muted());
      store.set('muted', sfx.muted());
    }

    fx.step(dt);
    drainEvents(g, me, fx);
    syncOverlays();
    renderer.draw(g, me, fx, paused ? 0 : dt);
    input.endFrame();
  };
  rafId = requestAnimationFrame(frame);

  cleanupGame = () => {
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(keep);
    input.destroy();
    ro.disconnect();
    countdown?.cancel();
    countdown = null;
  };
}

let cleanupGame: (() => void) | null = null;

function drainEvents(g: Game, me: number, fx: ReturnType<typeof createFx>): void {
  for (const e of g.events) {
    switch (e.k) {
      case 'fire':
        if (e.i === me) sfx.play('shot');
        break;
      case 'mhit':
        fx.burst(e.x, e.y, 2, '#fff', 60, 2);
        sfx.play('mhit');
        break;
      case 'kill':
        fx.burst(e.x, e.y, e.boss ? 40 : e.elite ? 18 : 10, e.boss ? '#e64980' : '#cc5de8', e.boss ? 260 : 150, e.boss ? 5 : 3);
        fx.ring(e.x, e.y, '#cc5de8', e.boss ? 60 : 22);
        if (e.boss) {
          fx.shake(16);
          fx.stop(0.08);
          sfx.play('boss');
        } else {
          if (e.i === me) fx.stop(0.02);
          sfx.play('kill');
        }
        break;
      case 'hurt':
        if (e.i === me) {
          fx.shake(6);
          sfx.play('hurt');
        }
        fx.burst(e.x, e.y, 6, '#ff6b6b', 120, 3);
        break;
      case 'down':
        fx.shake(12);
        fx.stop(0.06);
        fx.ring(e.x, e.y, '#ff6b6b', 40);
        sfx.play('down');
        if (e.i === me) flashHud('You are down! A teammate can revive you.');
        else flashHud(`${esc(g.heroes[e.i]?.name ?? 'A delver')} is down!`);
        break;
      case 'revive':
        fx.burst(e.x, e.y, 14, '#69db7c', 140, 3);
        fx.ring(e.x, e.y, '#69db7c', 40);
        sfx.play('revive');
        break;
      case 'spawn':
        if (e.boss) {
          fx.shake(10);
          sfx.play('boss');
          flashHud('A boss stirs in the dark…');
        }
        break;
      case 'clear':
        fx.ring(0, 0, '#f0b429', 60);
        break;
      case 'descend':
        fx.ring(0, 0, '#f0b429', 80);
        break;
    }
  }
  g.events.length = 0;
}

function flashHud(msg: string): void {
  const f = document.querySelector<HTMLElement>('#flash');
  if (!f) return;
  f.textContent = msg;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 2200);
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(): void {
  const g = game;
  cleanupGame?.();
  cleanupGame = null;
  if (!g) return showMenu();

  sfx.play('over');
  const best = store.get<number>(`best:${g.mode.id}`, 0);
  const s = summarize(g, mySeat, best);
  if (s.isBest) {
    store.set(`best:${g.mode.id}`, s.floor);
    sfx.play('win');
  }
  const prevTally = tally;
  tally = tallyRun(tally, s);

  shell(`
    <div class="results">
      <h2 class="rs-title">Run over</h2>
      <div id="rsbody">${renderSummary(s, g.mode.name, prevTally)}</div>
      <div class="rs-wait" id="rswait" hidden></div>
      <div class="rs-actions">
        <button class="btn primary" id="again">Play again</button>
        <button class="btn" id="share">Share</button>
        ${net ? '<button class="btn ghost" id="tolobby">Back to lobby</button>' : ''}
        <button class="btn ghost" id="menu">Menu</button>
      </div>
    </div>`);

  app.querySelector('#share')!.addEventListener('click', () => void share(shareText(s, g.mode.name)));
  app.querySelector('#menu')!.addEventListener('click', showMenu);
  app.querySelector('#tolobby')?.addEventListener('click', () => {
    rounds?.finish();
    showLobby();
  });

  const again = app.querySelector<HTMLElement>('#again')!;
  const wait = app.querySelector<HTMLElement>('#rswait')!;

  if (!net) {
    again.addEventListener('click', () => startSolo());
    return;
  }

  rounds?.finish();
  again.addEventListener('click', () => {
    rounds?.vote();
    again.setAttribute('disabled', '');
    again.textContent = 'Waiting…';
    paintWait();
  });

  function paintWait(): void {
    if (!rounds || !net) return;
    const st = rounds.state();
    if (st.phase === 'playing') return;
    const votes = st.votes.map((v) => esc(v.name)).join(', ');
    const missing = st.present.length - st.votes.length;
    wait.hidden = st.votes.length === 0;
    wait.innerHTML = `
      <span class="spinner sm" aria-hidden="true"></span>
      <span>${votes || 'Nobody'} ready${missing > 0 ? ` · waiting on ${missing}` : ''}${
        st.startsInMs != null
          ? ` · starting in ${Math.ceil(st.startsInMs / 1000)}s`
          : st.votes.length >= 2
            ? ''
            : ' · need 2 to delve'
      }</span>
      ${st.isHost && st.canStart ? '<button class="btn sm" id="force">Start now</button>' : ''}`;
    wait.querySelector('#force')?.addEventListener('click', () => rounds?.go());
  }
  const poll = setInterval(paintWait, 400);
  cleanupGame = () => clearInterval(poll);
  paintWait();
}

async function share(text: string): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Gloamrun', text });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(text);
    flashHud('Copied!');
  } catch {
    flashHud('Copy failed — select and copy manually');
  }
}

// ── teardown ────────────────────────────────────────────────────────────────

function teardownRoom(): void {
  roomToken++;
  cleanupGame?.();
  cleanupGame = null;
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  rounds?.destroy();
  rounds = null;
  if (net) {
    void net.leave();
    net = null;
  }
  game = null;
  tally = emptyTally();
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

// ── boot ────────────────────────────────────────────────────────────────────

const url = new URL(location.href);
const deep = url.searchParams.get('room');
if (deep && !deepLinkUsed) {
  deepLinkUsed = true;
  const code = normalizeRoomCode(deep);
  if (code.length >= 3) void enterRoom(code, false);
  else showMenu();
} else {
  showMenu();
}
