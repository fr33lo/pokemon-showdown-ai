/**
 * Headless Integration Smoke Test
 * Simulates a 20-turn Random Battle using mock PS protocol messages.
 *
 * Verifies:
 * - Correct move/switch sent each turn
 * - No double-sends per turn
 * - No crashes on faint/switch/win messages
 * - Claude called only when heuristics fail
 * - Inference state updates correctly
 *
 * Run with: npx ts-node tests/integration-smoke.test.ts
 */

import { BattleState } from '../src/battle/state';
import { DamageCalculator } from '../src/calculator/damage';
import { InferenceEngine } from '../src/inference/engine';
import { evaluateStrategicState } from '../src/strategy/evaluation';
import { heuristicDecision } from '../src/heuristics/engine';

// ============================================================
// Mock Battle Protocol Messages
// ============================================================

const MOCK_INIT_MESSAGES = [
  '|player|p1|TestBot|1',
  '|player|p2|Opponent|2',
  '|teamsize|p1|6',
  '|teamsize|p2|6',
  '|gametype|singles',
  '|gen|9',
  '|tier|[Gen 9] Random Battle',
];

const MOCK_REQUEST_TURN1 = JSON.stringify({
  active: [{
    moves: [
      { id: 'earthquake', name: 'Earthquake', pp: 16, maxpp: 16, disabled: false, target: 'normal' },
      { id: 'swordsdance', name: 'Swords Dance', pp: 32, maxpp: 32, disabled: false, target: 'self' },
      { id: 'ironhead', name: 'Iron Head', pp: 24, maxpp: 24, disabled: false, target: 'normal' },
      { id: 'rapidspin', name: 'Rapid Spin', pp: 64, maxpp: 64, disabled: false, target: 'normal' },
    ],
    canTerastallize: 'Steel',
  }],
  side: {
    name: 'TestBot',
    id: 'p1',
    pokemon: [
      { ident: 'p1: Excadrill', details: 'Excadrill, L80, M', condition: '269/269', active: true, stats: { hp: 269, atk: 282, def: 148, spa: 118, spd: 160, spe: 196 }, moves: ['earthquake', 'swordsdance', 'ironhead', 'rapidspin'], baseAbility: 'moldbreaker', item: 'leftovers', ability: 'moldbreaker', pokeball: 'pokeball', teraType: 'Steel' },
      { ident: 'p1: Toxapex', details: 'Toxapex, L80, F', condition: '237/237', active: false, stats: { hp: 237, atk: 83, def: 288, spa: 127, spd: 288, spe: 67 }, moves: ['scald', 'recover', 'haze', 'toxicspikes'], baseAbility: 'regenerator', item: 'rockyhelmet', ability: 'regenerator', pokeball: 'pokeball', teraType: 'Water' },
      { ident: 'p1: Dragonite', details: 'Dragonite, L76, M', condition: '260/260', active: false, stats: { hp: 260, atk: 253, def: 170, spa: 180, spd: 180, spe: 148 }, moves: ['dragondance', 'extremespeed', 'earthquake', 'outrage'], baseAbility: 'multiscale', item: 'heavydutyboots', ability: 'multiscale', pokeball: 'pokeball', teraType: 'Normal' },
      { ident: 'p1: Corviknight', details: 'Corviknight, L80, F', condition: '280/280', active: false, stats: { hp: 280, atk: 195, def: 231, spa: 127, spd: 215, spe: 171 }, moves: ['bravebird', 'uturn', 'defog', 'roost'], baseAbility: 'pressure', item: 'leftovers', ability: 'pressure', pokeball: 'pokeball', teraType: 'Flying' },
      { ident: 'p1: Gengar', details: 'Gengar, L80, M', condition: '218/218', active: false, stats: { hp: 218, atk: 83, def: 148, spa: 270, spd: 163, spe: 228 }, moves: ['shadowball', 'sludgebomb', 'focusblast', 'trick'], baseAbility: 'cursedbody', item: 'choicescarf', ability: 'cursedbody', pokeball: 'pokeball', teraType: 'Ghost' },
      { ident: 'p1: Azumarill', details: 'Azumarill, L84, F', condition: '313/313', active: false, stats: { hp: 313, atk: 120, def: 170, spa: 148, spd: 170, spe: 120 }, moves: ['playrough', 'aquajet', 'bellydrum', 'knockoff'], baseAbility: 'hugepower', item: 'sitrusberry', ability: 'hugepower', pokeball: 'pokeball', teraType: 'Water' },
    ],
  },
  rqid: 1,
});

