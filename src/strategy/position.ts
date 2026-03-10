import { CONFIG } from '../config';
import { BattleStateSnapshot, PositionEvaluation, WinCondition } from '../types';
import { DamageCalculator } from '../calculator/damage';
import { BattleState } from '../battle/state';

/**
 * Evaluate the overall board position.
 * Returns a score from -1.0 (losing) to +1.0 (winning).
 */
export function evaluatePosition(
  state: BattleStateSnapshot,
  battleState: BattleState,
  calc: DamageCalculator,
  winConditions: WinCondition[]
): PositionEvaluation {
  const w = CONFIG.strategy.positionWeights;

  // 1. Pokemon count advantage
  const myAlive = battleState.getAliveCount(state.mySide);
  const oppAlive = battleState.getAliveCount(state.opponentSide);
  const totalMons = myAlive + oppAlive;
  const pokemonAdvantage = totalMons > 0
    ? ((myAlive - oppAlive) / Math.max(totalMons, 1))
    : 0;

  // 2. HP advantage (average HP percentage)
  const myAlivePokemon = state.mySide.pokemon.filter(p => !p.fainted);
  const oppAlivePokemon = state.opponentSide.pokemon.filter(p => !p.fainted);

  const myAvgHp = myAlivePokemon.length > 0
    ? myAlivePokemon.reduce((sum, p) => sum + p.hpPercent, 0) / myAlivePokemon.length
    : 0;
  const oppAvgHp = oppAlivePokemon.length > 0
    ? oppAlivePokemon.reduce((sum, p) => sum + p.hpPercent, 0) / oppAlivePokemon.length
    : 0;
  const hpAdvantage = (myAvgHp - oppAvgHp) / 100; // -1 to +1

  // 3. Hazards advantage (positive = we have hazards up on them, they don't on us)
  const oppHazards = countHazardLayers(state.opponentSide.sideConditions);
  const myHazards = countHazardLayers(state.mySide.sideConditions);
  const hazardAdvantage = Math.max(-1, Math.min(1,
    (oppHazards - myHazards) / 5 // normalized
  ));

  // 4. Speed advantage (how many matchups we outspeed)
  const oppSide = state.myPlayer === 'p1' ? 'p2' as const : 'p1' as const;
  let speedWins = 0;
  let speedTotal = 0;
  for (const my of myAlivePokemon) {
    for (const opp of oppAlivePokemon) {
      const mySpeed = calc.getEffectiveSpeed(my, state.field, state.myPlayer);
      const oppSpeed = calc.getEffectiveSpeed(opp, state.field, oppSide);
      speedTotal++;
      if (mySpeed > oppSpeed) speedWins++;
    }
  }
  const speedAdvantage = speedTotal > 0
    ? (speedWins / speedTotal - 0.5) * 2 // center around 0
    : 0;

  // 5. Type matchup advantage (simplified: check active matchup)
  let typeMatchupAdvantage = 0;
  if (state.mySide.activePokemon && state.opponentSide.activePokemon) {
    // Check our best move vs their best move damage
    let ourBest = 0;
    let theirBest = 0;
    const myActive = state.mySide.activePokemon;
    const oppActive = state.opponentSide.activePokemon;

    for (const move of myActive.moves) {
      try {
        const dmg = calc.calcDamage(myActive, oppActive, move, state.field);
        ourBest = Math.max(ourBest, dmg.maxPercent);
      } catch { /* skip */ }
    }
    for (const move of oppActive.knownMoves) {
      try {
        const dmg = calc.calcDamage(oppActive, myActive, move, state.field);
        theirBest = Math.max(theirBest, dmg.maxPercent);
      } catch { /* skip */ }
    }
    typeMatchupAdvantage = Math.max(-1, Math.min(1,
      (ourBest - theirBest) / 100
    ));
  }

  // 6. Status advantage
  const myStatused = myAlivePokemon.filter(p => p.status !== null).length;
  const oppStatused = oppAlivePokemon.filter(p => p.status !== null).length;
  const statusAdvantage = Math.max(-1, Math.min(1,
    (oppStatused - myStatused) / 3
  ));

  // 7. Win condition viability
  const bestWinCondition = winConditions.length > 0 ? winConditions[0].score : 0;
  const winConditionViability = (bestWinCondition - 0.5) * 2; // center around 0

  // Weighted final score
  const score = Math.max(-1.0, Math.min(1.0,
    (pokemonAdvantage * w.pokemonAdvantage) +
    (hpAdvantage * w.hpAdvantage) +
    (hazardAdvantage * w.hazardAdvantage) +
    (speedAdvantage * w.speedAdvantage) +
    (typeMatchupAdvantage * w.typeMatchupAdvantage) +
    (statusAdvantage * w.statusAdvantage) +
    (winConditionViability * w.winConditionViability)
  ));

  return {
    score,
    factors: {
      pokemonAdvantage,
      hpAdvantage,
      hazardAdvantage,
      speedAdvantage,
      typeMatchupAdvantage,
      statusAdvantage,
      winConditionViability,
    },
  };
}

function countHazardLayers(conditions: Map<string, number>): number {
  let total = 0;
  total += conditions.get('stealthrock') || 0;
  total += conditions.get('spikes') || 0;
  total += conditions.get('toxicspikes') || 0;
  total += conditions.get('stickyweb') || 0;
  return total;
}
