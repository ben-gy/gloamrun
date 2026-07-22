// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * results.ts — the end-of-run summary.
 *
 * Co-op inverts the "everyone's result" rule (principle #9): it leads with the
 * SHARED outcome — how deep the party got and what finally put them down — and
 * uses the per-player breakdown to show what each player CONTRIBUTED, never to
 * rank them. A co-op summary that quietly turns teammates into a leaderboard
 * rewards hogging; this one rewards reviving. So the party line is the headline,
 * and the per-player rows are unsorted and un-numbered.
 */

import { heroColor } from './fx';
import type { Game, Hero } from './game';

export interface MatchTally {
  runs: number;
  /** Deepest floor the party has ever reached across this match. */
  deepest: number;
}

export const emptyTally = (): MatchTally => ({ runs: 0, deepest: 0 });

export interface Row {
  i: number;
  name: string;
  isSelf: boolean;
  left: boolean;
  dmg: number;
  kills: number;
  revives: number;
  downs: number;
}

export interface Summary {
  floor: number;
  reason: string;
  best: number;
  isBest: boolean;
  rows: Row[];
  totalKills: number;
}

export function summarize(g: Game, me: number, prevBest: number): Summary {
  const rows: Row[] = g.heroes.map((h: Hero) => ({
    i: h.i,
    name: h.name,
    isSelf: h.i === me,
    left: h.left,
    dmg: Math.round(h.contrib.dmg),
    kills: h.contrib.kills,
    revives: h.contrib.revives,
    downs: h.contrib.downs,
  }));
  const floor = g.reached;
  return {
    floor,
    reason: g.overReason || 'the dark',
    best: Math.max(prevBest, floor),
    isBest: floor > prevBest,
    rows,
    totalKills: rows.reduce((a, r) => a + r.kills, 0),
  };
}

export function tallyRun(tally: MatchTally, s: Summary): MatchTally {
  return { runs: tally.runs + 1, deepest: Math.max(tally.deepest, s.floor) };
}

const ord = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

export function renderSummary(s: Summary, mode: string, tally: MatchTally): string {
  const solo = s.rows.filter((r) => !r.left).length <= 1;
  const head = `<p class="rs-head">The party fell on the <b>${ord(s.floor)} floor</b><span class="rs-reason"> — ${esc(s.reason)}</span></p>`;

  const bestLine = s.isBest
    ? `<p class="rs-best">🏆 New best — deepest ${esc(mode)} run yet!</p>`
    : `<p class="rs-note">Best ${esc(mode)}: floor ${s.best}</p>`;

  const matchLine =
    tally.runs > 0
      ? `<p class="rs-note">Match: ${tally.runs + 1} run${tally.runs ? 's' : ''} · deepest floor ${Math.max(tally.deepest, s.floor)}</p>`
      : '';

  // Every present player, unsorted — a contribution board, not a ranking.
  const rows = s.rows
    .filter((r) => !r.left)
    .map(
      (r) => `<li class="rs-row${r.isSelf ? ' is-self' : ''}">
        <span class="rs-dot" style="background:${heroColor(r.i)}"></span>
        <span class="rs-name">${esc(r.name)}${r.isSelf ? ' (you)' : ''}</span>
        <span class="rs-contrib">
          <span title="Damage dealt">${r.dmg.toLocaleString()} dmg</span>
          <span title="Monsters felled">${r.kills} slain</span>
          <span title="Teammates revived">${r.revives} revived</span>
          <span title="Times downed">${r.downs} downed</span>
        </span>
      </li>`,
    )
    .join('');

  const foot = `<p class="rs-foot">${s.totalKills} monsters felled ${solo ? '' : 'together '}before the dark won.</p>`;

  return `${head}${bestLine}${matchLine}
    <ul class="rs-rows">${rows}</ul>
    ${foot}`;
}

export function shareText(s: Summary, mode: string): string {
  const solo = s.rows.filter((r) => !r.left).length <= 1;
  const who = solo ? 'I' : 'We';
  return `Gloamrun — ${mode}\n${who} reached floor ${s.floor} and felled ${s.totalKills} monsters before ${esc(s.reason)} put us down.\nhttps://gloamrun.benrichardson.dev`;
}

function esc(str: string): string {
  return str.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
