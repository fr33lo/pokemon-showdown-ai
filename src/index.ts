import { CONFIG, validateConfig } from './config';
import { ShowdownClient } from './client/showdown-client';
import { DamageCalculator } from './calculator/damage';
import { InferenceEngine } from './inference/engine';
import { ClaudeEngine } from './ai/claude';
import { BattleOrchestrator } from './battle/orchestrator';
import { requeueDelay } from './behavior/human-like';
import { log, logError } from './logging/logger';

// ============================================================
// Main Application
// ============================================================

class PokemonShowdownAI {
  private client: ShowdownClient;
  private calc: DamageCalculator;
  private inference: InferenceEngine;
  private claude: ClaudeEngine;
  private currentBattle: BattleOrchestrator | null = null;
  private battlesPlayed: number = 0;
  private wins: number = 0;
  private losses: number = 0;
  private ties: number = 0;
  private running: boolean = false;

  constructor() {
    this.client = new ShowdownClient();
    this.calc = new DamageCalculator();
    this.inference = new InferenceEngine();
    this.claude = new ClaudeEngine();
  }

  async start(): Promise<void> {
    // Validate config
    const errors = validateConfig();
    if (errors.length > 0) {
      logError('Configuration errors:');
      for (const e of errors) logError(`  - ${e}`);
      logError('Copy .env.example to .env and fill in your credentials.');
      process.exit(1);
    }

    log('╔══════════════════════════════════════════╗');
    log('║  Pokemon Showdown AI Agent               ║');
    log('║  Powered by Claude                       ║');
    log('╚══════════════════════════════════════════╝');
    log(`Format: ${CONFIG.ps.format}`);
    log(`Auto-queue: ${CONFIG.ps.autoQueue}`);
    log(`Max battles: ${CONFIG.ps.maxBattles || 'unlimited'}`);
    log('');

    this.running = true;

    // Set up event handlers
    this.setupEventHandlers();

    // Connect and login
    try {
      await this.client.connectAndLogin();
      log('Ready! Searching for battle...');
      this.client.searchBattle();
    } catch (e) {
      logError('Failed to connect/login', e);
      process.exit(1);
    }

    // Handle shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private setupEventHandlers(): void {
    // Battle started — concurrency lock: ignore if already in a battle
    this.client.on('battle-start', (battleId: string) => {
      if (this.currentBattle) {
        log(`Already in battle ${this.currentBattle.getBattleId()}, ignoring ${battleId}`);
        return;
      }
      log(`Joining battle: ${battleId}`);
      this.client.joinBattle(battleId);
      this.currentBattle = new BattleOrchestrator(
        battleId, this.client, this.calc, this.inference, this.claude
      );
      // Turn on timer to avoid timeouts
      this.client.sendTimer(battleId, true);
    });

    // Battle messages
    this.client.on('battle-message', async (battleId: string, messages: string[]) => {
      if (!this.currentBattle || this.currentBattle.getBattleId() !== battleId) {
        return;
      }

      try {
        await this.currentBattle.processMessages(messages);
      } catch (e) {
        logError('Error processing battle messages', e);
      }

      // Check if battle ended
      if (this.currentBattle.isGameOver()) {
        await this.handleBattleEnd();
      }
    });

    // Disconnection
    this.client.on('disconnect', () => {
      if (this.running) {
        log('Disconnected, will try to reconnect...');
      }
    });

    // Errors
    this.client.on('error', (err: Error) => {
      logError('Client error', err);
    });
  }

  private async handleBattleEnd(): Promise<void> {
    if (!this.currentBattle) return;

    const result = this.currentBattle.getResult();
    this.battlesPlayed++;
    if (result === 'win') this.wins++;
    else if (result === 'loss') this.losses++;
    else this.ties++;

    log(`Record: ${this.wins}W / ${this.losses}L / ${this.ties}T (${this.battlesPlayed} total)`);

    // Leave the battle room
    this.client.leaveBattle(this.currentBattle.getBattleId());
    this.currentBattle = null;

    // Check if we should queue another battle
    if (!this.running) return;
    if (CONFIG.ps.maxBattles > 0 && this.battlesPlayed >= CONFIG.ps.maxBattles) {
      log(`Reached max battles (${CONFIG.ps.maxBattles}). Stopping.`);
      this.shutdown();
      return;
    }

    if (CONFIG.ps.autoQueue) {
      log('Waiting before next battle...');
      await requeueDelay();
      if (this.running) {
        this.client.searchBattle();
      }
    } else {
      log('Auto-queue disabled. Waiting for manual action.');
    }
  }

  private shutdown(): void {
    if (!this.running) return;
    this.running = false;
    log('Shutting down...');
    log(`Final record: ${this.wins}W / ${this.losses}L / ${this.ties}T`);
    this.client.disconnect();
    process.exit(0);
  }
}

// ============================================================
// Entry Point
// ============================================================

const ai = new PokemonShowdownAI();
ai.start().catch((e) => {
  logError('Fatal error', e);
  process.exit(1);
});
