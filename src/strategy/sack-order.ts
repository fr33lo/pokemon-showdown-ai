import {
  BattleStateSnapshot,
  PokemonState,
  SackOrderEntry,
  WinCondition,
  ThreatAssessment,
} from '../types';
import { DamageCalculator } from '../calculator/damage';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HAZARD_REMOVAL_MOVES = new Set([
  'rapidspin', 'defog', 'tidyup', 'courtchange', 'mortalspin',
]);

const SPEED_CONTROL_MOVES = new Set([
  'thunderwave', 'glaciate', 'icywind', 'stickyweb', 'tailwind',
  'trickroom', 'electroweb',
]);

/**
 * Calculate sack order: which Pokemon should be sacrificed first.
 * Lower preservationScore = better sacrifice candidate (sack first).
 * Higher preservationScore = must preserve.
 */
export function calculateSackOrder(
  state: BattleStateSnapshot,
  calc: DamageCalculator,
  winConditions: WinCondition[],
  threats: ThreatAssessment[]
): SackOrderEntry[] {
  const myAlive = state.mySide.pokemon.filter(p => !p.fainted);
  if (myAlive.length === 0) return [];

  const winCondMap = new Map<string, number>();
  for (const wc of winConditions) winCondMap.set(wc.pokemon, wc.score);

  const oppAlive = state.opponentSide.pokemon.filter(p => !p.fainted);
  const oppSide = state.myPlayer === 'p1' ? 'p2' as const : 'p1' as const;

  const entries: SackOrderEntry[] = [];

  for (const pokemon of myAlive) {
    const moveIds = pokemon.moves.map(toId);

    // 1. Win condition potential (0 - 0.35)
    const winScore = (winCondMap.get(pokemon.name) || 0) * 0.35;

    // 2. Defensive utility (0 - 0.20)
    let defensiveUtil = 0;
    if (pokemon.hpPercent > 50) defensiveUtil += 0.05;
    // Can take hits from top threats?
    for (const threat of threats.slice(0, 2)) {
      const oppMon = oppAlive.find(o => o.name === threat.pokemon);
      if (oppMon) {
        let bestOppDmg = 0;
        for (const move of oppMon.knownMoves) {
          try {
            const dmg = calc.calcDamage(oppMon, pokemon, move, state.field);
            bestOppDmg = Math.max(bestOppDmg, dmg.maxPercent);
          } catch { /* skip */ }
        }
        if (bestOppDmg < 50) defensiveUtil += 0.075;
      }
    }
    defensiveUtil = Math.min(0.20, defensiveUtil);

    // 3. Speed control value (0 - 0.15)
    const oppSpeed = oppAlive.length > 0
      ? calc.getEffectiveSpeed(oppAlive[0], state.field, oppSide) : 0;
    const mySpeed = calc.getEffectiveSpeed(pokemon, state.field, state.myPlayer);
    const speedControl = mySpeed > oppSpeed ? 0.10 : 0;
    const hasSpeedControl = moveIds.some(m => SPEED_CONTROL_MOVES.has(m)) ? 0.05 : 0;

    // 4. Hazard removal (0 - 0.15)
    const hasHazardRemoval = moveIds.some(m => HAZARD_REMOVAL_MOVES.has(m));
    const myHazardsUp = state.mySide.sideConditions.size > 0;
    const hazardValue = (hasHazardRemoval && myHazardsUp) ? 0.15 : hasHazardRemoval ? 0.05 : 0;

    // 5. Matchup usefulness (0 - 0.15)
    let matchupScore = 0;
    for (const opp of oppAlive) {
      let canHit = false;
      for (const move of pokemon.moves) {
        try {
          const dmg = calc.calcDamage(pokemon, opp, move, state.field);
          if (dmg.maxPercent > 30) { canHit = true; break; }
        } catch { /* skip */ }
      }
      if (canHit) matchupScore += 0.05;
    }
    matchupScore = Math.min(0.15, matchupScore);

    const preservationScore =
      winScore +
      defensiveUtil +
      speedControl + hasSpeedControl +
      hazardValue +
      matchupScore;

    entries.push({
      pokemon: pokemon.name,
      preservationScore: Math.min(1.0, preservationScore),
    });
  }

  // Sort by preservationScore ascending (best sack candidate first)
  entries.sort((a, b) => a.preservationScore - b.preservationScore);

  // Hard guard: the top win condition must NEVER be first in sack order
  // unless it is literally the last Pokemon alive
  if (winConditions.length > 0 && entries.length > 1) {
    const topWC = winConditions[0].pokemon;
    const wcIdx = entries.findIndex(e => e.pokemon === topWC);
    if (wcIdx === 0) {
      // Move win condition to at least second-to-last position
      const [wc] = entries.splice(wcIdx, 1);
      const insertAt = Math.max(entries.length - 1, 0);
      entries.splice(insertAt, 0, wc);
    }
  }

  return entries;
}