// Generate mock turns
function generateTurnMessages(turn: number): string[] {
  const messages: string[] = [];

  if (turn === 1) {
    messages.push(
      '|switch|p1a: Excadrill|Excadrill, L80, M|269/269',
      '|switch|p2a: Garchomp|Garchomp, L78, M|100/100',
      '|turn|1',
    );
  } else if (turn === 2) {
    messages.push(
      '|move|p1a: Excadrill|Earthquake|p2a: Garchomp',
      '|-damage|p2a: Garchomp|45/100',
      '|move|p2a: Garchomp|Earthquake|p1a: Excadrill',
      '|-damage|p1a: Excadrill|180/269',
      '|turn|2',
    );
  } else if (turn === 3) {
    messages.push(
      '|move|p2a: Garchomp|Stone Edge|p1a: Excadrill',
      '|-damage|p1a: Excadrill|90/269',
      '|move|p1a: Excadrill|Iron Head|p2a: Garchomp',
      '|-damage|p2a: Garchomp|20/100',
      '|turn|3',
    );
  } else if (turn === 4) {
    messages.push(
      '|move|p1a: Excadrill|Earthquake|p2a: Garchomp',
      '|-damage|p2a: Garchomp|0 fnt',
      '|faint|p2a: Garchomp',
      '|',
    );
  } else if (turn === 5) {
    // Opponent switches in after faint
    messages.push(
      '|switch|p2a: Toxapex|Toxapex, L80, F|100/100',
      '|turn|5',
    );
  } else if (turn === 6) {
    messages.push(
      '|move|p1a: Excadrill|Earthquake|p2a: Toxapex',
      '|-damage|p2a: Toxapex|60/100',
      '|move|p2a: Toxapex|Scald|p1a: Excadrill',
      '|-damage|p1a: Excadrill|30/269',
      '|turn|6',
    );
  } else if (turn === 7) {
    messages.push(
      '|move|p2a: Toxapex|Recover||[still]',
      '|-heal|p2a: Toxapex|100/100',
      '|move|p1a: Excadrill|Earthquake|p2a: Toxapex',
      '|-damage|p2a: Toxapex|60/100',
      '|turn|7',
    );
  } else if (turn === 8) {
    // Excadrill faints
    messages.push(
      '|move|p2a: Toxapex|Scald|p1a: Excadrill',
      '|-damage|p1a: Excadrill|0 fnt',
      '|faint|p1a: Excadrill',
      '|',
    );
  } else if (turn === 9) {
    // Force switch after faint
    messages.push(
      '|switch|p1a: Dragonite|Dragonite, L76, M|260/260',
      '|-ability|p1a: Dragonite|Multiscale',
      '|turn|9',
    );
  } else if (turn === 10) {
    messages.push(
      '|move|p1a: Dragonite|Dragon Dance||[still]',
      '|-boost|p1a: Dragonite|atk|1',
      '|-boost|p1a: Dragonite|spe|1',
      '|move|p2a: Toxapex|Haze',
      '|-clearallboost',
      '|turn|10',
    );
  } else if (turn >= 11 && turn <= 18) {
    // Generic turns of back-and-forth
    messages.push(
      `|move|p1a: Dragonite|Extreme Speed|p2a: Toxapex`,
      `|-damage|p2a: Toxapex|${Math.max(10, 100 - turn * 5)}/100`,
      `|move|p2a: Toxapex|Scald|p1a: Dragonite`,
      `|-damage|p1a: Dragonite|${Math.max(50, 260 - turn * 15)}/260`,
      `|turn|${turn}`,
    );
  } else if (turn === 19) {
    messages.push(
      '|move|p1a: Dragonite|Extreme Speed|p2a: Toxapex',
      '|-damage|p2a: Toxapex|0 fnt',
      '|faint|p2a: Toxapex',
    );
  } else if (turn === 20) {
    messages.push(
      '|win|TestBot',
    );
  }

  return messages;
}

// ============================================================
// Test Runner
// ============================================================

