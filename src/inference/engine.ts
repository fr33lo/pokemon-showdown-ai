import { SetsDatabase } from './sets-database';
import { PokemonTracker } from './tracker';
import { BattleStateSnapshot, InferredInfo, PokemonState } from '../types';
import { logDebug } from '../logging/logger';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Hidden Information Inference Engine.
 * Manages probabilistic trackers for all opponent Pokemon and
 * integrates observations from the battle state.
 */
export class InferenceEngine {
  private db: SetsDatabase;
  private trackers: Map<string, PokemonTracker> = new Map();

  constructor() {
    this.db = new SetsDatabase();
  }

  /** Get or create a tracker for an opponent Pokemon */
  private getTracker(pokemon: PokemonState): PokemonTracker {
    const id = toId(pokemon.species);
    if (!this.trackers.has(id)) {
      const sets = this.db.getSets(pokemon.species);
      const tracker = new PokemonTracker(pokemon.species, sets);
      this.trackers.set(id, tracker);
      logDebug(`Created tracker for ${pokemon.species} with ${sets.length} possible sets`);
    }
    return this.trackers.get(id)!;
  }

  /**
   * Update all trackers based on the current battle state.
   * Called each turn after state is updated.
   */
  update(state: BattleStateSnapshot): void {
    const oppSide = state.opponentSide;

    // Ensure trackers exist for all seen opponent Pokemon
    for (const pokemon of oppSide.pokemon) {
      const tracker = this.getTracker(pokemon);

      // Feed known moves
      for (const move of pokemon.knownMoves) {
        tracker.observeMove(move);
      }

      // Feed known ability
      if (pokemon.knownAbility) {
        tracker.observeAbility(pokemon.knownAbility);
      }

      // Feed known item
      if (pokemon.knownItem) {
        tracker.observeItem(pokemon.knownItem);
      }

      // Feed item consumption
      if (pokemon.itemConsumed) {
        tracker.observeItemConsumed();
      }
    }
  }

  /**
   * Process special observations that aren't captured in the state snapshot.
   * Called by the orchestrator for specific events.
   */
  observeNoHazardDamage(species: string): void {
    const id = toId(species);
    this.trackers.get(id)?.observeNoHazardDamage();
  }

  observeRecoil(species: string): void {
    const id = toId(species);
    this.trackers.get(id)?.observeRecoil();
  }

  /** Get inferred info for a specific opponent Pokemon */
  getInferredInfo(species: string): InferredInfo | null {
    const id = toId(species);
    return this.trackers.get(id)?.getInferredInfo() || null;
  }

  /** Get inferred info for all tracked opponent Pokemon */
  getAllInferredInfo(): Map<string, InferredInfo> {
    const result = new Map<string, InferredInfo>();
    for (const [id, tracker] of this.trackers) {
      result.set(id, tracker.getInferredInfo());
    }
    return result;
  }

  /** Get the most likely moves for the opponent's active Pokemon */
  getActiveOpponentMoves(state: BattleStateSnapshot): Map<string, number> {
    const active = state.opponentSide.activePokemon;
    if (!active) return new Map();

    const tracker = this.getTracker(active);
    return tracker.computeMoveProbabilities();
  }

  /** Check if an opponent Pokemon likely has a specific move */
  opponentLikelyHasMove(species: string, moveId: string, threshold: number = 0.5): boolean {
    const id = toId(species);
    return this.trackers.get(id)?.isMoveLikely(moveId, threshold) ?? false;
  }

  /** Get likely unrevealed moves for an opponent Pokemon */
  getLikelyUnrevealed(species: string, threshold: number = 0.3): Array<{ move: string; probability: number }> {
    const id = toId(species);
    return this.trackers.get(id)?.getLikelyUnrevealedMoves(threshold) ?? [];
  }

  /** Format inference summary for Claude prompt */
  formatForClaude(state: BattleStateSnapshot): string {
    const active = state.opponentSide.activePokemon;
    if (!active) return '';

    const info = this.getInferredInfo(active.species);
    if (!info) return '';

    const lines: string[] = [];
    lines.push(`Opponent ${active.name} likely moves:`);

    const moves = [...info.likelyMoves.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    for (const [move, prob] of moves) {
      lines.push(`  ${move} (${Math.round(prob * 100)}%)`);
    }

    const items = [...info.likelyItem.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (items.length > 0 && items[0][1] < 1.0) {
      lines.push('Likely item:');
      for (const [item, prob] of items) {
        lines.push(`  ${item} (${Math.round(prob * 100)}%)`);
      }
    }

    return lines.join('\n');
  }

  /** Reset all trackers (for new battle) */
  reset(): void {
    this.trackers.clear();
  }
}
