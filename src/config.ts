import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Pokemon Showdown connection
  ps: {
    server: process.env.PS_SERVER || 'wss://sim3.psim.us/showdown/websocket',
    loginUrl: 'https://play.pokemonshowdown.com/api/login',
    username: process.env.PS_USERNAME || '',
    password: process.env.PS_PASSWORD || '',
    format: process.env.BATTLE_FORMAT || 'gen9randombattle',
    autoQueue: process.env.AUTO_QUEUE !== 'false',
    maxBattles: parseInt(process.env.MAX_BATTLES || '0', 10),
  },

  // Anthropic API
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 50,
  },

  // Human-like behavior
  behavior: {
    turnDelayMin: 1500,   // ms
    turnDelayMax: 4000,   // ms
    imperfectPlayRate: 0.02,
    requeueDelayMin: 10000, // ms
    requeueDelayMax: 25000, // ms
  },

  // Strategic evaluation weights
  strategy: {
    threatWeights: {
      speedThreat: 0.25,
      damageThreat: 0.35,
      setupPotential: 0.25,
      defensiveWallValue: 0.15,
    },
    positionWeights: {
      pokemonAdvantage: 0.20,
      hpAdvantage: 0.15,
      hazardAdvantage: 0.10,
      speedAdvantage: 0.15,
      typeMatchupAdvantage: 0.15,
      statusAdvantage: 0.10,
      winConditionViability: 0.15,
    },
  },

  // Damage calculation
  calc: {
    cacheSize: 2048,
    generation: 9,
  },

  // Inference engine
  inference: {
    maxSetsPerPokemon: 5,
  },

  // Logging
  logging: {
    dir: './logs',
    verbose: process.env.VERBOSE === 'true',
  },
} as const;

export function validateConfig(): string[] {
  const errors: string[] = [];
  if (!CONFIG.ps.username) errors.push('PS_USERNAME is required');
  if (!CONFIG.ps.password) errors.push('PS_PASSWORD is required');
  if (!CONFIG.claude.apiKey) errors.push('ANTHROPIC_API_KEY is required');
  return errors;
}