async function runSmokeTest(): Promise<void> {
  console.log('=== Integration Smoke Test ===\n');

  const state = new BattleState('TestBot');
  const calc = new DamageCalculator();
  const inference = new InferenceEngine();
  const errors: string[] = [];
  const decisions: Array<{ turn: number; decision: any }> = [];
  let claudeCallCount = 0;

  // Process init messages
  state.processMessages(MOCK_INIT_MESSAGES);

  // Process request
  state.processMessages([`|request|${MOCK_REQUEST_TURN1}`]);

  // Simulate 20 turns
  for (let turn = 1; turn <= 20; turn++) {
    const msgs = generateTurnMessages(turn);
    state.processMessages(msgs);

    // Check game over
    if (state.isGameOver()) {
      console.log(`  Turn ${turn}: Game over — Winner: ${state.getWinner()}`);
      break;
    }

    // Skip turns that don't need decisions (faint turns handled by forceSwitch)
    if (state.isWaiting()) continue;

    const snapshot = state.getSnapshot();
    if (!snapshot.mySide.activePokemon || !snapshot.opponentSide.activePokemon) continue;

    // Update inference
    inference.update(snapshot);

    // Get available options
    const availableMoves = state.getAvailableMoves();
    const switchOptions = state.getSwitchOptions();

    if (availableMoves.length === 0 && !state.isForceSwitch()) continue;

    // Calc matchup
    const inferredMoves = inference.getActiveOpponentMoves(snapshot);
    const matchup = calc.calcMatchup(snapshot, availableMoves, inferredMoves);

    // Strategic evaluation
    const strategic = evaluateStrategicState(snapshot, state, calc, inference);

    // Test: opponentIsStall field exists
    if (typeof strategic.opponentIsStall !== 'boolean') {
      errors.push(`Turn ${turn}: opponentIsStall not a boolean`);
    }

    // Heuristic decision
    const decision = heuristicDecision(
      snapshot, state, matchup, strategic,
      availableMoves, switchOptions, calc, inference
    );

    if (decision) {
      decisions.push({ turn, decision });

      // Validate decision
      if (decision.type === 'move') {
        if (!decision.moveIndex || decision.moveIndex < 1 || decision.moveIndex > 4) {
          errors.push(`Turn ${turn}: Invalid moveIndex ${decision.moveIndex}`);
        }
        if (!decision.choice) {
          errors.push(`Turn ${turn}: Move decision has no choice`);
        }
      } else if (decision.type === 'switch') {
        if (!decision.switchIndex || decision.switchIndex < 1) {
          errors.push(`Turn ${turn}: Invalid switchIndex ${decision.switchIndex}`);
        }
      }

      console.log(`  Turn ${turn}: ${decision.source} → ${decision.type}:${decision.choice} (conf: ${decision.confidence.toFixed(2)})`);
    } else {
      claudeCallCount++;
      console.log(`  Turn ${turn}: Heuristics inconclusive → Claude would be called`);
    }

    // Verify inference state updates
    const allInferred = inference.getAllInferredInfo();
    if (turn > 2 && allInferred.size === 0) {
      errors.push(`Turn ${turn}: No inference data after seeing opponent Pokemon`);
    }
  }

  // Final checks
  console.log('\n=== Results ===');
  console.log(`Total decisions: ${decisions.length}`);
  console.log(`Claude calls needed: ${claudeCallCount}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log('\nERRORS:');
    for (const e of errors) console.log(`  - ${e}`);
    console.log('\nSMOKE TEST: FAILED');
    process.exit(1);
  } else {
    // Verify key invariants
    const checks: string[] = [];

    // Check: no double-sends (each turn produces at most 1 decision)
    const turnCounts = new Map<number, number>();
    for (const d of decisions) {
      turnCounts.set(d.turn, (turnCounts.get(d.turn) || 0) + 1);
    }
    for (const [t, c] of turnCounts) {
      if (c > 1) checks.push(`Turn ${t}: ${c} decisions (expected 1)`);
    }

    // Check: game ended correctly
    if (!state.isGameOver()) {
      checks.push('Game did not end');
    } else if (state.getWinner() !== 'TestBot') {
      checks.push(`Wrong winner: ${state.getWinner()}`);
    }

    // Check: inference tracked opponent Pokemon
    const inferredGarchomp = inference.getInferredInfo('garchomp');
    if (!inferredGarchomp) {
      checks.push('No inference data for Garchomp');
    }

    if (checks.length > 0) {
      console.log('\nINVARIANT CHECKS FAILED:');
      for (const c of checks) console.log(`  - ${c}`);
      console.log('\nSMOKE TEST: FAILED');
      process.exit(1);
    }

    console.log('\nAll invariants passed');
    console.log('SMOKE TEST: PASSED');
  }
}

runSmokeTest().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
