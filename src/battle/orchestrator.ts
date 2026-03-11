import { BattleState } from './state';
import { ShowdownClient } from '../client/showdown-client';
import { DamageCalculator } from '../calculator/damage';
import { InferenceEngine } from '../inference/engine';
import { evaluateStrategicState } from '../strategy/evaluation';
import { heuristicDecision } from '../heuristics/engine';
import { ClaudeEngine } from '../ai/claude';
import { BattleLogger, log, logError, logDebug } from '../logging/logger';
import { turnDelay, maybeImperfectPlay } from '../behavior/human-like';
import { Decision, MoveInfo } from '../types';
import { CONFIG } from '../config';

/**
 * Orchestrates a single battle from start to finish.
 * Processes messages, runs the per-turn decision pipeline,
 * and executes commands on the Showdown client.
 */
export class BattleOrchestrator {
  private battleId: string;
  private state: BattleState;
  private client: ShowdownClient;
  private calc: DamageCalculator;
  private inference: InferenceEngine;
  private claude: ClaudeEngine;
  private logger: BattleLogger;
  private pendingDecision: boolean = false;
  private turnProcessed: number = -1;
  private lastRequestId: number = -1;

  constructor(
    battleId: string,
    client: ShowdownClient,
    calc: DamageCalculator,
    inference: InferenceEngine,
    claude: ClaudeEngine
  ) {
    this.battleId = battleId;
    this.client = client;
    this.calc = calc;
    this.inference = inference;
    this.claude = claude;
    this.state = new BattleState(CONFIG.ps.username);
    this.logger = new BattleLogger(battleId, CONFIG.ps.format);

    // Clear caches for new battle
    this.calc.clearCache();
    this.inference.reset();
  }

  /**
   * Process incoming battle messages from the server.
   * Called by the main event handler when messages arrive.
   */
  async processMessages(messages: string[]): Promise<void> {
    // Feed messages to state engine
    this.state.processMessages(messages);

    // Log raw messages
    for (const msg of messages) {
      this.logger.addRawMessage(msg);
    }

    // Check for game over
    if (this.state.isGameOver()) {
      this.handleGameOver();
      return;
    }

    // Check if we need to make a decision
    const request = this.state.getRequest();
    if (!request || this.state.isWaiting()) return;

    // Handle team preview (just pick default order in randbats)
    if (this.state.isTeamPreview()) {
      this.client.sendBattleCommand(this.battleId, '/choose default');
      return;
    }

    // Avoid processing the same request twice (rqid is unique per request)
    const currentTurn = this.state.getTurn();
    const rqid = request.rqid || 0;
    if (this.pendingDecision) return;
    if (rqid > 0 && rqid <= this.lastRequestId) return;

    // Check if we need to act (force switch or regular turn)
    const needsAction = this.state.isForceSwitch() ||
      (request.active && currentTurn > this.turnProcessed);

    if (!needsAction) return;

    this.pendingDecision = true;
    try {
      await this.makeTurnDecision();
      this.turnProcessed = currentTurn;
      this.lastRequestId = rqid;
    } catch (e) {
      logError('Error in turn decision', e);
      this.fallbackAction();
    } finally {
      this.pendingDecision = false;
    }
  }

