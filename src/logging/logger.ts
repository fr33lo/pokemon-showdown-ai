import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import {
  BattleLogEntry,
  BattleRecord,
  Decision,
  StrategicState,
} from '../types';

export class BattleLogger {
  private record: BattleRecord;
  private currentTurnMessages: string[] = [];

  constructor(battleId: string, format: string) {
    this.record = {
      battleId,
      format,
      startTime: Date.now(),
      turns: [],
      myTeam: [],
      opponentTeam: [],
    };
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    const dir = CONFIG.logging.dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  setTeams(myTeam: string[], opponentTeam: string[]): void {
    this.record.myTeam = myTeam;
    this.record.opponentTeam = opponentTeam;
  }

  addRawMessage(message: string): void {
    this.currentTurnMessages.push(message);
  }

  logTurn(
    turn: number,
    strategicState?: StrategicState,
    decision?: Decision
  ): void {
    const entry: BattleLogEntry = {
      turn,
      timestamp: Date.now(),
      strategicState,
      decision,
      rawMessages: [...this.currentTurnMessages],
    };
    this.record.turns.push(entry);
    this.currentTurnMessages = [];

    if (CONFIG.logging.verbose) {
      const src = decision?.source ?? '?';
      const choice = decision ? `${decision.type}:${decision.choice}` : 'none';
      const pos = strategicState?.position.score.toFixed(2) ?? '?';
      console.log(`[Turn ${turn}] Decision: ${choice} (${src}) | Position: ${pos}`);
    }
  }

  logResult(winner: string | null, myName: string): void {
    this.record.endTime = Date.now();
    if (winner === null) {
      this.record.result = 'tie';
    } else if (winner === myName) {
      this.record.result = 'win';
    } else {
      this.record.result = 'loss';
    }
  }

  save(): string {
    const filename = `${this.record.battleId.replace(/[^a-zA-Z0-9-]/g, '_')}.json`;
    const filepath = path.join(CONFIG.logging.dir, filename);

    // Convert Maps/Sets to plain objects for JSON serialization
    const serializable = JSON.parse(JSON.stringify(this.record, (_key, value) => {
      if (value instanceof Map) return Object.fromEntries(value);
      if (value instanceof Set) return [...value];
      return value;
    }));

    const data = JSON.stringify(serializable, null, 2);
    // Write asynchronously to avoid blocking the decision loop
    fs.writeFile(filepath, data, (err) => {
      if (err) console.error(`Failed to write battle log: ${err.message}`);
    });
    return filepath;
  }

  getRecord(): BattleRecord {
    return this.record;
  }
}

export function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR: ${message}`);
  if (error instanceof Error) {
    console.error(`  ${error.message}`);
    if (CONFIG.logging.verbose && error.stack) {
      console.error(error.stack);
    }
  }
}

export function logDebug(message: string): void {
  if (CONFIG.logging.verbose) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] DEBUG: ${message}`);
  }
}
