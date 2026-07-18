/**
 * render.ts — draw the floor and everything on it to a 2D canvas.
 *
 * The whole room fits on screen (one room per floor), so there is no camera to
 * follow and no scrolling to desync — we just scale the fixed room to the
 * viewport and centre it. Remote entities carry a smoothing position (rx,ry)
 * eased toward their authoritative one so the 14Hz snapshot never stutters.
 */

import { Game, HERO_R, type Hero, type Monster } from './game';
import { createFx, heroColor, ICHOR, ELITE, BOSS } from './fx';

export interface Renderer {
  resize(w: number, h: number, dpr: number): void;
  draw(g: Game, me: number, fx: ReturnType<typeof createFx>, dt: number): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  let W = canvas.width;
  let H = canvas.height;
  let dpr = 1;

  function resize(w: number, h: number, ratio: number): void {
    if (w <= 0 || h <= 0) return; // ignore a transient 0-size measurement
    dpr = ratio;
    W = w;
    H = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  function draw(g: Game, me: number, fx: ReturnType<typeof createFx>, dt: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const margin = 26;
    const scale = Math.min((W - margin * 2) / (g.hw * 2), (H - margin * 2) / (g.hh * 2));
    const shake = fx.shakeVec();
    const cx = W / 2 + shake.x;
    const cy = H / 2 + shake.y;
    const sx = (wx: number): number => cx + wx * scale;
    const sy = (wy: number): number => cy + wy * scale;

    // ── floor + walls ─────────────────────────────────────────────────────────
    const left = sx(-g.hw);
    const top = sy(-g.hh);
    const rw = g.hw * 2 * scale;
    const rh = g.hh * 2 * scale;
    ctx.fillStyle = '#0e1626';
    ctx.fillRect(left, top, rw, rh);

    // Grid.
    ctx.strokeStyle = 'rgba(120,150,200,0.06)';
    ctx.lineWidth = 1;
    const step = 60 * scale;
    ctx.beginPath();
    for (let x = left; x <= left + rw; x += step) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + rh);
    }
    for (let y = top; y <= top + rh; y += step) {
      ctx.moveTo(left, y);
      ctx.lineTo(left + rw, y);
    }
    ctx.stroke();

    // Wall glow.
    ctx.strokeStyle = 'rgba(120,150,200,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, rw, rh);

    // ── stair glyph (when cleared) ──────────────────────────────────────────────
    if (g.phase === 'cleared') {
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 300);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = '#f0b429';
      ctx.fillStyle = 'rgba(240,180,41,0.14)';
      ctx.lineWidth = 3;
      const sr = 34 * scale;
      ctx.beginPath();
      ctx.arc(sx(0), sy(0), sr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f0b429';
      ctx.font = `${Math.round(18 * scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▼', sx(0), sy(0));
      ctx.restore();
    }

    // ── monster shots ───────────────────────────────────────────────────────────
    for (const s of g.mshots) {
      s.x += s.vx * dt; // cosmetic advance between snapshots (host owns the truth)
      s.y += s.vy * dt;
      ctx.fillStyle = '#ff922b';
      ctx.beginPath();
      ctx.arc(sx(s.x), sy(s.y), 5 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── monsters ────────────────────────────────────────────────────────────────
    for (const m of g.monsters) {
      m.rx += (m.x - m.rx) * Math.min(1, dt * 16);
      m.ry += (m.y - m.ry) * Math.min(1, dt * 16);
      drawMonster(ctx, m, sx(m.rx), sy(m.ry), scale);
    }

    // ── hero shots ────────────────────────────────────────────────────────────
    for (const s of g.shots) {
      ctx.fillStyle = heroColor(s.owner);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(sx(s.x), sy(s.y), 4 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── heroes ──────────────────────────────────────────────────────────────────
    for (const h of g.heroes) {
      if (h.left) continue;
      if (h.i === me) {
        h.rx = h.x;
        h.ry = h.y;
      } else {
        h.rx += (h.x - h.rx) * Math.min(1, dt * 16);
        h.ry += (h.y - h.ry) * Math.min(1, dt * 16);
      }
      drawHero(ctx, h, sx(h.rx), sy(h.ry), scale, h.i === me);
    }

    // ── particles / rings / text ─────────────────────────────────────────────────
    for (const p of fx.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(sx(p.x) - p.size / 2, sy(p.y) - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const r of fx.rings) {
      ctx.globalAlpha = Math.max(0, r.life / 0.4);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(r.x), sy(r.y), r.r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of fx.texts) {
      ctx.globalAlpha = Math.max(0, t.life / 0.9);
      ctx.fillStyle = t.color;
      ctx.font = `bold ${Math.round(15 * scale)}px system-ui, sans-serif`;
      ctx.fillText(t.text, sx(t.x), sy(t.y));
    }
    ctx.globalAlpha = 1;

    // ── vignette (tightens as party health drops) ─────────────────────────────
    const hp = g.partyHealth();
    const danger = 1 - hp;
    if (danger > 0.05) {
      const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(120,10,30,${0.5 * danger})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  return { resize, draw };
}

function drawMonster(ctx: CanvasRenderingContext2D, m: Monster, x: number, y: number, scale: number): void {
  const r = m.r * scale;
  const color = m.kind === 'boss' ? BOSS : m.elite ? ELITE : ICHOR;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = m.elite ? '#ffd43b' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = m.elite ? 2.5 : 1.5;
  ctx.beginPath();
  if (m.kind === 'crawler') {
    // diamond
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
  } else if (m.kind === 'brute') {
    // hexagon
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else {
    // spitter + boss: circle
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  if (m.kind === 'spitter' || m.kind === 'boss') {
    ctx.fillStyle = '#0b1220';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // HP bar for anything that takes more than a couple of hits.
  if (m.hp < m.maxHp && (m.kind === 'brute' || m.kind === 'boss' || m.elite)) {
    const w = r * 2;
    const frac = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - w / 2, y - r - 8, w, 4);
    ctx.fillStyle = m.kind === 'boss' ? BOSS : '#ff6b6b';
    ctx.fillRect(x - w / 2, y - r - 8, w * frac, 4);
  }
}

function drawHero(ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, scale: number, isSelf: boolean): void {
  const r = HERO_R * scale;
  const color = heroColor(h.i);
  ctx.save();
  ctx.translate(x, y);

  if (h.down) {
    // A downed hero: a dim ring with a revive progress arc.
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (h.reviveT > 0) {
      ctx.strokeStyle = '#69db7c';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, r + 4, -Math.PI / 2, -Math.PI / 2 + (h.reviveT / 2.5) * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#ff6b6b';
    ctx.font = `bold ${Math.round(14 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✚', 0, 0);
    ctx.restore();
    return;
  }

  // i-frame flash.
  if (h.invT > 0 && Math.floor(h.invT * 20) % 2 === 0) ctx.globalAlpha = 0.5;

  // Body.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  if (isSelf) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  // Facing barrel.
  const a = Math.atan2(h.aimy, h.aimx);
  ctx.strokeStyle = '#0b1220';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // HP pips.
  const max = Math.round(h.stats.maxHp);
  const pipW = Math.min(7, (r * 2.4) / max);
  const totalW = pipW * max + (max - 1) * 2;
  let px = x - totalW / 2;
  for (let i = 0; i < max; i++) {
    ctx.fillStyle = i < h.hp ? '#69db7c' : 'rgba(255,255,255,0.18)';
    ctx.fillRect(px, y - r - 10, pipW, 4);
    px += pipW + 2;
  }
}