  /**
   * The main per-turn decision pipeline:
   * 1. Update state
   * 2. Calculate damage
   * 3. Update inference
   * 4. Run strategic evaluation
   * 5. Try heuristics
   * 6. If needed, call Claude
   * 7. Apply human-like delay
   * 8. Execute decision
   */
  private async makeTurnDecision(): Promise<void> {
    const snapshot = this.state.getSnapshot();
    const availableMoves = this.state.getAvailableMoves();
    const switchOptions = this.state.getSwitchOptions();

    // Update teams for logging
    this.logger.setTeams(
      snapshot.mySide.pokemon.map(p => p.name),
      snapshot.opponentSide.pokemon.map(p => p.name)
    );

    // Step 2: Update inference engine
    this.inference.update(snapshot);

    // Process special inference observations (Life Orb recoil, hazard immunity)
    const dmgSrc = this.state.getLastDamageSource();
    if (dmgSrc) {
      const itemId = dmgSrc.item.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (itemId === 'lifeorb' && dmgSrc.player !== this.state.getMyPlayer()) {
        const oppActive = snapshot.opponentSide.activePokemon;
        if (oppActive) this.inference.observeRecoil(oppActive.species);
      }
    }

    // Heavy-Duty Boots inference: opponent switched in over hazards without chip
    const hazardCheck = this.state.consumeHazardCheck();
    if (hazardCheck && !hazardCheck.tookDamage) {
      this.inference.observeNoHazardDamage(hazardCheck.species);
    }

    // Step 3: Calculate damage matchups
    const inferredMoves = this.inference.getActiveOpponentMoves(snapshot);
    const matchup = this.calc.calcMatchup(snapshot, availableMoves, inferredMoves);

    // Step 4: Strategic evaluation
    const strategic = evaluateStrategicState(snapshot, this.state, this.calc, this.inference);

    // Step 5: Try heuristics
    let decision = heuristicDecision(
      snapshot, this.state, matchup, strategic,
      availableMoves, switchOptions, this.calc, this.inference
    );

    // Step 6: If heuristics didn't resolve, call Claude
    if (!decision) {
      logDebug('Heuristics inconclusive, calling Claude...');
      decision = await this.claude.decide(
        snapshot, strategic, matchup,
        availableMoves, switchOptions, this.inference
      );
    }

    // Step 7: Final fallback — pick highest damage move
    if (!decision) {
      decision = this.emergencyFallback(availableMoves, switchOptions, snapshot);
    }

    // Apply imperfect play (human-like)
    decision = maybeImperfectPlay(
      decision,
      availableMoves,
      switchOptions.map(p => p.name)
    );

    // Log the decision
    this.logger.logTurn(snapshot.turn, strategic, decision);

    // Step 8: Human-like delay then execute
    await turnDelay();
    this.executeDecision(decision);
  }

  /**
   * Execute a decision on the Showdown client.
   */
  private executeDecision(decision: Decision): void {
    log(`[Turn ${this.state.getTurn()}] ${decision.source}: ${decision.type} ${decision.choice}`);

    if (decision.type === 'move' && decision.moveIndex != null && decision.moveIndex > 0) {
      let extra = '';
      if (decision.terastallize) extra = 'terastallize';
      else if (decision.mega) extra = 'mega';
      this.client.chooseMove(this.battleId, decision.moveIndex, extra || undefined);
    } else if (decision.type === 'switch' && decision.switchIndex != null && decision.switchIndex > 0) {
      this.client.chooseSwitch(this.battleId, decision.switchIndex);
    } else {
      logError(`Invalid decision: ${JSON.stringify(decision)}`);
      this.client.chooseDefault(this.battleId);
    }
  }

  /**
   * Emergency fallback: pick the highest damage move or first available switch.
   */
  private emergencyFallback(
    moves: MoveInfo[],
    switches: any[],
    snapshot: any
  ): Decision {
    logDebug('Using emergency fallback');

    const usable = moves.filter(m => !m.disabled && m.pp > 0);
    if (usable.length > 0) {
      return {
        type: 'move',
        choice: usable[0].id,
        moveIndex: moves.indexOf(usable[0]) + 1,
        source: 'random',
        confidence: 0.1,
        reasoning: 'Emergency fallback: first available move',
      };
    }

    if (switches.length > 0) {
      const sidePokemons = snapshot.mySide.pokemon;
      const switchIdx = sidePokemons.findIndex(
        (p: any) => p.species === switches[0].species
      ) + 1;
      return {
        type: 'switch',
        choice: switches[0].name?.toLowerCase() || 'unknown',
        switchIndex: switchIdx,
        source: 'random',
        confidence: 0.1,
        reasoning: 'Emergency fallback: first available switch',
      };
    }

    // Absolute last resort
    return {
      type: 'move',
      choice: 'default',
      moveIndex: 1,
      source: 'random',
      confidence: 0,
      reasoning: 'No options available',
    };
  }

  /**
   * Fallback action when an error occurs during decision-making.
   */
  private fallbackAction(): void {
    this.client.chooseDefault(this.battleId);
  }

  /**
   * Handle game over: log result, save battle log.
   */
  private handleGameOver(): void {
    const winner = this.state.getWinner();
    const myName = this.state.getMyName();
    const result = winner === myName ? 'WON' : winner === null ? 'TIE' : 'LOST';

    log(`Battle ${this.battleId} ended: ${result}`);
    this.logger.logResult(winner, myName);

    const logPath = this.logger.save();
    log(`Battle log saved to ${logPath}`);
  }

  /** Check if the battle is over */
  isGameOver(): boolean {
    return this.state.isGameOver();
  }

  /** Get the battle result */
  getResult(): 'win' | 'loss' | 'tie' | null {
    if (!this.state.isGameOver()) return null;
    const winner = this.state.getWinner();
    if (winner === null) return 'tie';
    return winner === this.state.getMyName() ? 'win' : 'loss';
  }

  getBattleId(): string {
    return this.battleId;
  }
}
