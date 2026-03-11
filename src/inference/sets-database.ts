import fs from 'fs';
import path from 'path';
import https from 'https';
import { RandomBattleData, RandomBattleSetEntry } from '../types';
import { log, logDebug, logError } from '../logging/logger';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const REMOTE_URL = 'https://pkmn.github.io/randbats/data/gen9randombattle.json';
const CACHE_FILE = 'gen9randombattle-cache.json';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SetsDatabase {
  private sets: Map<string, RandomBattleSetEntry[]> = new Map();

  constructor() {
    this.loadLocalFallback();
  }

  /**
   * Initialize the database. Call at startup — fetches fresh data if cache is stale.
   * Falls back gracefully to local data on failure.
   */
  async initialize(): Promise<void> {
    const cachePath = path.join(__dirname, '../../data', CACHE_FILE);
    let needsFetch = true;

    // Check cache staleness
    try {
      const stat = fs.statSync(cachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < CACHE_MAX_AGE_MS) {
        needsFetch = false;
        logDebug(`Set cache is ${Math.round(ageMs / 3600000)}h old, using cached data`);
        this.loadCachedRemoteData(cachePath);
      } else {
        logDebug(`Set cache is ${Math.round(ageMs / 86400000)}d old, refreshing...`);
      }
    } catch {
      // No cache file — need to fetch
    }

    if (needsFetch) {
      try {
        const raw = await this.fetchRemoteData();
        this.parseRemoteFormat(raw);
        // Save to cache
        fs.writeFileSync(cachePath, JSON.stringify(raw));
        log(`Fetched fresh randbats data, cached to ${cachePath}`);
      } catch (e) {
        logError('Failed to fetch remote randbats data, using local fallback', e as Error);
      }
    }

    log(`Set database loaded: ${this.sets.size} Pokemon covered`);
  }

  /** Load the bundled local fallback file */
  private loadLocalFallback(): void {
    const dataPath = path.join(__dirname, '../../data/random-sets.json');
    try {
      const raw = fs.readFileSync(dataPath, 'utf-8');
      const data: RandomBattleData[] = JSON.parse(raw);
      for (const entry of data) {
        const id = toId(entry.pokemon);
        this.sets.set(id, entry.sets);
      }
    } catch (e) {
      console.warn('Failed to load local random sets database:', e);
    }
  }

  /** Load previously cached remote data */
  private loadCachedRemoteData(cachePath: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      this.parseRemoteFormat(raw);
    } catch (e) {
      logError('Failed to load cached remote data', e as Error);
    }
  }

  /**
   * Parse the pkmn.github.io randbats format into our internal format.
   * Remote schema per Pokemon:
   *   { level: number, roles: { [roleName]: { abilities: string[], items: string[], teraTypes: string[], moves: string[] } } }
   * We expand each role into a set entry with one ability/item combo per set.
   */
  private parseRemoteFormat(data: Record<string, any>): void {
    let count = 0;
    for (const [pokemon, entry] of Object.entries(data)) {
      if (!entry || !entry.roles) continue;
      const id = toId(pokemon);
      const sets: RandomBattleSetEntry[] = [];

      for (const [roleName, roleData] of Object.entries(entry.roles as Record<string, any>)) {
        const abilities: string[] = roleData.abilities || [];
        const items: string[] = roleData.items || [];
        const moves: string[] = roleData.moves || [];

        // Create a set entry for each ability/item combination (capped to avoid explosion)
        const maxCombos = 3;
        let combos = 0;
        for (const ability of abilities.slice(0, 2)) {
          for (const item of items.slice(0, 2)) {
            if (combos >= maxCombos) break;
            sets.push({
              moves: moves.slice(0, 6), // randbats can list more than 4 moves (pool)
              ability,
              item,
              role: roleName,
            });
            combos++;
          }
        }
      }

      if (sets.length > 0) {
        this.sets.set(id, sets);
        count++;
      }
    }
    logDebug(`Parsed ${count} Pokemon from remote randbats data`);
  }

  /** Fetch from pkmn.github.io */
  private fetchRemoteData(): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fetch timeout (15s)')), 15000);

      https.get(REMOTE_URL, (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON from remote'));
          }
        });
        res.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      }).on('error', (e: Error) => {
        clearTimeout(timeout);
        reject(e);
      });
    });
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
