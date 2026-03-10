// ============================================================
// Core Battle Types
// ============================================================

export interface PokemonState {
  name: string;          // Display name (e.g. "Excadrill")
  species: string;       // Species ID (e.g. "excadrill")
  level: number;
  gender: string;        // 'M' | 'F' | 'N'
  hp: number;            // Current HP (absolute for own side, percent for opponent)
  maxHp: number;         // Max HP (absolute for own side, 100 for opponent)
  hpPercent: number;     // HP as percentage 0-100
  status: StatusCondition | null;
  statusTurns: number;
  active: boolean;
  fainted: boolean;
  stats: BaseStats;
  moves: string[];       // All known moves (IDs)
  knownMoves: string[];  // Moves revealed in battle
  ability: string;       // Base ability from team data
  knownAbility: string | null; // Ability revealed in battle
  item: string;          // Item from team data
  knownItem: string | null;    // Item revealed in battle
  itemConsumed: boolean;
  teraType: string | null;
  terastallized: boolean;
  boosts: StatBoosts;
  volatiles: Set<string>;
}

export interface BaseStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface StatBoosts {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
  accuracy: number;
  evasion: number;
}

export type StatusCondition = 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';

export interface MoveInfo {
  id: string;
  name: string;
  pp: number;
  maxpp: number;
  disabled: boolean;
  target: string;
}

// ============================================================
// Battle Field State
// ============================================================

export interface SideState {
  name: string;
  id: 'p1' | 'p2';
  pokemon: PokemonState[];
  activePokemon: PokemonState | null;
  totalPokemon: number;
  sideConditions: Map<string, number>;
  // Common side conditions: stealthrock, spikes (layers), toxicspikes (layers),
  // stickyweb, reflect (turns), lightscreen (turns), auroraveil (turns)
}

export interface FieldState {
  weather: string | null;
  weatherTurns: number;
  terrain: string | null;
  terrainTurns: number;
  trickRoom: boolean;
  trickRoomTurns: number;
  tailwind: { p1: number; p2: number };
}

export interface BattleStateSnapshot {
  turn: number;
  myPlayer: 'p1' | 'p2';
  mySide: SideState;
  opponentSide: SideState;
  field: FieldState;
  gameOver: boolean;
  winner: string | null;
  lastMoveByOpponent: string | null;
}

// ============================================================
// Battle Request (from PS server)
// ============================================================

export interface BattleRequest {
  active?: ActiveRequest[];
  side: SideRequest;
  forceSwitch?: boolean[];
  wait?: boolean;
  rqid: number;
  teamPreview?: boolean;
}

export interface ActiveRequest {
  moves: MoveInfo[];
  canTerastallize?: string;
  trapped?: boolean;
  maybeTrapped?: boolean;
  canMegaEvo?: boolean;
}

export interface SideRequest {
  name: string;
  id: string;
  pokemon: SidePokemonData[];
}

export interface SidePokemonData {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  stats: BaseStats;
  moves: string[];
  baseAbility: string;
  item: string;
  pokeball: string;
  ability: string;
  teraType?: string;
}

// ============================================================
// Decision Types
// ============================================================

export interface Decision {
  type: 'move' | 'switch';
  choice: string;
  moveIndex?: number;
  switchIndex?: number;
  terastallize?: boolean;
  mega?: boolean;
  source: 'heuristic' | 'claude' | 'random';
  confidence: number;
  reasoning?: string;
}

// ============================================================
// Strategic Evaluation Types
// ============================================================

export interface WinCondition {
  pokemon: string;
  score: number;
  requiresSetup: boolean;
  threatsRemaining: string[];
}

export interface ThreatAssessment {
  pokemon: string;
  score: number;
  speedThreat: number;
  damageThreat: number;
  setupPotential: number;
  defensiveWallValue: number;
}

export interface PositionEvaluation {
  score: number; // -1.0 to +1.0
  factors: {
    pokemonAdvantage: number;
    hpAdvantage: number;
    hazardAdvantage: number;
    speedAdvantage: number;
    typeMatchupAdvantage: number;
    statusAdvantage: number;
    winConditionViability: number;
  };
}

export interface SackOrderEntry {
  pokemon: string;
  preservationScore: number;
}

export interface StrategicState {
  winConditions: WinCondition[];
  threats: ThreatAssessment[];
  position: PositionEvaluation;
  sackOrder: SackOrderEntry[];
}

// ============================================================
// Damage Calculation Types
// ============================================================

export interface DamageResult {
  move: string;
  attacker: string;
  defender: string;
  minDamage: number;
  maxDamage: number;
  minPercent: number;
  maxPercent: number;
  isOHKO: boolean;
  is2HKO: boolean;
  priority: number;
}

export interface DamageMatchup {
  myAttacking: DamageResult[];   // My active -> opponent active
  oppAttacking: DamageResult[];  // Opponent active -> my active
}

// ============================================================
// Inference Types
// ============================================================

export interface RandomBattleSetEntry {
  moves: string[];
  ability: string;
  item: string;
  role: string;
}

export interface RandomBattleData {
  pokemon: string;
  sets: RandomBattleSetEntry[];
}

export interface InferredSet {
  moves: string[];
  ability: string;
  item: string;
  role: string;
  probability: number;
}

export interface InferredInfo {
  pokemon: string;
  possibleSets: InferredSet[];
  likelyMoves: Map<string, number>;
  likelyAbility: Map<string, number>;
  likelyItem: Map<string, number>;
}

// ============================================================
// Logging Types
// ============================================================

export interface BattleLogEntry {
  turn: number;
  timestamp: number;
  strategicState?: StrategicState;
  decision?: Decision;
  rawMessages?: string[];
}

export interface BattleRecord {
  battleId: string;
  format: string;
  startTime: number;
  endTime?: number;
  result?: 'win' | 'loss' | 'tie';
  turns: BattleLogEntry[];
  myTeam: string[];
  opponentTeam: string[];
}
