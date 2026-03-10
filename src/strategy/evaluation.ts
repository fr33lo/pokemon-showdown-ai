import { BattleStateSnapshot, StrategicState } from '../types';
import { BattleState } from '../battle/state';
import { DamageCalculator } from '../calculator/damage';
import { InferenceEngine } from '../inference/engine';
import { evaluateWinConditions } from './win-conditions';
import { evaluateThreats } from './threats';
import { evaluatePosition } from './position';
import { calculateSackOrder } from './sack-order';

/**
 * Run the full strategic evaluation pipeline.
 * Returns win conditions, threats, position score, and sack order.
 */
export function evaluateStrategicState(
  state: BattleStateSnapshot,
  battleState: BattleState,
  calc: DamageCalculator,
  inference: InferenceEngine
): StrategicState {
  const winConditions = evaluateWinConditions(state, calc, inference);
  const threats = evaluateThreats(state, calc, inference);
  const position = evaluatePosition(state, battleState, calc, winConditions);
  const sackOrder = calculateSackOrder(state, calc, winConditions, threats);

  return { winConditions, threats, position, sackOrder };
}

/**
 * Format strategic state as a concise string for logging or Claude prompts.
 */
export function formatStrategicSummary(strategic: StrategicState): string {
  const lines: string[] = [];

  // Win conditions
  if (strategic.winConditions.length > 0) {
    const top = strategic.winConditions[0];
    lines.push(`My Win Condition: ${top.pokemon} (score ${top.score.toFixed(2)})`);
    if (top.requiresSetup) lines.push('  Requires setup');
    if (top.threatsRemaining.length > 0) {
      lines.push(`  Threats: ${top.threatsRemaining.join(', ')}`);
    }
  }

  // Top threats
  if (strategic.threats.length > 0) {
    lines.push('Top Opponent Threats:');
    for (const t of strategic.threats.slice(0, 3)) {
      lines.push(`  ${t.pokemon} (${t.score.toFixed(2)})`);
    }
  }

  // Position
  lines.push(`Position Score: ${strategic.position.score >= 0 ? '+' : ''}${strategic.position.score.toFixed(2)}`);

  // Sack order
  if (strategic.sackOrder.length > 1) {
    lines.push(`Sack Order: ${strategic.sackOrder.map(s => s.pokemon).join(' → ')}`);
  }

  return lines.join('\n');
}
