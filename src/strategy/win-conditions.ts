import { BattleStateSnapshot, PokemonState, WinCondition, DamageMatchup } from '../types';
import { DamageCalculator } from '../calculator/damage';
import { InferenceEngine } from '../inference/engine';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SETUP_MOVES = new Set([
  'swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'quiverdance',
  'shellsmash', 'bulkup', 'irondefense', 'bellydrum', 'coil',
  'shiftgear', 'workup', 'agility', 'autotomize', 'tailglow',
]);

const PRIORITY_MOVES = new Set([
  'extremespeed', 'aquajet', 'bulletpunch', 'iceshard', 'machpunch',
  'quickattack', 'shadowsneak', 'suckerpunch', 'grassyglide', 'jetpunch',
  'fakeout', 'firstimpression', 'accelerock',
]);

/**
 * Evaluate win conditions for my team.
 * A win condition is a Pokemon that could realistically sweep or
 * clean the game if positioned correctly.
 */
export function evaluateWinConditions(
  state: BattleStateSnapshot,
  calc: DamageCalculator,
  inference: InferenceEngine
): WinCondition[] {
  const myAlive = state.mySide.pokemon.filter(p => !p.fainted);
  const oppAlive = state.opponentSide.pokemon.filter(p => !p.fainted);

  if (myAlive.length === 0 || oppAlive.length === 0) return [];

  const conditions: WinCondition[] = [];

  for (const pokemon of myAlive) {
    const hasSetup = pokemon.moves.some(m => SETUP_MOVES.has(toId(m)));
    const hasPriority = pokemon.moves.some(m => PRIORITY_MOVES.has(toId(m)));

    let speedAdvantageCount = 0;
    let canKOCount = 0;
    let threats: string[] = [];
    let coverageScore = 0;
    let defensiveScore = 0;

    const mySpeed = calc.getEffectiveSpeed(pokemon, state.field, state.myPlayer);

    for (const opp of oppAlive) {
      const oppSpeed = calc.getEffectiveSpeed(
        opp,
        state.field,
        state.myPlayer === 'p1' ? 'p2' : 'p1'
      );

      // Speed comparison
      if (mySpeed > oppSpeed) speedAdvantageCount++;

      // Check if we can KO with any move
      let canKO = false;
      for (const move of pokemon.moves) {
        try {
          const dmg = calc.calcDamage(pokemon, opp, move, state.field);
          if (dmg.isOHKO) { canKO = true; break; }
          if (dmg.is2HKO) { coverageScore += 0.3; }
        } catch { /* skip */ }
      }
      if (canKO) canKOCount++;

      // Check opponent threats against us
      const oppMoves = [...opp.knownMoves];
      const inferred = inference.getLikelyUnrevealed(opp.species, 0.4);
      for (const { move } of inferred) oppMoves.push(move);

      for (const moveId of oppMoves) {
        try {
          const dmg = calc.calcDamage(opp, pokemon, moveId, state.field);
          if (dmg.isOHKO) {
            threats.push(`${opp.name}: ${moveId}`);
          }
        } catch { /* skip */ }
      }

      // Defensive survivability
      const bestOppDmg = oppMoves.reduce((max, m) => {
        try {
          const d = calc.calcDamage(opp, pokemon, m, state.field);
          return Math.max(max, d.maxPercent);
        } catch { return max; }
      }, 0);
      if (bestOppDmg < 40) defensiveScore += 0.2;
    }

    const numOpp = Math.max(oppAlive.length, 1);
    const speedFactor = speedAdvantageCount / numOpp;
    const koFactor = canKOCount / numOpp;
    const setupFactor = hasSetup ? 0.15 : 0;
    const priorityFactor = hasPriority ? 0.10 : 0;
    const hpFactor = (pokemon.hpPercent / 100) * 0.15;
    const defFactor = Math.min(defensiveScore, 0.2);

    const score = Math.min(1.0,
      (speedFactor * 0.20) +
      (koFactor * 0.30) +
      (coverageScore / numOpp * 0.10) +
      setupFactor +
      priorityFactor +
      hpFactor +
      defFactor
    );

    conditions.push({
      pokemon: pokemon.name,
      score,
      requiresSetup: hasSetup && pokemon.boosts.atk <= 0 && pokemon.boosts.spa <= 0,
      threatsRemaining: threats.slice(0, 3),
    });
  }

  return conditions.sort((a, b) => b.score - a.score);
}
