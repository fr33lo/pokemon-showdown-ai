# Pokemon Showdown AI

🚀 **an autonomous pokemon showdown random battles agent** — AI-powered competitive battling that plays like a human.

built this because I wanted to see how far you can push an AI agent in competitive pokemon. no manual input, no handholding — it logs in, queues games, reads the board, and makes decisions using a layered heuristic + LLM pipeline. it plays gen 9 random battles on the official ladder, handles switching, hazards, setup, sacking, and even throws in occasional imperfect plays so it doesn't look like a bot.

## ✨ what you'll get:

- 🧠 **claude-powered decision making** — feeds full battle context, damage calcs, inference data, and strategic evaluation to Claude when heuristics can't resolve
- 🎯 **9-layer heuristic engine** — handles guaranteed KOs, priority finishes, hazard management, setup opportunities, and bad matchup pivots before ever calling the API
- 🔮 **hidden information inference** — probabilistic tracking of opponent sets, moves, items, and abilities using the random battles set database
- 📊 **@smogon/calc integration** — real damage calculations with cached results, boost-aware speed checks, and multi-hit move handling
- 🏆 **full strategic evaluation** — win condition identification, threat assessment, position scoring, and sack ordering every single turn
- 🎭 **human-like behavior** — randomized turn delays, requeue timing, and a 2% imperfect play injection rate so it doesn't get flagged
- 📝 **battle logging** — full JSON logs per game with turn-by-turn decisions, strategic state, and raw protocol messages
- ♻️ **auto-queue battles** — plays continuously with configurable max battle limits and automatic requeuing
- 🔌 **auto-reconnect** — exponential backoff reconnection with up to 5 retry attempts
- 🆓 **always free** — no subscriptions, no telemetry, no locked features

## 🚀 getting it running:

### ⚡ quick deploy

**clone and go**
```powershell
# clone the repo
git clone https://github.com/fr33lo/pokemon-showdown-ai.git
cd pokemon-showdown-ai

# install dependencies
npm install

# set up your credentials
cp .env.example .env
# edit .env with your Pokemon Showdown account + Anthropic API key

# run it
npm run dev
```

**production build**
```powershell
# compile TypeScript
npm run build

# run compiled version
npm start
```

### 🔧 requirements

you'll need these to get battling:
- **Node.js 18+** (required for ES2022 features)
- **Pokemon Showdown account** (register at play.pokemonshowdown.com)
- **Anthropic API key** (for Claude decision making)
- **Windows/Linux/macOS** — runs anywhere Node runs

### 🔑 environment variables

```env
# required
PS_USERNAME=your_showdown_username
PS_PASSWORD=your_showdown_password
ANTHROPIC_API_KEY=your_anthropic_key

# optional
PS_SERVER=wss://sim3.psim.us/showdown/websocket
BATTLE_FORMAT=gen9randombattle
AUTO_QUEUE=true
MAX_BATTLES=0          # 0 = unlimited
VERBOSE=true           # enables debug logging
```

## 💻 local development:

**requirements:** Node.js 18+ and npm

```powershell
# clone the repo
git clone https://github.com/fr33lo/pokemon-showdown-ai.git
cd pokemon-showdown-ai

# install deps
npm install

# set up env
cp .env.example .env

# run in dev mode (tsx hot-reload)
npm run dev

# build for production
npm run build

# run production build
npm start
```

open your terminal and start battling! 💻

## 🔧 how it's built:

TypeScript because types matter when you're tracking 12 pokemon states simultaneously. WebSocket because that's how Showdown works. Claude because sometimes the board state is too nuanced for hardcoded rules.

every turn runs through a layered decision pipeline:
1. **state engine** parses raw protocol messages into structured battle state
2. **inference engine** updates probabilistic trackers for all opponent pokemon
3. **damage calculator** runs @smogon/calc matchups for both sides
4. **strategic evaluation** scores win conditions, threats, position, and sack order
5. **heuristic engine** tries to resolve the decision with 9 rule-based checks
6. **claude engine** gets called only when heuristics are inconclusive
7. **human-like behavior** adds realistic delays and occasional misplays
8. **command execution** sends the final move/switch to the Showdown server

**📚 tech stack:**
- **runtime:** Node.js + TypeScript (ES2022)
- **ai:** Anthropic Claude API (claude-sonnet-4-20250514)
- **damage calc:** @smogon/calc v0.10
- **websocket:** ws v8 for Showdown protocol
- **config:** dotenv + typed config validation
- **logging:** structured JSON battle logs
- **dev tooling:** tsx for hot-reload development

