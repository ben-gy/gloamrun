// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * sound.ts — procedural SFX via Web Audio. Zero asset files, offline-capable.
 *
 * Call sfx.unlock() from the first user gesture (browsers block audio until
 * then), then sfx.play('shot'). Extended from patterns/sound.ts with Gloamrun's
 * own palette of blips, hits and chimes.
 */

export type SfxName =
  | 'shot'
  | 'mhit'
  | 'kill'
  | 'crit'
  | 'hurt'
  | 'down'
  | 'revive'
  | 'clear'
  | 'descend'
  | 'boss'
  | 'pick'
  | 'select'
  | 'over'
  | 'win'
  | 'beat'
  | 'go';

interface Patch {
  type: OscillatorType;
  freq: [number, number];
  dur: number;
  gain?: number;
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  shot: { type: 'square', freq: [620, 460], dur: 0.05, gain: 0.1 },
  mhit: { type: 'triangle', freq: [420, 260], dur: 0.05, gain: 0.12 },
  kill: { type: 'sawtooth', freq: [280, 80], dur: 0.16, gain: 0.22, noise: true },
  crit: { type: 'square', freq: [720, 1200], dur: 0.12, gain: 0.2 },
  hurt: { type: 'sawtooth', freq: [220, 120], dur: 0.16, gain: 0.28, noise: true },
  down: { type: 'sawtooth', freq: [320, 70], dur: 0.5, gain: 0.32, noise: true },
  revive: { type: 'triangle', freq: [420, 900], dur: 0.4, gain: 0.26 },
  clear: { type: 'triangle', freq: [520, 1040], dur: 0.36, gain: 0.24 },
  descend: { type: 'sine', freq: [520, 160], dur: 0.5, gain: 0.28 },
  boss: { type: 'sawtooth', freq: [120, 60], dur: 0.7, gain: 0.36, noise: true },
  pick: { type: 'square', freq: [520, 1040], dur: 0.24, gain: 0.2 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.09, gain: 0.2 },
  over: { type: 'sawtooth', freq: [360, 90], dur: 0.7, gain: 0.32 },
  win: { type: 'triangle', freq: [520, 1320], dur: 0.6, gain: 0.28 },
  beat: { type: 'square', freq: [440, 440], dur: 0.12, gain: 0.2 },
  go: { type: 'triangle', freq: [660, 1320], dur: 0.3, gain: 0.26 },
};

export interface Sfx {
  unlock(): void;
  play(name: SfxName): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;
  /** Rate-limit a spammy sound (auto-fire) so it never becomes a buzz. */
  const lastAt: Partial<Record<SfxName, number>> = {};

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  const MIN_GAP: Partial<Record<SfxName, number>> = { shot: 60, mhit: 40, hurt: 120 };

  return {
    unlock() {
      ensure();
    },
    play(name) {
      if (muted) return;
      const gap = MIN_GAP[name];
      if (gap) {
        const now = performance.now();
        if (lastAt[name] && now - lastAt[name]! < gap) return;
        lastAt[name] = now;
      }
      const ac = ensure();
      if (!ac) return;
      const p = PATCHES[name];
      const t0 = ac.currentTime;
      const gm = ac.createGain();
      gm.gain.setValueAtTime(p.gain ?? 0.25, t0);
      gm.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
      gm.connect(ac.destination);

      const osc = ac.createOscillator();
      osc.type = p.type;
      osc.frequency.setValueAtTime(p.freq[0], t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1]), t0 + p.dur);
      osc.connect(gm);
      osc.start(t0);
      osc.stop(t0 + p.dur);

      if (p.noise) {
        const n = ac.createBufferSource();
        n.buffer = noiseBuffer(ac, p.dur);
        const ng = ac.createGain();
        ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.6, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        n.connect(ng);
        ng.connect(ac.destination);
        n.start(t0);
        n.stop(t0 + p.dur);
      }
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
