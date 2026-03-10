import { InferredSet, InferredInfo, RandomBattleSetEntry } from '../types';
import { logDebug } from '../logging/logger';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tracks probabilistic set distribution for a single opponent Pokemon.
 * Updates probabilities as moves, items, and abilities are revealed.
 */
export class PokemonTracker {
  readonly species: string;
  private sets: InferredSet[];
  private revealedMoves: Set<string> = new Set();
  private revealedAbility: string | null = null;
  private revealedItem: string | null = null;
  private itemConsumed: boolean = false;
  private noHazardDamage: boolean = false;
  private repeatedMove: string | null = null;
  private lastMove: string | null = null;
  private tookRecoil: boolean = false;

  constructor(species: string, baseSets: RandomBattleSetEntry[]) {
    this.species = toId(species);

    if (baseSets.length === 0) {
      // No known sets — create a generic unknown set
      this.sets = [{
        moves: [],
        ability: 'unknown',
        item: 'unknown',
        role: 'unknown',
        probability: 1.0,
      }];
    } else {
      // Initialize equal probability across all known sets
      const prob = 1.0 / baseSets.length;
      this.sets = baseSets.map(s => ({
        ...s,
        probability: prob,
      }));
    }
  }

  // ────────────────────────────────────────
  // Observation methods
  // ────────────────────────────────────────

  /** Called when the opponent uses a move */
  observeMove(moveId: string): void {
    const move = toId(moveId);
    this.revealedMoves.add(move);

    // Track repeated moves (indicates Choice item)
    if (this.lastMove && this.lastMove === move) {
      this.repeatedMove = move;
    }
    this.lastMove = move;

    // Eliminate sets that don't contain this move
    this.eliminateSetsWithout('move', move);
  }

  /** Called when the opponent's ability is revealed */
  observeAbility(ability: string): void {
    this.revealedAbility = toId(ability);
    this.eliminateSetsWithout('ability', this.revealedAbility);
  }

  /** Called when the opponent's item is revealed */
  observeItem(item: string): void {
    this.revealedItem = toId(item);
    this.eliminateSetsWithout('item', this.revealedItem);
  }

  /** Called when the item is consumed */
  observeItemConsumed(): void {
    this.itemConsumed = true;
  }

  /** Called when Pokemon switches in and takes no hazard damage */
  observeNoHazardDamage(): void {
    this.noHazardDamage = true;
    // Likely Heavy-Duty Boots or Magic Guard
    this.adjustItemProbability('heavydutyboots', 2.0);
  }

  /** Called when Life Orb recoil is observed */
  observeRecoil(): void {
    this.tookRecoil = true;
    this.adjustItemProbability('lifeorb', 5.0);
  }

  // ────────────────────────────────────────
  // Probability management
  // ────────────────────────────────────────

  private eliminateSetsWithout(field: 'move' | 'ability' | 'item', value: string): void {
    let changed = false;

    for (const set of this.sets) {
      if (set.probability <= 0) continue;

      let matches = false;
      switch (field) {
        case 'move':
          matches = set.moves.some(m => toId(m) === value);
          break;
        case 'ability':
          matches = toId(set.ability) === value;
          break;
        case 'item':
          matches = toId(set.item) === value;
          break;
      }

      if (!matches) {
        set.probability = 0;
        changed = true;
      }
    }

    if (changed) {
      this.renormalize();
    }
  }

  private adjustItemProbability(itemId: string, multiplier: number): void {
    for (const set of this.sets) {
      if (set.probability <= 0) continue;
      if (toId(set.item) === itemId) {
        set.probability *= multiplier;
      }
    }
    this.renormalize();
  }

  private renormalize(): void {
    const total = this.sets.reduce((sum, s) => sum + s.probability, 0);
    if (total <= 0) {
      // All sets eliminated — reset to uniform
      logDebug(`All sets eliminated for ${this.species}, resetting to uniform`);
      const prob = 1.0 / this.sets.length;
      for (const s of this.sets) s.probability = prob;
      return;
    }
    for (const s of this.sets) {
      s.probability /= total;
    }
  }

  // ────────────────────────────────────────
  // Query methods
  // ────────────────────────────────────────

  /** Get the full inferred info for this Pokemon */
  getInferredInfo(): InferredInfo {
    return {
      pokemon: this.species,
      possibleSets: this.sets.filter(s => s.probability > 0),
      likelyMoves: this.computeMoveProbabilities(),
      likelyAbility: this.computeAbilityProbabilities(),
      likelyItem: this.computeItemProbabilities(),
    };
  }

  /** Compute probability of each possible move */
  computeMoveProbabilities(): Map<string, number> {
    const probs = new Map<string, number>();

    // Already revealed moves are 100%
    for (const m of this.revealedMoves) {
      probs.set(m, 1.0);
    }

    // Unrevealed moves from possible sets
    for (const set of this.sets) {
      if (set.probability <= 0) continue;
      for (const move of set.moves) {
        const mid = toId(move);
        if (!this.revealedMoves.has(mid)) {
          probs.set(mid, (probs.get(mid) || 0) + set.probability);
        }
      }
    }

    // Cap at 1.0
    for (const [k, v] of probs) {
      probs.set(k, Math.min(v, 1.0));
    }

    return probs;
  }

  /** Compute probability of each possible ability */
  computeAbilityProbabilities(): Map<string, number> {
    if (this.revealedAbility) {
      return new Map([[this.revealedAbility, 1.0]]);
    }

    const probs = new Map<string, number>();
    for (const set of this.sets) {
      if (set.probability <= 0) continue;
      const aid = toId(set.ability);
      probs.set(aid, (probs.get(aid) || 0) + set.probability);
    }
    return probs;
  }

  /** Compute probability of each possible item */
  computeItemProbabilities(): Map<string, number> {
    if (this.revealedItem) {
      return new Map([[toId(this.revealedItem), 1.0]]);
    }

    const probs = new Map<string, number>();

    // Apply Choice item heuristic
    if (this.repeatedMove) {
      const choiceItems = ['choiceband', 'choicescarf', 'choicespecs'];
      for (const set of this.sets) {
        if (set.probability <= 0) continue;
        const iid = toId(set.item);
        let weight = set.probability;
        if (choiceItems.includes(iid)) weight *= 3.0;
        probs.set(iid, (probs.get(iid) || 0) + weight);
      }
      // Renormalize
      const total = [...probs.values()].reduce((a, b) => a + b, 0);
      if (total > 0) {
        for (const [k, v] of probs) probs.set(k, v / total);
      }
      return probs;
    }

    for (const set of this.sets) {
      if (set.probability <= 0) continue;
      const iid = toId(set.item);
      probs.set(iid, (probs.get(iid) || 0) + set.probability);
    }
    return probs;
  }

  /** Get revealed moves */
  getRevealedMoves(): string[] {
    return [...this.revealedMoves];
  }

  /** Get likely unrevealed moves with probability above threshold */
  getLikelyUnrevealedMoves(threshold: number = 0.3): Array<{ move: string; probability: number }> {
    const probs = this.computeMoveProbabilities();
    const result: Array<{ move: string; probability: number }> = [];
    for (const [move, prob] of probs) {
      if (!this.revealedMoves.has(move) && prob >= threshold) {
        result.push({ move, probability: prob });
      }
    }
    return result.sort((a, b) => b.probability - a.probability);
  }

  /** Check if a specific move is likely (probability > threshold) */
  isMoveLikely(moveId: string, threshold: number = 0.5): boolean {
    const probs = this.computeMoveProbabilities();
    return (probs.get(toId(moveId)) || 0) >= threshold;
  }
}
