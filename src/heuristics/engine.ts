import {
  Decision,
  DamageMatchup,
  DamageResult,
  BattleStateSnapshot,
  MoveInfo,
  PokemonState,
  StrategicState,
  SackOrderEntry,
} from '../types';
import { DamageCalculator } from '../calculator/damage';
import { InferenceEngine } from '../inference/engine';
import { BattleState } from '../battle/state';
import { logDebug } from '../logging/logger';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HAZARD_REMOVAL_MOVES = new Set(['rapidspin', 'defog', 'tidyup', 'courtchange', 'mortalspin']);
const SETUP_MOVES = new Set([
  'swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'quiverdance',
  'shellsmash', 'bulkup', 'bellydrum', 'coil', 'shiftgear', 'workup',
]);
const RECOVERY_MOVES = new Set(['recover', 'roost', 'slackoff', 'softboiled', 'moonlight', 'morningsun', 'synthesis', 'wish', 'rest']);
const HAZARD_MOVES = new Set(['stealthrock', 'spikes', 'toxicspikes', 'stickyweb']);
const PIVOT_MOVES = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport']);

/**
 * Heuristic decision engine.
 * Attempts to resolve obvious battle situations without calling Claude.
 * Returns null if no confident heuristic applies.
 */
export function heuristicDecision(
  state: BattleStateSnapshot,
  battleState: BattleState,
  matchup: DamageMatchup,
  strategic: StrategicState,
  availableMoves: MoveInfo[],
  switchOptions: PokemonState[],
  calc: DamageCalculator,
  inference: InferenceEngine
): Decision | null {
  const myActive = state.mySide.activePokemon;
  const oppActive = state.opponentSide.activePokemon;
  if (!myActive || !oppActive) return null;

  // ═══════════════════════════════════════
  // 1. Force Switch — pick best switch-in
  // ═══════════════════════════════════════
  if (battleState.isForceSwitch()) {
    return pickBestSwitch(state, switchOptions, strategic, calc, inference, oppActive);
  }

  // ═══════════════════════════════════════
  // 2. Speed check for KO interactions
  // ═══════════════════════════════════════
  const oppSideId = state.myPlayer === 'p1' ? 'p2' as const : 'p1' as const;
  const mySpeed = calc.getEffectiveSpeed(myActive, state.field, state.myPlayer);
  const oppSpeed = calc.getEffectiveSpeed(oppActive, state.field, oppSideId);
  const iOutspeed = mySpeed > oppSpeed;

  // ═══════════════════════════════════════
  // 3. Priority KO (always check first — bypasses speed)
  // ═══════════════════════════════════════
  const priorityKO = matchup.myAttacking.find(d => d.isOHKO && d.priority > 0);
  if (priorityKO) {
    // Also check if opponent has a higher-priority move that can KO us
    const oppPriorityKO = matchup.oppAttacking.find(d => d.isOHKO && d.priority > 0);
    const oppOutprioritizes = oppPriorityKO && oppPriorityKO.priority > priorityKO.priority;
    if (!oppOutprioritizes) {
      const moveIdx = findMoveIndex(availableMoves, priorityKO.move);
      if (moveIdx !== -1) {
        logDebug(`Heuristic: Priority KO with ${priorityKO.move}`);
        return {
          type: 'move',
          choice: priorityKO.move,
          moveIndex: moveIdx + 1,
          source: 'heuristic',
          confidence: 0.93,
          reasoning: `Priority KO on ${oppActive.name} at ${oppActive.hpPercent.toFixed(0)}%`,
        };
      }
    }
  }

  // ═══════════════════════════════════════
  // 4. Guaranteed OHKO (with speed awareness)
  // ═══════════════════════════════════════
  const guaranteedKO = matchup.myAttacking.find(d => d.isOHKO);
  if (guaranteedKO) {
    const theyCanKOFirst = !iOutspeed && matchup.oppAttacking.some(d => d.isOHKO);
    if (!theyCanKOFirst) {
      // Safe to attack — we outspeed or they can't KO us
      const moveIdx = findMoveIndex(availableMoves, guaranteedKO.move);
      if (moveIdx !== -1) {
        logDebug(`Heuristic: Guaranteed KO with ${guaranteedKO.move}`);
        return {
          type: 'move',
          choice: guaranteedKO.move,
          moveIndex: moveIdx + 1,
          source: 'heuristic',
          confidence: 0.95,
          reasoning: `Guaranteed OHKO with ${guaranteedKO.move} (${guaranteedKO.minPercent.toFixed(0)}-${guaranteedKO.maxPercent.toFixed(0)}%)`,
        };
      }
    } else {
      // They outspeed and can KO — use priority if available, otherwise consider switching
      if (priorityKO) {
        const moveIdx = findMoveIndex(availableMoves, priorityKO.move);
        if (moveIdx !== -1) {
          return {
            type: 'move',
            choice: priorityKO.move,
            moveIndex: moveIdx + 1,
            source: 'heuristic',
            confidence: 0.88,
            reasoning: 'Priority KO — opponent outspeeds and threatens KO',
          };
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // 5. We're about to be KO'd — consider switching or priority
  // ═══════════════════════════════════════
  const theyCanKO = matchup.oppAttacking.find(d => d.isOHKO);
  if (theyCanKO) {
    // Do we have a priority move that can KO them?
    const ourPriorityKO = matchup.myAttacking.find(d => d.isOHKO && d.priority > 0);
    if (ourPriorityKO) {
      const moveIdx = findMoveIndex(availableMoves, ourPriorityKO.move);
      if (moveIdx !== -1) {
        return {
          type: 'move',
          choice: ourPriorityKO.move,
          moveIndex: moveIdx + 1,
          source: 'heuristic',
          confidence: 0.88,
          reasoning: 'Priority KO before we go down',
        };
      }
    }

    // Should we sack or switch? Check sack order.
    const isWinCondition = strategic.winConditions.length > 0 &&
      strategic.winConditions[0].pokemon === myActive.name &&
      strategic.winConditions[0].score > 0.5;

    if (isWinCondition && switchOptions.length > 0 && !battleState.isTrapped()) {
      // Preserve win condition: switch to best sack candidate
      return pickBestSwitch(state, switchOptions, strategic, calc, inference, oppActive);
    }
  }

  // ═══════════════════════════════════════
  // 6. Hazard removal — only when hazards threaten win conditions
  // ═══════════════════════════════════════
  const myHazards = state.mySide.sideConditions;
  if (myHazards.size > 0) {
    const removalMove = availableMoves.find(m => HAZARD_REMOVAL_MOVES.has(toId(m.id)));
    if (removalMove && myActive.hpPercent > 40) {
      // Don't remove hazards if we can KO instead
      if (!guaranteedKO) {
        // Check if hazards actually threaten our win condition or bench Pokemon
        const hazardsThreatening = hazardsThreatenTeam(state, strategic);
        if (hazardsThreatening) {
          const moveIdx = findMoveIndex(availableMoves, removalMove.id);
          if (moveIdx !== -1) {
            logDebug(`Heuristic: Hazard removal with ${removalMove.id}`);
            return {
              type: 'move',
              choice: removalMove.id,
              moveIndex: moveIdx + 1,
              source: 'heuristic',
              confidence: 0.75,
              reasoning: 'Remove hazards threatening win condition',
            };
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // 6. Set up hazards when safe
  // ═══════════════════════════════════════
  const oppHazards = state.opponentSide.sideConditions;
  if (!oppHazards.has('stealthrock') && myActive.hpPercent > 60) {
    const hazardMove = availableMoves.find(m => HAZARD_MOVES.has(toId(m.id)));
    if (hazardMove) {
      // Only set hazards if we're not in immediate danger
      const worstOppDmg = matchup.oppAttacking[0]?.maxPercent || 0;
      if (worstOppDmg < 50) {
        const moveIdx = findMoveIndex(availableMoves, hazardMove.id);
        if (moveIdx !== -1) {
          logDebug(`Heuristic: Set hazards with ${hazardMove.id}`);
          return {
            type: 'move',
            choice: hazardMove.id,
            moveIndex: moveIdx + 1,
            source: 'heuristic',
            confidence: 0.70,
            reasoning: 'Set up hazards',
          };
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // 7. Setup opportunity (recognizes safe setups: opponent locked, slower, or forced out)
  // ═══════════════════════════════════════
  const setupMove = availableMoves.find(m => SETUP_MOVES.has(toId(m.id)));
  if (setupMove && myActive.hpPercent > 60) {
    const worstOppDmg = matchup.oppAttacking[0]?.maxPercent || 0;
    const isWinCond = strategic.winConditions.length > 0 &&
      strategic.winConditions[0].pokemon === myActive.name;

    // Detect safe setup conditions
    const oppLocked = oppActive.volatiles.has('choicelock') ||
      oppActive.volatiles.has('mustrecharge') ||
      oppActive.volatiles.has('twoturnmove');
    const oppSlower = iOutspeed;
    const oppCantThreaten = worstOppDmg < 45;
    const oppLowHp = oppActive.hpPercent < 25;  // They'll likely switch
    const isSafe = oppCantThreaten || oppLocked || (oppSlower && oppLowHp);

    if (isSafe && isWinCond) {
      const moveIdx = findMoveIndex(availableMoves, setupMove.id);
      if (moveIdx !== -1) {
        const reason = oppLocked ? 'opponent locked' :
          oppLowHp ? 'opponent likely switching' :
          'opponent can\'t threaten';
        logDebug(`Heuristic: Setup with ${setupMove.id} (${reason})`);
        return {
          type: 'move',
          choice: setupMove.id,
          moveIndex: moveIdx + 1,
          source: 'heuristic',
          confidence: 0.80,
          reasoning: `Safe setup: ${reason}`,
        };
      }
    }
  }

  // ═══════════════════════════════════════
  // 8a. Pivot heuristic — U-turn / Volt Switch when matchup is unfavorable
  // ═══════════════════════════════════════
  if (!battleState.isTrapped() && switchOptions.length > 0) {
    const pivotMove = availableMoves.find(m => PIVOT_MOVES.has(toId(m.id)));
    if (pivotMove) {
      const bestOppDmg = matchup.oppAttacking[0]?.maxPercent || 0;
      const bestMyDmg = matchup.myAttacking[0]?.maxPercent || 0;
      // Pivot if matchup is unfavorable but not immediately lethal
      if (bestOppDmg > 35 && bestMyDmg < 40 && myActive.hpPercent > 30) {
        const moveIdx = findMoveIndex(availableMoves, pivotMove.id);
        if (moveIdx !== -1) {
          logDebug(`Heuristic: Pivot with ${pivotMove.id}`);
          return {
            type: 'move',
            choice: pivotMove.id,
            moveIndex: moveIdx + 1,
            source: 'heuristic',
            confidence: 0.72,
            reasoning: `Pivot with ${pivotMove.id} — unfavorable matchup, gain momentum`,
          };
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // 8b. Best available move (high confidence matchup)
  // ═══════════════════════════════════════
  if (matchup.myAttacking.length > 0) {
    const bestMove = matchup.myAttacking[0];
    // If the best move does significant damage, use it
    if (bestMove.maxPercent > 40) {
      const moveIdx = findMoveIndex(availableMoves, bestMove.move);
      if (moveIdx !== -1) {
        // Check: should we switch instead?
        const shouldSwitch = shouldConsiderSwitching(
          state, matchup, strategic, switchOptions, calc, oppActive
        );
        if (!shouldSwitch) {
          logDebug(`Heuristic: Best move ${bestMove.move} (${bestMove.maxPercent.toFixed(0)}%)`);
          return {
            type: 'move',
            choice: bestMove.move,
            moveIndex: moveIdx + 1,
            source: 'heuristic',
            confidence: 0.70,
            reasoning: `Best damage: ${bestMove.move} (${bestMove.minPercent.toFixed(0)}-${bestMove.maxPercent.toFixed(0)}%)`,
          };
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // 9. Bad matchup — consider switching
  // ═══════════════════════════════════════
  if (!battleState.isTrapped() && switchOptions.length > 0) {
    const bestOppDmg = matchup.oppAttacking[0]?.maxPercent || 0;
    const bestMyDmg = matchup.myAttacking[0]?.maxPercent || 0;

    // Very unfavorable: they hit us much harder than we hit them
    if (bestOppDmg > 50 && bestMyDmg < 25) {
      const sw = pickBestSwitch(state, switchOptions, strategic, calc, inference, oppActive);
      if (sw) {
        logDebug(`Heuristic: Switching out of bad matchup`);
        return sw;
      }
    }
  }

  // No confident heuristic found — fall through to Claude
  return null;
}

// ────────────────────────────────────────
// Helper functions
// ────────────────────────────────────────

function findMoveIndex(moves: MoveInfo[], moveId: string): number {
  return moves.findIndex(m => toId(m.id) === toId(moveId) && !m.disabled && m.pp > 0);
}

function pickBestSwitch(
  state: BattleStateSnapshot,
  options: PokemonState[],
  strategic: StrategicState,
  calc: DamageCalculator,
  inference: InferenceEngine,
  oppActive: PokemonState
): Decision | null {
  if (options.length === 0) return null;

  // Score each switch option
  const scored = options.map(pokemon => {
    let score = 0;

    // 1. How much damage can they do to us?
    const oppMoves = [...oppActive.knownMoves];
    const inferred = inference.getLikelyUnrevealed(oppActive.species, 0.3);
    for (const { move } of inferred) oppMoves.push(move);

    let worstDmg = 0;
    for (const moveId of oppMoves) {
      try {
        const dmg = calc.calcDamage(oppActive, pokemon, moveId, state.field);
        worstDmg = Math.max(worstDmg, dmg.maxPercent);
      } catch { /* skip */ }
    }

    // Lower damage = better switch-in
    score += (100 - worstDmg) / 100 * 0.40;

    // 2. How much damage can we do to them?
    let bestMyDmg = 0;
    for (const move of pokemon.moves) {
      try {
        const dmg = calc.calcDamage(pokemon, oppActive, move, state.field);
        bestMyDmg = Math.max(bestMyDmg, dmg.maxPercent);
      } catch { /* skip */ }
    }
    score += (bestMyDmg / 100) * 0.25;

    // 3. Preservation score (prefer sacking low-value mons)
    const sackEntry = strategic.sackOrder.find(s => s.pokemon === pokemon.name);
    score += (1 - (sackEntry?.preservationScore || 0.5)) * 0.15;

    // 4. HP remaining
    score += (pokemon.hpPercent / 100) * 0.20;

    return { pokemon, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // Find the switch index (1-based position in the team)
  const sidePokemons = state.mySide.pokemon;
  const switchIdx = sidePokemons.findIndex(p => p.species === best.pokemon.species) + 1;

  return {
    type: 'switch',
    choice: best.pokemon.name.toLowerCase(),
    switchIndex: switchIdx,
    source: 'heuristic',
    confidence: 0.75,
    reasoning: `Best switch-in: ${best.pokemon.name} (score ${best.score.toFixed(2)})`,
  };
}

/**
 * Check if hazards on our side threaten our win condition or key bench Pokemon.
 * Returns true only when hazards meaningfully impact our game plan.
 */
function hazardsThreatenTeam(state: BattleStateSnapshot, strategic: StrategicState): boolean {
  const hazards = state.mySide.sideConditions;
  if (hazards.size === 0) return false;

  const hasRocks = hazards.has('stealthrock');
  const spikeLayers = hazards.get('spikes') || 0;
  const tSpikeLayers = hazards.get('toxicspikes') || 0;

  const benchPokemon = state.mySide.pokemon.filter(p => !p.fainted && !p.active);
  if (benchPokemon.length === 0) return false;

  // If win condition needs to switch in and hazards would hurt it
  const topWinCond = strategic.winConditions.length > 0 ? strategic.winConditions[0] : null;
  if (topWinCond) {
    const wcPoke = benchPokemon.find(p => p.name === topWinCond.pokemon);
    if (wcPoke) {
      const estimatedChip = (hasRocks ? 12.5 : 0) + (spikeLayers * 8.3);
      if (wcPoke.hpPercent - estimatedChip < 60) return true;
    }
  }

  // Hazards matter if multiple bench Pokemon take significant chip
  let threatenedCount = 0;
  for (const p of benchPokemon) {
    const chipEstimate = (hasRocks ? 12.5 : 0) + (spikeLayers * 8.3);
    if (chipEstimate > 10 && p.hpPercent < 70) threatenedCount++;
  }
  if (threatenedCount >= 2) return true;

  // Toxic Spikes threatening key unstatused Pokemon
  if (tSpikeLayers > 0) {
    const unPoisoned = benchPokemon.filter(p => p.status === null);
    if (unPoisoned.length >= 2) return true;
  }

  return false;
}

function shouldConsiderSwitching(
  state: BattleStateSnapshot,
  matchup: DamageMatchup,
  strategic: StrategicState,
  switchOptions: PokemonState[],
  calc: DamageCalculator,
  oppActive: PokemonState
): boolean {
  if (switchOptions.length === 0) return false;

  const myActive = state.mySide.activePokemon;
  if (!myActive) return false;

  const bestOppDmg = matchup.oppAttacking[0]?.maxPercent || 0;
  const bestMyDmg = matchup.myAttacking[0]?.maxPercent || 0;

  // Don't switch if we can 2HKO and they can't KO us
  if (bestMyDmg > 50 && bestOppDmg < 60) return false;

  // Don't switch if we're boosted
  if (myActive.boosts.atk > 0 || myActive.boosts.spa > 0 || myActive.boosts.spe > 0) return false;

  // Consider switching if matchup is very unfavorable
  if (bestOppDmg > 55 && bestMyDmg < 30) return true;

  return false;
}
