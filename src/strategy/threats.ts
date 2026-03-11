import { CONFIG } from '../config';
import { BattleStateSnapshot, PokemonState, ThreatAssessment } from '../types';
import { DamageCalculator } from '../calculator/damage';
import { InferenceEngine } from '../inference/engine';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SETUP_MOVES = new Set([
  'swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'quiverdance',
  'shellsmash', 'bulkup', 'bellydrum', 'coil', 'shiftgear',
]);

const PRIORITY_MOVES = new Set([
  'extremespeed', 'aquajet', 'bulletpunch', 'iceshard', 'machpunch',
  'quickattack', 'shadowsneak', 'suckerpunch', 'grassyglide', 'jetpunch',
]);

/**
 * Calculate threat scores for all opponent Pokemon.
 * Higher scores = more dangerous to our team.
 */
export function evaluateThreats(
  state: BattleStateSnapshot,
  calc: DamageCalculator,
  inference: InferenceEngine
): ThreatAssessment[] {
  const oppAlive = state.opponentSide.pokemon.filter(p => !p.fainted);
  const myAlive = state.mySide.pokemon.filter(p => !p.fainted);
  const weights = CONFIG.strategy.threatWeights;

  if (oppAlive.length === 0 || myAlive.length === 0) return [];

  const threats: ThreatAssessment[] = [];
  const oppSide = state.myPlayer === 'p1' ? 'p2' as const : 'p1' as const;

  for (const opp of oppAlive) {
    // Get all known + inferred moves
    const allMoves = new Set(opp.knownMoves);
    const inferred = inference.getLikelyUnrevealed(opp.species, 0.3);
    for (const { move } of inferred) allMoves.add(move);
    const moveList = [...allMoves];

    // 1. Speed Threat: how many of our Pokemon does it outspeed?
    const oppSpeed = calc.getEffectiveSpeed(opp, state.field, oppSide);
    let outspeeds = 0;
    for (const my of myAlive) {
      const mySpeed = calc.getEffectiveSpeed(my, state.field, state.myPlayer);
      if (oppSpeed > mySpeed) outspeeds++;
    }
    const speedThreat = outspeeds / Math.max(myAlive.length, 1);

    // 2. Damage Threat: how much damage can it deal across our team?
    let totalKOs = 0;
    let totalDmgPercent = 0;
    for (const my of myAlive) {
      let bestDmg = 0;
      for (const moveId of moveList) {
        try {
          const dmg = calc.calcDamage(opp, my, moveId, state.field);
          bestDmg = Math.max(bestDmg, dmg.maxPercent);
          if (dmg.isOHKO) totalKOs++;
        } catch { /* skip */ }
      }
      totalDmgPercent += bestDmg;
    }
    const avgDmg = totalDmgPercent / Math.max(myAlive.length, 1);
    const damageThreat = Math.min(1.0, (avgDmg / 100) * 0.7 + (totalKOs / Math.max(myAlive.length, 1)) * 0.3);

    // 3. Setup Potential: can it set up and sweep?
    const hasSetup = moveList.some(m => SETUP_MOVES.has(m));
    const hasPriority = moveList.some(m => PRIORITY_MOVES.has(m));
    const alreadyBoosted = opp.boosts.atk > 0 || opp.boosts.spa > 0 || opp.boosts.spe > 0;
    let setupPotential = 0;
    if (hasSetup) setupPotential += 0.5;
    if (alreadyBoosted) setupPotential += 0.4;
    if (hasPriority) setupPotential += 0.1;
    setupPotential = Math.min(1.0, setupPotential);

    // 4. Defensive Wall Value: does it wall our win conditions?
    let wallScore = 0;
    for (const my of myAlive) {
      let bestMyDmg = 0;
      for (const move of my.moves) {
        try {
          const dmg = calc.calcDamage(my, opp, move, state.field);
          bestMyDmg = Math.max(bestMyDmg, dmg.maxPercent);
        } catch { /* skip */ }
      }
      // If our Pokemon can't even 3HKO, it's a wall
      if (bestMyDmg < 34) wallScore += 0.3;
    }
    const defensiveWallValue = Math.min(1.0, wallScore);

    // In late game (≤3 Pokemon each), setup sweepers are more dangerous
    // because there are fewer checks remaining
    const lateGame = myAlive.length <= 3;
    const setupWeight = lateGame
      ? Math.min(weights.setupPotential + 0.10, 0.40)
      : weights.setupPotential;
    const dmgWeight = lateGame
      ? Math.max(weights.damageThreat - 0.05, 0.20)
      : weights.damageThreat;

    // Weighted total
    const score =
      (speedThreat * weights.speedThreat) +
      (damageThreat * dmgWeight) +
      (setupPotential * setupWeight) +
      (defensiveWallValue * weights.defensiveWallValue);

    threats.push({
      pokemon: opp.name,
      score: Math.min(1.0, score),
      speedThreat,
      damageThreat,
      setupPotential,
      defensiveWallValue,
    });
  }

  return threats.sort((a, b) => b.score - a.score);
}
