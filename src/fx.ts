/**
 * fx.ts — the theatre. Particles, rings, floating text, screen shake and
 * hit-stop. The sim stays pure; this turns its events into light and noise.
 *
 * Everything here degrades under `prefers-reduced-motion`: no shake, far fewer
 * particles, no hit-stop. The game stays fully playable, just calmer.
 */

const REDUCED =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Okabe-Ito, colour-blind-safe. Heroes cycle through these. */
const HERO_COLORS = ['#56b4e9', '#e69f00', '#009e73', '#d55e00'];
export function heroColor(i: number): string {
  return HERO_COLORS[i % HERO_COLORS.length];
}
/** Monster ichor — a warm magenta that reads against every hero colour. */
export const ICHOR = '#cc5de8';
export const ELITE = '#f783ac';
export const BOSS = '#e64980';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}
interface Ring {
  x: number;
  y: number;
  r: number;
  max: number;
  life: number;
  color: string;
}
interface FloatText {
  x: number;
  y: number;
  vy: number;
  life: number;
  text: string;
  color: string;
}

export interface Fx {
  burst(x: number, y: number, n: number, color: string, speed?: number, size?: number): void;
  ring(x: number, y: number, color: string, r?: number): void;
  text(x: number, y: number, text: string, color: string): void;
  shake(mag: number): void;
  stop(secs: number): void;
  step(dt: number): void;
  stopped(): number;
  readonly particles: Particle[];
  readonly rings: Ring[];
  readonly texts: FloatText[];
  shakeVec(): { x: number; y: number };
}

export function createFx(): Fx {
  const particles: Particle[] = [];
  const rings: Ring[] = [];
  const texts: FloatText[] = [];
  let shakeMag = 0;
  let hitStop = 0;
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  return {
    particles,
    rings,
    texts,
    burst(x, y, n, color, speed = 140, size = 3) {
      const count = REDUCED ? Math.ceil(n / 3) : n;
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2;
        const s = speed * (0.4 + rnd() * 0.8);
        const life = 0.3 + rnd() * 0.4;
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: size * (0.6 + rnd() * 0.8) });
      }
      if (particles.length > 500) particles.splice(0, particles.length - 500);
    },
    ring(x, y, color, r = 30) {
      rings.push({ x, y, r: 0, max: r, life: 0.4, color });
    },
    text(x, y, text, color) {
      if (REDUCED) return;
      texts.push({ x, y, vy: -40, life: 0.9, text, color });
    },
    shake(mag) {
      if (REDUCED) return;
      shakeMag = Math.min(24, Math.max(shakeMag, mag));
    },
    stop(secs) {
      if (REDUCED) return;
      hitStop = Math.max(hitStop, secs);
    },
    step(dt) {
      if (hitStop > 0) hitStop = Math.max(0, hitStop - dt);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.9;
        p.vy *= 0.9;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.life -= dt;
        r.r += (r.max - r.r) * Math.min(1, dt * 10);
        if (r.life <= 0) rings.splice(i, 1);
      }
      for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i];
        t.life -= dt;
        t.y += t.vy * dt;
        if (t.life <= 0) texts.splice(i, 1);
      }
      shakeMag *= Math.pow(0.001, dt);
      if (shakeMag < 0.2) shakeMag = 0;
    },
    stopped: () => hitStop,
    shakeVec() {
      if (shakeMag <= 0) return { x: 0, y: 0 };
      return { x: (rnd() * 2 - 1) * shakeMag, y: (rnd() * 2 - 1) * shakeMag };
    },
  };
}
