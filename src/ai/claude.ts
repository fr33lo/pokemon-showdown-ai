import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config';
import {
  Decision,
  BattleStateSnapshot,
  MoveInfo,
  PokemonState,
  StrategicState,
  DamageMatchup,
} from '../types';
import { InferenceEngine } from '../inference/engine';
import { formatStrategicSummary } from '../strategy/evaluation';
import { log, logError, logDebug } from '../logging/logger';

export class ClaudeEngine {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: CONFIG.claude.apiKey });
  }

  /**
   * Ask Claude to make a strategic decision.
   * Provides full battle context with strategic evaluation and inference data.
   */
  async decide(
    state: BattleStateSnapshot,
    strategic: StrategicState,
    matchup: DamageMatchup,
    availableMoves: MoveInfo[],
    switchOptions: PokemonState[],
    inference: InferenceEngine
  ): Promise<Decision | null> {
    const prompt = this.buildPrompt(state, strategic, matchup, availableMoves, switchOptions, inference);

    try {
      logDebug('Calling Claude for decision...');

      // Race the API call against an 8-second timeout to avoid exceeding the turn timer
      const apiCall = this.client.messages.create({
        model: CONFIG.claude.model,
        max_tokens: CONFIG.claude.maxTokens,
        system: 'You are a competitive Pokemon battle AI. Respond with EXACTLY one line: either "MOVE: movename" or "SWITCH: pokemonname". No explanations.',
        messages: [{ role: 'user', content: prompt }],
      });
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
      const response = await Promise.race([apiCall, timeout]);

      if (!response) {
        logError('Claude API call timed out (8s), falling back to heuristics');
        return null;
      }

      const text = response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';

      logDebug(`Claude response: ${text}`);
      return this.parseResponse(text, availableMoves, switchOptions, state);
    } catch (e) {
      logError('Claude API call failed', e);
      return null;
    }
  }

  private buildPrompt(
    state: BattleStateSnapshot,
    strategic: StrategicState,
    matchup: DamageMatchup,
    availableMoves: MoveInfo[],
    switchOptions: PokemonState[],
    inference: InferenceEngine
  ): string {
    const myActive = state.mySide.activePokemon;
    const oppActive = state.opponentSide.activePokemon;
    if (!myActive || !oppActive) return '';

    const lines: string[] = [];

    // Turn info
    lines.push(`Turn: ${state.turn}`);
    lines.push('');

    // Active Pokemon
    lines.push(`My Active: ${myActive.name} (${myActive.hpPercent.toFixed(0)}%)`);
    if (myActive.status) lines.push(`  Status: ${myActive.status}`);
    if (myActive.boosts.atk !== 0 || myActive.boosts.spa !== 0 || myActive.boosts.spe !== 0) {
      const boosts = [];
      if (myActive.boosts.atk) boosts.push(`+${myActive.boosts.atk} Atk`);
      if (myActive.boosts.spa) boosts.push(`+${myActive.boosts.spa} SpA`);
      if (myActive.boosts.spe) boosts.push(`+${myActive.boosts.spe} Spe`);
      lines.push(`  Boosts: ${boosts.join(', ')}`);
    }

    lines.push(`Opponent Active: ${oppActive.name} (${oppActive.hpPercent.toFixed(0)}%)`);
    if (oppActive.status) lines.push(`  Status: ${oppActive.status}`);
    lines.push('');

    // Strategic summary
    lines.push(formatStrategicSummary(strategic));
    lines.push('');

    // Inference data
    const inferenceStr = inference.formatForClaude(state);
    if (inferenceStr) {
      lines.push(inferenceStr);
      lines.push('');
    }

    // Damage calculations
    if (matchup.myAttacking.length > 0) {
      lines.push('My damage to opponent:');
      for (const d of matchup.myAttacking.slice(0, 4)) {
        const koTag = d.isOHKO ? ' [KO]' : d.is2HKO ? ' [2HKO]' : '';
        lines.push(`  ${d.move}: ${d.minPercent.toFixed(0)}-${d.maxPercent.toFixed(0)}%${koTag}`);
      }
    }

    if (matchup.oppAttacking.length > 0) {
      lines.push('Opponent damage to me:');
      for (const d of matchup.oppAttacking.slice(0, 4)) {
        const koTag = d.isOHKO ? ' [KO]' : d.is2HKO ? ' [2HKO]' : '';
        lines.push(`  ${d.move}: ${d.minPercent.toFixed(0)}-${d.maxPercent.toFixed(0)}%${koTag}`);
      }
    }
    lines.push('');

    // Available moves
    lines.push('Available Moves:');
    for (const m of availableMoves) {
      if (!m.disabled && m.pp > 0) {
        lines.push(`  ${m.id} (${m.pp}/${m.maxpp} PP)`);
      }
    }

    // Switch options
    if (switchOptions.length > 0) {
      lines.push('Switch Options:');
      for (const p of switchOptions) {
        const status = p.status ? ` [${p.status}]` : '';
        lines.push(`  ${p.name} (${p.hpPercent.toFixed(0)}%${status})`);
      }
    }

    // Sack order (so Claude knows which Pokemon to preserve)
    if (strategic.sackOrder.length > 1) {
      lines.push('Sack Priority (sacrifice first → preserve):');
      lines.push(`  ${strategic.sackOrder.map(s => `${s.pokemon}(${s.preservationScore.toFixed(2)})`).join(' → ')}`);
    }

    // Field conditions
    const fieldInfo: string[] = [];
    if (state.field.weather) fieldInfo.push(`Weather: ${state.field.weather}`);
    if (state.field.terrain) fieldInfo.push(`Terrain: ${state.field.terrain}`);
    if (state.field.trickRoom) fieldInfo.push('Trick Room active');
    if (state.mySide.sideConditions.size > 0) {
      fieldInfo.push(`My hazards: ${[...state.mySide.sideConditions.keys()].join(', ')}`);
    }
    if (state.opponentSide.sideConditions.size > 0) {
      fieldInfo.push(`Opp hazards: ${[...state.opponentSide.sideConditions.keys()].join(', ')}`);
    }
    if (fieldInfo.length > 0) {
      lines.push('');
      lines.push('Field:');
      for (const f of fieldInfo) lines.push(`  ${f}`);
    }

    return lines.join('\n');
  }

  private parseResponse(
    text: string,
    availableMoves: MoveInfo[],
    switchOptions: PokemonState[],
    state: BattleStateSnapshot
  ): Decision | null {
    const upper = text.toUpperCase().trim();

    // Parse "MOVE: movename"
    const moveMatch = upper.match(/^MOVE:\s*(.+)$/);
    if (moveMatch) {
      const moveName = moveMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      const moveIdx = availableMoves.findIndex(
        m => m.id.replace(/[^a-z0-9]/g, '') === moveName && !m.disabled && m.pp > 0
      );
      if (moveIdx !== -1) {
        return {
          type: 'move',
          choice: availableMoves[moveIdx].id,
          moveIndex: moveIdx + 1,
          source: 'claude',
          confidence: 0.85,
          reasoning: `Claude chose ${availableMoves[moveIdx].id}`,
        };
      }
    }

    // Parse "SWITCH: pokemonname"
    const switchMatch = upper.match(/^SWITCH:\s*(.+)$/);
    if (switchMatch) {
      const pokeName = switchMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      const switchMon = switchOptions.find(
        p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '') === pokeName ||
             p.species === pokeName
      );
      if (switchMon) {
        const switchIdx = state.mySide.pokemon.findIndex(p => p.species === switchMon.species) + 1;
        return {
          type: 'switch',
          choice: switchMon.name.toLowerCase(),
          switchIndex: switchIdx,
          source: 'claude',
          confidence: 0.85,
          reasoning: `Claude chose to switch to ${switchMon.name}`,
        };
      }
    }

    logError(`Failed to parse Claude response: "${text}"`);
    return null;
  }
}
