import {
  BattleStateSnapshot,
  PokemonState,
  StrategicState,
  DamageMatchup,
  MoveInfo,
} from '../types';
import { DamageCalculator } from '../calculator/damage';
import { logDebug } from '../logging/logger';

export type TeraVerdict = 'TERA_NOW' | 'TERA_SAVE' | 'TERA_SKIP';

export interface TeraEvaluation {
  verdict: TeraVerdict;
  score: number; // 0-1, how beneficial Tera is right now
  reasoning: string;
}

/**
 * Evaluate whether to Terastallize this turn.
 * Considers: does Tera enable a KO, does it prevent our death,
 * does it improve the win condition's sweep potential.
 */
export function evaluateTera(
  state: BattleStateSnapshot,
  strategic: StrategicState,
  matchup: DamageMatchup,
  availableMoves: MoveInfo[],
  calc: DamageCalculator,
  teraType: string | null
): TeraEvaluation {
  const myActive = state.mySide.activePokemon;
  const oppActive = state.opponentSide.activePokemon;

  if (!myActive || !oppActive || !teraType) {
    return { verdict: 'TERA_SKIP', score: 0, reasoning: 'Cannot Tera' };
  }

  // Already Tera'd
  if (myActive.terastallized) {
    return { verdict: 'TERA_SKIP', score: 0, reasoning: 'Already Terastallized' };
  }

  let score = 0;
  const reasons: string[] = [];

  // 1. Does Tera enable a KO we couldn't otherwise get?
  // Check if any STAB-boosted move would cross the KO threshold
  const bestCurrentDmg = matchup.myAttacking[0]?.maxPercent || 0;
  const bestCurrentIsKO = matchup.myAttacking[0]?.isOHKO || false;

  if (!bestCurrentIsKO && bestCurrentDmg > 70) {
    // Close to KO — Tera STAB boost might push it over
    score += 0.35;
    reasons.push('Tera may push damage to KO range');
  }

  // 2. Does Tera prevent our death?
  const worstOppDmg = matchup.oppAttacking[0]?.maxPercent || 0;
  const worstOppIsKO = matchup.oppAttacking[0]?.isOHKO || false;

  if (worstOppIsKO && myActive.hpPercent > 50) {
    // We'd die — Tera to a resistant type might save us
    score += 0.30;
    reasons.push('Tera may survive incoming KO');
  }

  // 3. Is this our win condition? Tera is most valuable on the sweeper
  const isWinCondition = strategic.winConditions.length > 0 &&
    strategic.winConditions[0].pokemon === myActive.name &&
    strategic.winConditions[0].score > 0.5;

  if (isWinCondition) {
    score += 0.20;
    reasons.push('Active is win condition');

    // Extra value if we're already boosted
    if (myActive.boosts.atk > 0 || myActive.boosts.spa > 0) {
      score += 0.15;
      reasons.push('Already boosted — maximize sweep');
    }
  }

  // 4. Late game bonus — Tera is more impactful with fewer Pokemon left
  const myAlive = state.mySide.pokemon.filter(p => !p.fainted).length;
  const oppAlive = state.opponentSide.pokemon.filter(p => !p.fainted).length;
  if (myAlive <= 2 || oppAlive <= 2) {
    score += 0.10;
    reasons.push('Late game — Tera has more impact');
  }

  // 5. Penalty for using Tera early (it's a one-time resource)
  if (state.turn < 5) {
    score -= 0.15;
    reasons.push('Early game — conserve Tera');
  }
  if (myAlive >= 5 && oppAlive >= 5) {
    score -= 0.10;
    reasons.push('Too many Pokemon remaining');
  }

  // Determine verdict
  score = Math.max(0, Math.min(1, score));

  let verdict: TeraVerdict;
  if (score >= 0.55) {
    verdict = 'TERA_NOW';
  } else if (score >= 0.25) {
    verdict = 'TERA_SAVE';
  } else {
    verdict = 'TERA_SKIP';
  }

  const reasoning = `${verdict}: ${reasons.join('; ')} (score: ${score.toFixed(2)})`;
  logDebug(`Tera evaluation: ${reasoning}`);

  return { verdict, score, reasoning };
}
