import {
  PokemonState,
  BaseStats,
  StatBoosts,
  StatusCondition,
  SideState,
  FieldState,
  BattleStateSnapshot,
  BattleRequest,
  SidePokemonData,
  MoveInfo,
  ActiveRequest,
} from '../types';
import { logDebug } from '../logging/logger';

// ============================================================
// Helpers
// ============================================================

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseDetails(details: string): { species: string; level: number; gender: string } {
  const parts = details.split(',').map(s => s.trim());
  const species = parts[0];
  let level = 100;
  let gender = 'N';
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith('L')) level = parseInt(parts[i].substring(1), 10);
    else if (parts[i] === 'M') gender = 'M';
    else if (parts[i] === 'F') gender = 'F';
  }
  return { species, level, gender };
}

function parseCondition(condition: string): { hp: number; maxHp: number; status: StatusCondition | null } {
  // Formats: "230/230", "65/100 brn", "0 fnt"
  if (condition === '0 fnt' || condition.endsWith(' fnt')) {
    return { hp: 0, maxHp: 100, status: null };
  }
  const parts = condition.split(' ');
  const hpParts = parts[0].split('/');
  const hp = parseInt(hpParts[0], 10);
  const maxHp = parseInt(hpParts[1], 10);
  const status = (parts[1] as StatusCondition) || null;
  return { hp, maxHp, status };
}

function parsePokemonIdent(ident: string): { player: 'p1' | 'p2'; position: string; name: string } {
  // Format: "p1a: Excadrill" or "p2a: Dragonite"
  const match = ident.match(/^(p[12])([a-z]): (.+)$/);
  if (!match) {
    return { player: 'p1', position: 'a', name: ident };
  }
  return {
    player: match[1] as 'p1' | 'p2',
    position: match[2],
    name: match[3],
  };
}

