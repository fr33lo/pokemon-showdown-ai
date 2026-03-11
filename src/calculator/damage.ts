import { Generations, Pokemon, Move, Field, calculate, Result } from '@smogon/calc';
import { CONFIG } from '../config';
import {
  PokemonState,
  BattleStateSnapshot,
  DamageResult,
  DamageMatchup,
  MoveInfo,
  FieldState,
} from '../types';
import { logDebug } from '../logging/logger';

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Priority move map (positive = priority)
const PRIORITY_MAP: Record<string, number> = {
  extremespeed: 2, fakeout: 3, firstimpression: 2,
  accelerock: 1, aquajet: 1, bulletpunch: 1, iceshard: 1,
  machpunch: 1, quickattack: 1, shadowsneak: 1,
  suckerpunch: 1, grassyglide: 1, jetpunch: 1,
};

// ============================================================
// Damage Calculator with Cache
// ============================================================

export class DamageCalculator {
  private gen;
  private cache: Map<string, DamageResult> = new Map();
  private cacheOrder: string[] = [];

  constructor() {
    this.gen = Generations.get(CONFIG.calc.generation);
  }

  // ────────────────────────────────────────
  // Core calculation
  // ────────────────────────────────────────

  /** Calculate damage for a specific move from attacker to defender */
  calcDamage(
    attacker: PokemonState,
    defender: PokemonState,
    moveId: string,
    field: FieldState
  ): DamageResult {
    const cacheKey = this.getCacheKey(attacker, defender, moveId, field);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const calcAttacker = this.toPokemon(attacker);
      const calcDefender = this.toPokemon(defender);
      const calcMove = new Move(this.gen, this.normalizeMoveName(moveId));
      const calcField = this.toField(field);

      const result = calculate(this.gen, calcAttacker, calcDefender, calcMove, calcField);
      const damageResult = this.parseResult(result, moveId, attacker.name, defender.name);

      this.addToCache(cacheKey, damageResult);
      return damageResult;
    } catch (e) {
      logDebug(`Calc error for ${moveId}: ${e}`);
      return this.fallbackResult(moveId, attacker.name, defender.name);
    }
  }

  /** Calculate all move matchups between two active Pokemon */
  calcMatchup(
    state: BattleStateSnapshot,
    myMoves: MoveInfo[],
    inferredOpponentMoves?: Map<string, number>
  ): DamageMatchup {
    const myActive = state.mySide.activePokemon;
    const oppActive = state.opponentSide.activePokemon;
    if (!myActive || !oppActive) {
      return { myAttacking: [], oppAttacking: [] };
    }

    // My moves vs opponent
    const myAttacking: DamageResult[] = [];
    for (const move of myMoves) {
      if (move.disabled || move.pp <= 0) continue;
      const result = this.calcDamage(myActive, oppActive, move.id, state.field);
      myAttacking.push(result);
    }

    // Opponent's known + inferred moves vs me
    const oppAttacking: DamageResult[] = [];
    const oppMoves = new Set<string>();

    // Known moves
    for (const move of oppActive.knownMoves) {
      oppMoves.add(move);
    }

    // Add inferred moves with reasonable probability
    if (inferredOpponentMoves) {
      for (const [move, prob] of inferredOpponentMoves) {
        if (prob >= 0.3) oppMoves.add(move);
      }
    }

    for (const moveId of oppMoves) {
      try {
        const result = this.calcDamage(oppActive, myActive, moveId, state.field);
        oppAttacking.push(result);
      } catch {
        // Skip invalid moves
      }
    }

    // Sort by max damage
    myAttacking.sort((a, b) => b.maxPercent - a.maxPercent);
    oppAttacking.sort((a, b) => b.maxPercent - a.maxPercent);

    return { myAttacking, oppAttacking };
  }

  /** Calculate expected damage from an opponent to a specific Pokemon on my team */
  calcDamageToSwitch(
    opponentActive: PokemonState,
    mySwitch: PokemonState,
    opponentMoves: string[],
    field: FieldState
  ): DamageResult[] {
    const results: DamageResult[] = [];
    for (const moveId of opponentMoves) {
      try {
        const result = this.calcDamage(opponentActive, mySwitch, moveId, field);
        results.push(result);
      } catch {
        // Skip
      }
    }
    return results.sort((a, b) => b.maxPercent - a.maxPercent);
  }

  // ────────────────────────────────────────
  // @smogon/calc type conversion
  // ────────────────────────────────────────

  private toPokemon(p: PokemonState): Pokemon {
    const species = this.normalizeSpeciesName(p.species);
    // Use actual HP if known (our side), otherwise estimate from percentage
    // The calc library needs curHP relative to the Pokemon's calculated maxHP,
    // so we pass the percentage and let it resolve after construction
    const estimatedMaxHp = p.maxHp > 0 && p.maxHp !== 100 ? p.maxHp : 0;
    const curHP = estimatedMaxHp > 0
      ? p.hp  // actual HP known (our Pokemon)
      : (p.hpPercent > 0 ? Math.max(1, Math.round(p.hpPercent * 3)) : 0); // estimate for opponent
    const options: any = {
      level: p.level || 80,
      curHP,
      boosts: {
        atk: p.boosts.atk,
        def: p.boosts.def,
        spa: p.boosts.spa,
        spd: p.boosts.spd,
        spe: p.boosts.spe,
      },
      // Random battles use 84 EVs per stat by default
      evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    };

    if (p.ability) options.ability = p.knownAbility || p.ability;
    if (p.knownItem) options.item = p.knownItem;
    else if (p.item && !p.itemConsumed) options.item = p.item;
    if (p.status) options.status = this.statusToCalc(p.status);
    if (p.terastallized && p.teraType) options.teraType = p.teraType;

    try {
      return new Pokemon(this.gen, species, options);
    } catch {
      // Fallback: try without options that might cause issues
      return new Pokemon(this.gen, species, {
        level: p.level || 80,
        evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 },
      });
    }
  }

  private toField(f: FieldState): Field {
    const options: any = {};

    if (f.weather) {
      const weatherMap: Record<string, string> = {
        sunnyday: 'Sun', desolateland: 'Harsh Sunshine',
        raindance: 'Rain', primordialsea: 'Heavy Rain',
        sandstorm: 'Sand', snowscape: 'Snow', hail: 'Hail',
      };
      options.weather = weatherMap[f.weather] || undefined;
    }

    if (f.terrain) {
      const terrainMap: Record<string, string> = {
        electricterrain: 'Electric', grassyterrain: 'Grassy',
        mistyterrain: 'Misty', psychicterrain: 'Psychic',
      };
      options.terrain = terrainMap[f.terrain] || undefined;
    }

    return new Field(options);
  }

  private statusToCalc(status: string): string {
    const map: Record<string, string> = {
      brn: 'brn', par: 'par', psn: 'psn',
      tox: 'tox', slp: 'slp', frz: 'frz',
    };
    return map[status] || '';
  }

  private normalizeSpeciesName(species: string): string {
    // Handle common species ID to name mappings
    const speciesMap: Record<string, string> = {
      landorustherian: 'Landorus-Therian',
      slowkinggalar: 'Slowking-Galar',
      urshifurapidstrike: 'Urshifu-Rapid-Strike',
      rotomwash: 'Rotom-Wash',
      rotomheat: 'Rotom-Heat',
      ironvaliant: 'Iron Valiant',
      ironmoth: 'Iron Moth',
      irontreads: 'Iron Treads',
      greattusk: 'Great Tusk',
      roaringmoon: 'Roaring Moon',
    };
    return speciesMap[species] || species.charAt(0).toUpperCase() + species.slice(1);
  }

  private normalizeMoveName(moveId: string): string {
    // The calc library usually accepts lowercase IDs, but some need formatting
    return moveId;
  }

  // ────────────────────────────────────────
  // Result parsing
  // ────────────────────────────────────────

  private parseResult(result: Result, moveId: string, attacker: string, defender: string): DamageResult {
    const damage = result.damage;
    let minDmg = 0;
    let maxDmg = 0;

    if (typeof damage === 'number') {
      minDmg = damage;
      maxDmg = damage;
    } else if (Array.isArray(damage)) {
      if (Array.isArray(damage[0])) {
        // Multi-hit: sum the ranges
        const hits = damage as number[][];
        minDmg = hits.reduce((sum, hit) => sum + Math.min(...hit), 0);
        maxDmg = hits.reduce((sum, hit) => sum + Math.max(...hit), 0);
      } else {
        const nums = damage as number[];
        minDmg = Math.min(...nums);
        maxDmg = Math.max(...nums);
      }
    }

    const defenderMaxHp = result.defender.originalCurHP || result.defender.maxHP();
    const minPercent = defenderMaxHp > 0 ? (minDmg / defenderMaxHp) * 100 : 0;
    const maxPercent = defenderMaxHp > 0 ? (maxDmg / defenderMaxHp) * 100 : 0;

    const curHpPercent = defenderMaxHp > 0
      ? (result.defender.curHP() / defenderMaxHp) * 100
      : 100;

    return {
      move: moveId,
      attacker,
      defender,
      minDamage: minDmg,
      maxDamage: maxDmg,
      minPercent,
      maxPercent,
      isOHKO: minPercent >= curHpPercent,
      is2HKO: minPercent * 2 >= curHpPercent,
      priority: PRIORITY_MAP[toId(moveId)] || 0,
    };
  }

  private fallbackResult(moveId: string, attacker: string, defender: string): DamageResult {
    return {
      move: moveId,
      attacker,
      defender,
      minDamage: 0,
      maxDamage: 0,
      minPercent: 0,
      maxPercent: 0,
      isOHKO: false,
      is2HKO: false,
      priority: PRIORITY_MAP[toId(moveId)] || 0,
    };
  }

  // ────────────────────────────────────────
  // Cache management
  // ────────────────────────────────────────

  private getCacheKey(
    attacker: PokemonState,
    defender: PokemonState,
    moveId: string,
    field: FieldState
  ): string {
    const atkItem = attacker.knownItem || attacker.item || '';
    const defItem = defender.knownItem || defender.item || '';
    const atkAbility = attacker.knownAbility || attacker.ability || '';
    const defAbility = defender.knownAbility || defender.ability || '';
    return `${attacker.species}:${atkAbility}:${atkItem}:${attacker.status}:${JSON.stringify(attacker.boosts)}|` +
      `${defender.species}:${defAbility}:${defItem}:${defender.status}:${defender.hpPercent.toFixed(0)}:${JSON.stringify(defender.boosts)}|` +
      `${moveId}|${field.weather}:${field.terrain}:${field.trickRoom}`;
  }

  private addToCache(key: string, result: DamageResult): void {
    if (this.cache.size >= CONFIG.calc.cacheSize) {
      // Evict oldest entries
      const toRemove = this.cacheOrder.splice(0, Math.floor(CONFIG.calc.cacheSize * 0.25));
      for (const k of toRemove) this.cache.delete(k);
    }
    this.cache.set(key, result);
    this.cacheOrder.push(key);
  }

  /** Clear the cache (e.g. at start of new battle) */
  clearCache(): void {
    this.cache.clear();
    this.cacheOrder = [];
  }

  /** Get an effective speed value considering boosts, paralysis, tailwind, etc. */
  getEffectiveSpeed(pokemon: PokemonState, field: FieldState, playerSide: 'p1' | 'p2'): number {
    let speed = pokemon.stats.spe || 100;

    // Apply boost multiplier
    const boost = pokemon.boosts.spe;
    if (boost > 0) speed = Math.floor(speed * (2 + boost) / 2);
    else if (boost < 0) speed = Math.floor(speed * 2 / (2 - boost));

    // Paralysis halves speed
    if (pokemon.status === 'par') speed = Math.floor(speed * 0.5);

    // Tailwind doubles speed
    if (field.tailwind[playerSide] > 0) speed *= 2;

    // Trick Room inverts speed
    if (field.trickRoom) speed = -speed;

    return speed;
  }
}
