import fs from 'fs';
import path from 'path';
import { RandomBattleData, RandomBattleSetEntry } from '../types';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class SetsDatabase {
  private sets: Map<string, RandomBattleSetEntry[]> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    const dataPath = path.join(__dirname, '../../data/random-sets.json');
    try {
      const raw = fs.readFileSync(dataPath, 'utf-8');
      const data: RandomBattleData[] = JSON.parse(raw);
      for (const entry of data) {
        const id = toId(entry.pokemon);
        this.sets.set(id, entry.sets);
      }
    } catch (e) {
      console.warn('Failed to load random sets database:', e);
    }
  }

  /** Get possible sets for a Pokemon species */
  getSets(species: string): RandomBattleSetEntry[] {
    return this.sets.get(toId(species)) || [];
  }

  /** Check if we have data for a Pokemon */
  hasData(species: string): boolean {
    return this.sets.has(toId(species));
  }

  /** Get all known Pokemon in the database */
  getAllPokemon(): string[] {
    return [...this.sets.keys()];
  }

  /** Get the most common ability for a Pokemon */
  getMostLikelyAbility(species: string): string | null {
    const sets = this.getSets(species);
    if (sets.length === 0) return null;
    const freq = new Map<string, number>();
    for (const s of sets) {
      freq.set(s.ability, (freq.get(s.ability) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [ability, count] of freq) {
      if (count > bestCount) {
        best = ability;
        bestCount = count;
      }
    }
    return best;
  }

  /** Get all possible moves for a Pokemon across all sets */
  getAllPossibleMoves(species: string): string[] {
    const sets = this.getSets(species);
    const moveSet = new Set<string>();
    for (const s of sets) {
      for (const m of s.moves) moveSet.add(m);
    }
    return [...moveSet];
  }
}
