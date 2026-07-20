# MEGAHEX

Epic online multiplayer hex-tile turn-based war strategy. Build an army, seize cities for gold, and crush your rivals by capturing their HQ — 2 to 4 players, in the browser, no accounts, no build step.

```
npm install
npm start          # http://localhost:3000
```

Open the URL in a browser, **Create Game**, share the 5-letter room code, and friends **Join** from their own machines (or open a second tab to play against yourself).

## How to play

| Concept | Details |
| --- | --- |
| **Goal** | Capture an enemy HQ (eliminates that player) or destroy everything they own. Last commander standing wins. |
| **Gold** | +100 per building you own at the start of your turn. Spend it deploying units at your HQ and cities. |
| **Capture** | Only Infantry capture. Stand on a building and choose *Capture* — each attempt chips away points equal to the unit's HP (buildings hold 20). |
| **Combat** | Click a unit, click a red target. Damage scales with attacker HP, unit matchup, and the defender's terrain. Survivors counterattack. |
| **Terrain** | Plains are fast; forests slow wheels/treads; mountains are infantry-only (+2 defense); water is impassable. Cities ★2 and HQs ★3 defense. |
| **Fog of war** | Optional lobby setting — you only see what your units and buildings can see. |
| **Map patterns** | Lobby setting: Classic, Archipelago (island chains), Highlands (dense mountains), Rivers (winding waterways), or Crater (central lake ringed by peaks). |

### Units

| Unit | Cost | Move | Range | Notes |
| --- | --- | --- | --- | --- |
| Infantry | 100g | 3 (foot) | 1 | Captures buildings, climbs mountains |
| Recon | 250g | 6 (wheel) | 1 | Fast scout, sight 5 |
| Tank | 500g | 4 (tread) | 1 | Armored brawler |
| Artillery | 450g | 3 (tread) | 2–3 | Indirect: cannot move & fire, no counterattacks |
| Titan | 1200g | 3 (tread) | 1–2 | Devastating superheavy |

### Controls

- **Click** a unit → blue = movement, red = targets. Click a destination for the action menu (Attack / Capture / Move / Wait).
- **Drag** to pan, **scroll / pinch** to zoom, **right-click / Esc** to deselect.
- **E** ends your turn, **T** focuses chat, **M** toggles sound.

### Accessibility

Fully keyboard-playable — no mouse required:

| Key | Action |
| --- | --- |
| **Arrows** (Shift+↑/↓ for diagonals) | Move the gold map cursor |
| **Enter / Space** | Select unit, confirm destination, activate |
| **N** | Jump to your next ready unit |
| **E** | End turn |
| **+ / −** | Zoom |
| **Esc** | Cancel selection / close menus |

Action and build menus are focus-managed `role=menu` popups with arrow-key navigation. Game events (turns, combat results, captures, victory) are announced via an ARIA live region for screen readers. Sound can be muted (persisted), focus rings are visible throughout, and `prefers-reduced-motion` disables animations.

## Tech

- Node.js + [`ws`](https://github.com/websockets/ws) — the only dependency.
- Authoritative server; clients get per-player fog-filtered snapshots, so you can't peek at hidden units through devtools.
- Game rules live in [shared/rules.js](shared/rules.js) and run on both server (validation) and client (move ranges & damage forecasts).
- Seeded procedural maps ([shared/mapgen.js](shared/mapgen.js)) with guaranteed connectivity between HQs.
- Disconnects: reconnect within the same tab resumes your seat; a disconnected player's turn is auto-skipped after 45s so games never stall.

```
npm test           # rules-engine test suite (node --test)
npm run test:e2e   # full protocol smoke test (lobby -> combat -> resign -> rejoin)
```

## Project layout

```
server/   index.js (http + ws), rooms.js (lobbies, sessions)
shared/   hex.js, mapgen.js, rules.js, constants.js, rng.js
public/   index.html, style.css, js/ (net, render, input, ui, sfx, main)
test/     rules.test.js
```