function emptyBoosts(): StatBoosts {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

function emptyStats(): BaseStats {
  return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
}

function createPokemon(name: string, species: string, level: number, gender: string): PokemonState {
  return {
    name,
    species: toId(species),
    level,
    gender,
    hp: 100,
    maxHp: 100,
    hpPercent: 100,
    status: null,
    statusTurns: 0,
    active: false,
    fainted: false,
    stats: emptyStats(),
    moves: [],
    knownMoves: [],
    ability: '',
    knownAbility: null,
    item: '',
    knownItem: null,
    itemConsumed: false,
    teraType: null,
    terastallized: false,
    boosts: emptyBoosts(),
    volatiles: new Set(),
  };
}

function createSide(id: 'p1' | 'p2'): SideState {
  return {
    name: '',
    id,
    pokemon: [],
    activePokemon: null,
    totalPokemon: 6,
    sideConditions: new Map(),
  };
}

function createField(): FieldState {
  return {
    weather: null,
    weatherTurns: 0,
    terrain: null,
    terrainTurns: 0,
    trickRoom: false,
    trickRoomTurns: 0,
    tailwind: { p1: 0, p2: 0 },
  };
}

// ============================================================
// Battle State Manager
// ============================================================

export class BattleState {
  private turn: number = 0;
  private myPlayer: 'p1' | 'p2' = 'p1';
  private p1: SideState = createSide('p1');
  private p2: SideState = createSide('p2');
  private field: FieldState = createField();
  private gameOver: boolean = false;
  private winner: string | null = null;
  private lastRequest: BattleRequest | null = null;
  private lastMoveByOpponent: string | null = null;
  private myName: string = '';

  constructor(myName: string) {
    this.myName = myName;
  }

  // ────────────────────────────────────────
  // Process PS protocol messages
  // ────────────────────────────────────────

  processMessages(messages: string[]): void {
    for (const line of messages) {
      if (!line.startsWith('|')) continue;
      const parts = line.substring(1).split('|');
      const cmd = parts[0];

      try {
        this.processCommand(cmd, parts.slice(1), line);
      } catch (e) {
        logDebug(`Error processing: ${line} — ${e}`);
      }
    }
  }

  private processCommand(cmd: string, args: string[], _raw: string): void {
    switch (cmd) {
      case 'player':
        this.handlePlayer(args);
        break;
      case 'teamsize':
        this.handleTeamSize(args);
        break;
      case 'turn':
        this.turn = parseInt(args[0], 10);
        break;
      case 'request':
        if (args[0]) this.handleRequest(args[0]);
        break;
      case 'switch':
      case 'drag':
        this.handleSwitch(args);
        break;
      case 'move':
        this.handleMove(args);
        break;
      case 'faint':
        this.handleFaint(args);
        break;
      case '-damage':
      case '-heal':
        this.handleHpChange(args);
        break;
      case '-status':
        this.handleStatus(args);
        break;
      case '-curestatus':
        this.handleCureStatus(args);
        break;
      case '-cureteam':
        this.handleCureTeam(args);
        break;
      case '-boost':
        this.handleBoost(args, 1);
        break;
      case '-unboost':
        this.handleBoost(args, -1);
        break;
      case '-setboost':
        this.handleSetBoost(args);
        break;
      case '-clearboost':
      case '-clearallboost':
        this.handleClearBoost(args);
        break;
      case '-weather':
        this.handleWeather(args);
        break;
      case '-fieldstart':
        this.handleFieldStart(args);
        break;
      case '-fieldend':
        this.handleFieldEnd(args);
        break;
      case '-sidestart':
        this.handleSideStart(args);
        break;
      case '-sideend':
        this.handleSideEnd(args);
        break;
      case '-ability':
        this.handleAbility(args);
        break;
      case '-item':
        this.handleItem(args);
        break;
      case '-enditem':
        this.handleEndItem(args);
        break;
      case '-start':
        this.handleVolatileStart(args);
        break;
      case '-end':
        this.handleVolatileEnd(args);
        break;
      case '-terastallize':
        this.handleTera(args);
        break;
      case 'win':
        this.gameOver = true;
        this.winner = args[0];
        break;
      case 'tie':
        this.gameOver = true;
        this.winner = null;
        break;
    }
  }

  // ────────────────────────────────────────
  // Protocol Handlers
  // ────────────────────────────────────────

  private handlePlayer(args: string[]): void {
    const playerId = args[0] as 'p1' | 'p2';
    const name = args[1]?.trim();
    if (!name) return;

    const side = this.getSide(playerId);
    side.name = name;

    if (toId(name) === toId(this.myName)) {
      this.myPlayer = playerId;
    }
  }

  private handleTeamSize(args: string[]): void {
    const playerId = args[0] as 'p1' | 'p2';
    const size = parseInt(args[1], 10);
    this.getSide(playerId).totalPokemon = size;
  }

  private handleRequest(json: string): void {
    try {
      const req = JSON.parse(json) as BattleRequest;
      this.lastRequest = req;

      // Update our side's Pokemon from request data (authoritative source)
      if (req.side) {
        const side = this.getMySide();
        if (req.side.id) {
          this.myPlayer = req.side.id as 'p1' | 'p2';
        }
        this.updateSideFromRequest(side, req.side.pokemon);
      }
    } catch {
      logDebug('Failed to parse request JSON');
    }
  }

  private updateSideFromRequest(side: SideState, pokemonData: SidePokemonData[]): void {
    for (const data of pokemonData) {
      const { species, level, gender } = parseDetails(data.details);
      const name = data.ident.split(': ')[1] || species;
      const speciesId = toId(species);

      let pokemon = side.pokemon.find(p => p.species === speciesId);
      if (!pokemon) {
        pokemon = createPokemon(name, species, level, gender);
        side.pokemon.push(pokemon);
      }

      // Update from authoritative request data
      pokemon.name = name;
      pokemon.level = level;
      pokemon.stats = { ...data.stats, hp: data.stats.hp || 0 };
      pokemon.moves = data.moves;
      pokemon.ability = data.ability || data.baseAbility;
      pokemon.item = data.item;
      pokemon.active = data.active;
      if (data.teraType) pokemon.teraType = data.teraType;

      // Parse condition
      const cond = parseCondition(data.condition);
      pokemon.hp = cond.hp;
      pokemon.maxHp = cond.maxHp;
      pokemon.hpPercent = cond.maxHp > 0 ? (cond.hp / cond.maxHp) * 100 : 0;
      pokemon.status = cond.status;
      pokemon.fainted = cond.hp === 0;

      if (pokemon.active) {
        side.activePokemon = pokemon;
      }
    }
  }

  private handleSwitch(args: string[]): void {
    const { player, name } = parsePokemonIdent(args[0]);
    const { species, level, gender } = parseDetails(args[1]);
    const cond = parseCondition(args[2]);
    const side = this.getSide(player);
    const speciesId = toId(species);

    // Clear current active
    if (side.activePokemon) {
      side.activePokemon.active = false;
      side.activePokemon.boosts = emptyBoosts();
      side.activePokemon.volatiles = new Set();
    }

    // Find or create the Pokemon
    let pokemon = side.pokemon.find(p => p.species === speciesId);
    if (!pokemon) {
      pokemon = createPokemon(name, species, level, gender);
      side.pokemon.push(pokemon);
    }

    pokemon.name = name;
    pokemon.active = true;
    pokemon.hp = cond.hp;
    pokemon.maxHp = cond.maxHp;
    pokemon.hpPercent = cond.maxHp > 0 ? (cond.hp / cond.maxHp) * 100 : 0;
    pokemon.status = cond.status;
    pokemon.fainted = cond.hp === 0;
    pokemon.boosts = emptyBoosts();
    pokemon.volatiles = new Set();

    side.activePokemon = pokemon;

    // Track opponent switch-ins over hazards for HDB inference
    if (player !== this.myPlayer) {
      const oppHazards = this.getSide(player === 'p1' ? 'p1' : 'p2').sideConditions;
      if (oppHazards.size > 0) {
        // Record the species that switched in — if no damage event follows,
        // the orchestrator can call observeNoHazardDamage
        this.pendingHazardCheck = { player, species: speciesId, hpAtEntry: cond.hp };
      }
    }
  }

  /** Pending hazard check for HDB inference */
  private pendingHazardCheck: { player: 'p1' | 'p2'; species: string; hpAtEntry: number } | null = null;

  /** Consume and return pending hazard check (orchestrator calls after processing messages) */
  consumeHazardCheck(): { species: string; tookDamage: boolean } | null {
    const check = this.pendingHazardCheck;
    if (!check) return null;
    this.pendingHazardCheck = null;
    // Compare entry HP with current HP — if unchanged, no hazard damage
    const side = this.getSide(check.player);
    const pokemon = side.activePokemon;
    if (pokemon && pokemon.species === check.species) {
      return { species: check.species, tookDamage: pokemon.hp < check.hpAtEntry };
    }
    return null;
  }

  private handleMove(args: string[]): void {
    const { player, name: _name } = parsePokemonIdent(args[0]);
    const moveId = toId(args[1]);

    const side = this.getSide(player);
    if (side.activePokemon) {
      if (!side.activePokemon.knownMoves.includes(moveId)) {
        side.activePokemon.knownMoves.push(moveId);
      }
    }

    // Track opponent's last move
    if (player !== this.myPlayer) {
      this.lastMoveByOpponent = moveId;
    }
  }

  private handleFaint(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.hp = 0;
      side.activePokemon.hpPercent = 0;
      side.activePokemon.fainted = true;
      side.activePokemon.active = false;
      side.activePokemon = null;
    }
  }

  private handleHpChange(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const cond = parseCondition(args[1]);
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.hp = cond.hp;
      side.activePokemon.maxHp = cond.maxHp;
      side.activePokemon.hpPercent = cond.maxHp > 0 ? (cond.hp / cond.maxHp) * 100 : 0;
      if (cond.status) side.activePokemon.status = cond.status;
      side.activePokemon.fainted = cond.hp === 0;
    }

    // Track [from] source for inference (Life Orb, etc.)
    const fromArg = args.find(a => a.includes('[from]'));
    if (fromArg) {
      const fromMatch = fromArg.match(/\[from\]\s*item:\s*(.+)/i);
      if (fromMatch) {
        const itemName = fromMatch[1].trim();
        if (side.activePokemon) {
          side.activePokemon.knownItem = itemName;
        }
        // Emit for inference tracking
        this.lastDamageSource = { player, item: itemName };
      }
    }
  }

  /** Last damage source info for inference engine consumption */
  private lastDamageSource: { player: 'p1' | 'p2'; item: string } | null = null;

  getLastDamageSource(): { player: 'p1' | 'p2'; item: string } | null {
    const src = this.lastDamageSource;
    this.lastDamageSource = null;
    return src;
  }

  private handleStatus(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const status = args[1] as StatusCondition;
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.status = status;
      side.activePokemon.statusTurns = 0;
    }
  }

  private handleCureStatus(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.status = null;
      side.activePokemon.statusTurns = 0;
    }
  }

  private handleCureTeam(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const side = this.getSide(player);
    for (const p of side.pokemon) {
      p.status = null;
      p.statusTurns = 0;
    }
  }

  private handleBoost(args: string[], direction: number): void {
    const { player } = parsePokemonIdent(args[0]);
    const stat = args[1] as keyof StatBoosts;
    const amount = parseInt(args[2], 10) * direction;
    const side = this.getSide(player);
    if (side.activePokemon && stat in side.activePokemon.boosts) {
      side.activePokemon.boosts[stat] = Math.max(-6,
        Math.min(6, side.activePokemon.boosts[stat] + amount));
    }
  }

  private handleSetBoost(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const stat = args[1] as keyof StatBoosts;
    const amount = parseInt(args[2], 10);
    const side = this.getSide(player);
    if (side.activePokemon && stat in side.activePokemon.boosts) {
      side.activePokemon.boosts[stat] = amount;
    }
  }

  private handleClearBoost(args: string[]): void {
    if (args[0]) {
      const { player } = parsePokemonIdent(args[0]);
      const side = this.getSide(player);
      if (side.activePokemon) {
        side.activePokemon.boosts = emptyBoosts();
      }
    } else {
      // Clear all boosts on field
      if (this.p1.activePokemon) this.p1.activePokemon.boosts = emptyBoosts();
      if (this.p2.activePokemon) this.p2.activePokemon.boosts = emptyBoosts();
    }
  }

  private handleWeather(args: string[]): void {
    const weather = args[0];
    if (weather === 'none') {
      this.field.weather = null;
      this.field.weatherTurns = 0;
    } else if (args.some(a => a.includes('[upkeep]'))) {
      this.field.weatherTurns++;
    } else {
      this.field.weather = toId(weather);
      this.field.weatherTurns = 0;
    }
  }

  private handleFieldStart(args: string[]): void {
    const condition = toId(args[0].replace('move: ', ''));
    if (condition.includes('terrain')) {
      this.field.terrain = condition;
      this.field.terrainTurns = 0;
    } else if (condition === 'trickroom') {
      this.field.trickRoom = true;
      this.field.trickRoomTurns = 0;
    }
  }

  private handleFieldEnd(args: string[]): void {
    const condition = toId(args[0].replace('move: ', ''));
    if (condition.includes('terrain')) {
      this.field.terrain = null;
      this.field.terrainTurns = 0;
    } else if (condition === 'trickroom') {
      this.field.trickRoom = false;
      this.field.trickRoomTurns = 0;
    }
  }

  private handleSideStart(args: string[]): void {
    const player = args[0].substring(0, 2) as 'p1' | 'p2';
    const condition = toId(args[1].replace('move: ', ''));
    const side = this.getSide(player);

    // Spikes and Toxic Spikes stack layers
    if (condition === 'spikes' || condition === 'toxicspikes') {
      const current = side.sideConditions.get(condition) || 0;
      side.sideConditions.set(condition, current + 1);
    } else {
      side.sideConditions.set(condition, 1);
    }

    // Track tailwind
    if (condition === 'tailwind') {
      this.field.tailwind[player] = 4;
    }
  }

  private handleSideEnd(args: string[]): void {
    const player = args[0].substring(0, 2) as 'p1' | 'p2';
    const condition = toId(args[1].replace('move: ', ''));
    const side = this.getSide(player);
    side.sideConditions.delete(condition);

    if (condition === 'tailwind') {
      this.field.tailwind[player] = 0;
    }
  }

  private handleAbility(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const ability = args[1];
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.knownAbility = ability;
    }
  }

  private handleItem(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const item = args[1];
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.knownItem = item;
    }
  }

  private handleEndItem(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const item = args[1];
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.knownItem = item;
      side.activePokemon.itemConsumed = true;
    }
  }

  private handleVolatileStart(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const volatile = toId(args[1]);
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.volatiles.add(volatile);
    }
  }

  private handleVolatileEnd(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const volatile = toId(args[1]);
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.volatiles.delete(volatile);
    }
  }

  private handleTera(args: string[]): void {
    const { player } = parsePokemonIdent(args[0]);
    const teraType = args[1];
    const side = this.getSide(player);
    if (side.activePokemon) {
      side.activePokemon.terastallized = true;
      side.activePokemon.teraType = teraType;
    }
  }

  // ────────────────────────────────────────
  // Accessors
  // ────────────────────────────────────────

  private getSide(player: 'p1' | 'p2'): SideState {
    return player === 'p1' ? this.p1 : this.p2;
  }

  getMySide(): SideState {
    return this.getSide(this.myPlayer);
  }

  getOpponentSide(): SideState {
    return this.getSide(this.myPlayer === 'p1' ? 'p2' : 'p1');
  }

  getMyActive(): PokemonState | null {
    return this.getMySide().activePokemon;
  }

  getOpponentActive(): PokemonState | null {
    return this.getOpponentSide().activePokemon;
  }

  getSnapshot(): BattleStateSnapshot {
    return {
      turn: this.turn,
      myPlayer: this.myPlayer,
      mySide: this.getMySide(),
      opponentSide: this.getOpponentSide(),
      field: { ...this.field },
      gameOver: this.gameOver,
      winner: this.winner,
      lastMoveByOpponent: this.lastMoveByOpponent,
    };
  }

  getRequest(): BattleRequest | null {
    return this.lastRequest;
  }

  getAvailableMoves(): MoveInfo[] {
    if (!this.lastRequest?.active?.[0]) return [];
    return this.lastRequest.active[0].moves.filter(m => !m.disabled && m.pp > 0);
  }

  getActiveRequest(): ActiveRequest | null {
    return this.lastRequest?.active?.[0] || null;
  }

  getSwitchOptions(): PokemonState[] {
    if (!this.lastRequest?.side) return [];
    return this.getMySide().pokemon.filter(p => !p.fainted && !p.active);
  }

  isForceSwitch(): boolean {
    return this.lastRequest?.forceSwitch?.[0] === true;
  }

  isWaiting(): boolean {
    return this.lastRequest?.wait === true;
  }

  isTeamPreview(): boolean {
    return this.lastRequest?.teamPreview === true;
  }

  isTrapped(): boolean {
    return this.lastRequest?.active?.[0]?.trapped === true;
  }

  canTerastallize(): string | null {
    return this.lastRequest?.active?.[0]?.canTerastallize || null;
  }

  getTurn(): number {
    return this.turn;
  }

  isGameOver(): boolean {
    return this.gameOver;
  }

  getWinner(): string | null {
    return this.winner;
  }

  getMyName(): string {
    return this.myName;
  }

  getMyPlayer(): 'p1' | 'p2' {
    return this.myPlayer;
  }

  /** Get alive (non-fainted) Pokemon count for a side */
  getAliveCount(side: SideState): number {
    // If we haven't seen all pokemon, estimate based on totalPokemon
    const knownAlive = side.pokemon.filter(p => !p.fainted).length;
    const knownFainted = side.pokemon.filter(p => p.fainted).length;
    const unseen = side.totalPokemon - side.pokemon.length;
    return knownAlive + unseen; // Assume unseen pokemon are alive
  }
}
