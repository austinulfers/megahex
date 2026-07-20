// Game data tables shared by server & client.

export const MAX_HP = 10;
export const CAPTURE_MAX = 20;
export const INCOME_PER_BUILDING = 100;
export const START_GOLD = 500;
export const CAPTURE_HQ_BONUS = 0; // HQ capture wins by elimination instead

export const PLAYER_COLORS = ['#e5484d', '#3b82f6', '#22c55e', '#eab308'];
export const PLAYER_NAMES_FALLBACK = ['Red', 'Blue', 'Green', 'Gold'];

export const MAP_SIZES = {
  small: { radius: 5, label: 'Small' },
  medium: { radius: 7, label: 'Medium' },
  large: { radius: 9, label: 'Large' },
};

// Terrain: stars = defense stars, cost per movement class (null = impassable).
export const TERRAINS = {
  plains: { stars: 0, cost: { foot: 1, wheel: 1, tread: 1 } },
  forest: { stars: 1, cost: { foot: 1, wheel: 3, tread: 2 } },
  mountain: { stars: 2, cost: { foot: 2, wheel: null, tread: null } },
  water: { stars: 0, cost: { foot: null, wheel: null, tread: null } },
};

// Buildings sit on plains-cost tiles and override defense stars.
export const BUILDINGS = {
  city: { stars: 2, income: true },
  hq: { stars: 3, income: true },
};

export const UNIT_TYPES = {
  INFANTRY: {
    name: 'Infantry', cost: 100, move: 3, moveClass: 'foot',
    atk: 4, def: 1, rangeMin: 1, rangeMax: 1, sight: 2,
    canCapture: true, indirect: false, symbol: 'I',
  },
  RECON: {
    name: 'Recon', cost: 250, move: 6, moveClass: 'wheel',
    atk: 4, def: 1, rangeMin: 1, rangeMax: 1, sight: 5,
    canCapture: false, indirect: false, symbol: 'R',
  },
  TANK: {
    name: 'Tank', cost: 500, move: 4, moveClass: 'tread',
    atk: 6, def: 3, rangeMin: 1, rangeMax: 1, sight: 2,
    canCapture: false, indirect: false, symbol: 'T',
  },
  ARTILLERY: {
    name: 'Artillery', cost: 450, move: 3, moveClass: 'tread',
    atk: 6, def: 0, rangeMin: 2, rangeMax: 3, sight: 2,
    canCapture: false, indirect: true, symbol: 'A',
  },
  TITAN: {
    name: 'Titan', cost: 1200, move: 3, moveClass: 'tread',
    atk: 8, def: 5, rangeMin: 1, rangeMax: 2, sight: 3,
    canCapture: false, indirect: false, symbol: 'X',
  },
};

// Damage multiplier attacker-type -> defender-type.
export const DMG_MULT = {
  INFANTRY: { INFANTRY: 1.0, RECON: 0.9, TANK: 0.5, ARTILLERY: 1.0, TITAN: 0.35 },
  RECON: { INFANTRY: 1.2, RECON: 1.0, TANK: 0.5, ARTILLERY: 1.1, TITAN: 0.3 },
  TANK: { INFANTRY: 1.2, RECON: 1.2, TANK: 1.0, ARTILLERY: 1.2, TITAN: 0.6 },
  ARTILLERY: { INFANTRY: 1.1, RECON: 1.1, TANK: 1.0, ARTILLERY: 1.0, TITAN: 0.7 },
  TITAN: { INFANTRY: 1.3, RECON: 1.3, TANK: 1.2, ARTILLERY: 1.3, TITAN: 1.0 },
};

export const BUILDING_SIGHT = 2;
export const TURN_SKIP_DISCONNECT_MS = 45000;