**🎨 design philosophy:**
- heuristics first, LLM second — minimize API calls
- human-like behavior over mechanical perfection
- full strategic awareness every turn
- probabilistic reasoning over assumptions
- zero external dependencies beyond what's needed

## 🧠 decision pipeline breakdown:

```
┌─────────────────────────────────────────────────────────┐
│                  TURN DECISION PIPELINE                  │
├─────────────────────────────────────────────────────────┤
│  1. Force Switch         → pick best switch-in          │
│  2. Guaranteed OHKO      → take the kill                │
│  3. Priority KO          → finish low HP opponents      │
│  4. Survival Check       → priority KO or preserve win  │
│  5. Hazard Removal       → defog/spin when safe         │
│  6. Hazard Setup         → rocks/spikes when safe       │
│  7. Setup Opportunity    → boost when opponent can't KO │
│  8. Best Damage Move     → highest calc'd damage        │
│  9. Bad Matchup Pivot    → switch out unfavorable       │
│  ─── if none resolve ───                                │
│  10. Claude LLM Call     → full context strategic call  │
│  11. Emergency Fallback  → first available action       │
├─────────────────────────────────────────────────────────┤
│  + Human-like delay (1.5-4s)                            │
│  + 2% imperfect play injection                          │
└─────────────────────────────────────────────────────────┘
```

## 📁 project structure:

```
pokemon-showdown-ai/
├── src/
│   ├── index.ts                 # entry point + main app loop
│   ├── config.ts                # typed config + validation
│   ├── types.ts                 # all TypeScript interfaces
│   ├── ai/
│   │   └── claude.ts            # Claude API integration + prompt building
│   ├── battle/
│   │   ├── orchestrator.ts      # per-battle decision pipeline
│   │   └── state.ts             # protocol parser + state tracking
│   ├── behavior/
│   │   └── human-like.ts        # delays + imperfect play injection
│   ├── calculator/
│   │   └── damage.ts            # @smogon/calc wrapper + caching
│   ├── client/
│   │   └── showdown-client.ts   # WebSocket client + auth + commands
│   ├── heuristics/
│   │   └── engine.ts            # 9-layer rule-based decision engine
│   ├── inference/
│   │   ├── engine.ts            # hidden info inference coordinator
│   │   ├── sets-database.ts     # random battle sets data loader
│   │   └── tracker.ts           # per-pokemon probabilistic tracker
│   ├── logging/
│   │   └── logger.ts            # battle logging + console output
│   └── strategy/
│       ├── evaluation.ts        # strategic state aggregator
│       ├── position.ts          # board position scorer (-1 to +1)
│       ├── sack-order.ts        # sacrifice priority calculator
│       ├── threats.ts           # opponent threat assessor
│       └── win-conditions.ts    # win condition identifier
├── data/
│   └── random-sets.json         # gen9 random battle sets database
├── .env.example                 # environment template
├── package.json
└── tsconfig.json
```

## 🤝 contributing:

found a bug? have an idea? contributions are welcome!

1. **fork** the repo
2. **create** a feature branch (`git checkout -b feature/amazing-strategy`)
3. **implement** your changes with proper typing
4. **commit** your changes (`git commit -m 'add amazing strategy'`)
5. **push** to the branch (`git push origin feature/amazing-strategy`)
6. **open** a pull request

please keep TypeScript strict, add proper types, and follow the existing module patterns.

## 🗺️ roadmap:

- [ ] team preview optimization for non-random formats
- [ ] multi-format support (OU, UU, etc.)
- [ ] ELO tracking and performance analytics
- [ ] opponent pattern recognition across games
- [ ] terastallization strategic optimization
- [ ] web dashboard for live battle monitoring
- [ ] replay analysis and learning pipeline

---

<div align="center">

**⚡ built for trainers who'd rather code than click**

*no manual input • no handholding • no mercy • no cap*

**© 2025 pokemon-showdown-ai** • built because clicking buttons in a pokemon game is beneath us 🎮

[![GitHub](https://img.shields.io/badge/GitHub-pokemon--showdown--ai-green?style=flat&logo=github)](https://github.com/fr33lo/pokemon-showdown-ai)

</div>
