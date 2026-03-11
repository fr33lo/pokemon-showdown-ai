import { CONFIG } from '../config';
import { Decision, MoveInfo } from '../types';

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Delay to simulate human thinking time before making a move (random float each turn) */
export async function turnDelay(): Promise<void> {
  const delay = randomFloat(CONFIG.behavior.turnDelayMin, CONFIG.behavior.turnDelayMax);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/** Delay before queueing the next battle */
export async function requeueDelay(): Promise<void> {
  const delay = randomBetween(CONFIG.behavior.requeueDelayMin, CONFIG.behavior.requeueDelayMax);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Occasionally introduce imperfect play to appear more human.
 * Returns a randomly altered decision ~2% of the time.
 */
export function maybeImperfectPlay(
  decision: Decision,
  availableMoves: MoveInfo[],
  switchOptions: string[]
): Decision {
  if (Math.random() > CONFIG.behavior.imperfectPlayRate) {
    return decision;
  }

  // Pick a random alternative move or switch
  if (decision.type === 'move' && availableMoves.length > 1) {
    const otherMoves = availableMoves.filter(
      m => m.id !== decision.choice && !m.disabled && m.pp > 0
    );
    if (otherMoves.length > 0) {
      const pick = otherMoves[Math.floor(Math.random() * otherMoves.length)];
      const moveIdx = availableMoves.findIndex(m => m.id === pick.id);
      return {
        ...decision,
        choice: pick.id,
        moveIndex: moveIdx + 1,
        source: 'random',
        confidence: 0,
        reasoning: 'imperfect play injection',
      };
    }
  }

  if (decision.type === 'switch' && switchOptions.length > 1) {
    const otherSwitches = switchOptions.filter(s => s !== decision.choice);
    if (otherSwitches.length > 0) {
      const pickIdx = Math.floor(Math.random() * otherSwitches.length);
      const pick = otherSwitches[pickIdx];
      // Compute a valid switchIndex from the original options list (1-based offset in team)
      const originalIdx = switchOptions.indexOf(pick);
      return {
        ...decision,
        choice: pick,
        switchIndex: originalIdx !== -1 ? originalIdx + 1 : decision.switchIndex,
        source: 'random',
        confidence: 0,
        reasoning: 'imperfect play injection',
      };
    }
  }

  return decision;
}
