// Canvas input: camera pan/zoom + tile picking + unit action state machine.

import { pixelToHex, hexToPixel, key, parseKey, hexDist } from '/shared/hex.js';
import { movementRange, attackTargets, pathTo, calcDamage, canBuildAt, unitAt, tileAt } from '/shared/rules.js';
import { UNIT_TYPES } from '/shared/constants.js';
import { HEX } from './render.js';
import { sfx } from './sfx.js';

// mode: 'idle' | 'unitSelected' | 'chooseTarget'
export class Input {
  constructor(canvas, renderer, callbacks) {
    this.canvas = canvas;
    this.r = renderer;
    this.cb = callbacks; // { sendAction, showActionMenu, hideMenus, showBuildMenu, updateInfo, isMyTurn, you }
    this.mode = 'idle';
    this.selectedUnit = null;
    this.plannedMove = null; // {q,r} chosen dest while picking attack target
    this.range = null; // cached movementRange result

    this.drag = null;
    this.pinch = null;

    canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch: single = tap/pan, double = pinch zoom.
    canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });

    this.nextUnitIdx = 0; // rotation pointer for "next unit"
  }

  // ------------- keyboard navigation -------------
  // Places (or moves) the gold keyboard cursor. dq/dr in axial coords.
  moveCursor(dq, dr) {
    const g = this.r.state;
    if (!g) return;
    if (!this.r.cursor) {
      // Start at selected unit, else camera center.
      const sel = this.selectedUnit && g.units.get(this.selectedUnit);
      if (sel) {
        this.r.cursor = { q: sel.q, r: sel.r };
      } else {
        const c = pixelToHex(this.r.cam.x, this.r.cam.y, HEX);
        this.r.cursor = { q: c.q, r: c.r };
      }
    }
    const nq = this.r.cursor.q + dq;
    const nr = this.r.cursor.r + dr;
    if (!g.tiles.has(key(nq, nr))) return;
    this.r.cursor = { q: nq, r: nr };
    this.ensureCursorVisible();
    this.describeCursor();
    // Live path preview while a unit is selected.
    const k = key(nq, nr);
    if (this.mode === 'unitSelected' && this.range && this.r.moveSet?.has(k)) {
      const u = g.units.get(this.selectedUnit);
      if (u && !u.moved) this.r.pathPreview = pathTo(g, u, k);
    }
  }

  ensureCursorVisible() {
    const p = hexToPixel(this.r.cursor.q, this.r.cursor.r, HEX);
    const s = this.r.worldToScreen(p.x, p.y);
    const m = 80;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (s.x < m || s.x > w - m || s.y < m || s.y > h - m) {
      this.r.cam.x = p.x;
      this.r.cam.y = p.y;
    }
  }

  // Announce the hex under the cursor for screen readers + info panels.
  describeCursor() {
    const g = this.r.state;
    const c = this.r.cursor;
    if (!g || !c) return;
    const t = tileAt(g, c.q, c.r);
    if (!t) return;
    const visible = !this.r.visible || this.r.visible.has(key(c.q, c.r));
    const u = visible ? unitAt(g, c.q, c.r) : null;
    this.cb.updateTile?.(visible ? t : { ...t, b: null });
    this.cb.updateInfo(u || null);
    const parts = [];
    if (t.b && visible) {
      parts.push(`${t.b.owner != null ? `player ${t.b.owner + 1}` : 'neutral'} ${t.b.type}`);
    }
    parts.push(t.t);
    if (u) {
      const owner = u.owner === this.cb.you() ? 'your' : `enemy`;
      parts.push(`${owner} ${UNIT_TYPES[u.type].name}, ${u.hp} HP`);
    }
    if (!visible) parts.push('fogged');
    this.cb.announce?.(parts.join(', '));
  }

  // Enter/Space on the cursor behaves like a click there.
  activateCursor() {
    if (!this.r.cursor) {
      this.moveCursor(0, 0);
      return;
    }
    this.clickHex(this.r.cursor.q, this.r.cursor.r);
  }

  // Cycle through own units that can still act this turn.
  selectNextReadyUnit() {
    const g = this.r.state;
    if (!g || !this.cb.isMyTurn()) return false;
    const you = this.cb.you();
    const ready = [...g.units.values()].filter(
      (u) => u.owner === you && !(u.moved && u.acted)
    );
    if (!ready.length) {
      this.cb.announce?.('No units ready. Press E to end turn.');
      return false;
    }
    this.nextUnitIdx = (this.nextUnitIdx + 1) % ready.length;
    const u = ready[this.nextUnitIdx];
    this.r.cursor = { q: u.q, r: u.r };
    this.selectUnit(u);
    this.ensureCursorVisible();
    this.cb.announce?.(`${UNIT_TYPES[u.type].name} selected, ${u.hp} HP`);
    return true;
  }

  pickHex(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const w = this.r.screenToWorld(clientX - rect.left, clientY - rect.top);
    return pixelToHex(w.x, w.y, HEX);
  }

  // ------------- selection state machine -------------
  deselect() {
    this.mode = 'idle';
    this.selectedUnit = null;
    this.plannedMove = null;
    this.range = null;
    this.r.selected = null;
    this.r.moveSet = null;
    this.r.attackSet = null;
    this.r.pathPreview = null;
    this.cb.hideMenus();
  }

  // Recompute overlays after a state refresh.
  refresh() {
    const g = this.r.state;
    if (!g) return this.deselect();
    if (this.selectedUnit) {
      const u = g.units.get(this.selectedUnit);
      if (!u || u.owner !== this.cb.you() || (u.moved && u.acted)) {
        this.deselect();
        return;
      }
      this.selectUnit(u, false);
    }
  }

  selectUnit(u, sound = true) {
    const g = this.r.state;
    this.mode = 'unitSelected';
    this.selectedUnit = u.id;
    this.plannedMove = null;
    this.r.selected = u.id;
    this.r.pathPreview = null;
    if (sound) sfx.select();

    const t = UNIT_TYPES[u.type];
    const mine = u.owner === this.cb.you() && this.cb.isMyTurn();

    // Move overlay (own turn, not yet moved).
    if (mine && !u.moved) {
      this.range = movementRange(g, u);
      this.r.moveSet = new Set(this.range.dests);
      this.r.moveSet.delete(key(u.q, u.r));
    } else {
      this.range = null;
      this.r.moveSet = null;
    }

    // Attack overlay from current position (own turn, not acted).
    if (mine && !u.acted && !(t.indirect && u.moved)) {
      const targets = attackTargets(g, u);
      this.r.attackSet = new Set(targets.map((e) => key(e.q, e.r)));
    } else {
      this.r.attackSet = null;
    }

    this.cb.updateInfo(u);
  }

  clickHex(q, r) {
    const g = this.r.state;
    if (!g) return;
    const k = key(q, r);
    if (!g.tiles.has(k)) {
      this.deselect();
      return;
    }
    const clickedUnit = unitAt(g, q, r);
    const you = this.cb.you();
    const myTurn = this.cb.isMyTurn();

    // ---- unit selected: interpret click as an order ----
    if (this.mode === 'unitSelected' && this.selectedUnit) {
      const u = g.units.get(this.selectedUnit);
      if (!u) return this.deselect();
      const ut = UNIT_TYPES[u.type];
      const mine = u.owner === you && myTurn;

      // Click an enemy in the attack overlay -> attack (with optional pre-move).
      if (mine && clickedUnit && clickedUnit.owner !== you && this.r.attackSet?.has(k)) {
        this.cb.sendAction({ kind: 'attack', unitId: u.id, targetId: clickedUnit.id });
        this.deselect();
        return;
      }

      // Click an enemy out of range but reachable for direct units:
      // find a move hex adjacent-in-range, prefer the closest along path.
      if (mine && clickedUnit && clickedUnit.owner !== you && !ut.indirect && !u.moved) {
        const spot = this.findAttackSpot(g, u, clickedUnit);
        if (spot) {
          this.cb.sendAction({
            kind: 'attack', unitId: u.id, targetId: clickedUnit.id,
            moveTo: { q: spot.q, r: spot.r },
          });
          this.deselect();
          return;
        }
      }

      // Click own other unit -> switch selection.
      if (clickedUnit && clickedUnit.owner === you && clickedUnit.id !== u.id) {
        if (!(clickedUnit.moved && clickedUnit.acted)) {
          this.selectUnit(clickedUnit);
          return;
        }
      }

      // Click a move destination -> open the action menu at that spot.
      if (mine && !u.moved && this.r.moveSet?.has(k)) {
        this.plannedMove = { q, r };
        this.openMenuFor(u, q, r);
        return;
      }

      // Click self -> action menu in place.
      if (clickedUnit && clickedUnit.id === u.id && mine) {
        this.plannedMove = null;
        this.openMenuFor(u, u.q, u.r);
        return;
      }

      this.deselect();
      return;
    }

    // ---- idle: select unit or open build menu ----
    if (clickedUnit) {
      if (clickedUnit.owner === you && (clickedUnit.moved && clickedUnit.acted)) {
        this.cb.updateInfo(clickedUnit);
        return; // exhausted: info only
      }
      this.selectUnit(clickedUnit);
      return;
    }

    const tile = tileAt(g, q, r);
    if (tile?.b && myTurn && canBuildAt(g, you, q, r)) {
      sfx.select();
      this.cb.showBuildMenu(q, r);
      return;
    }
    this.deselect();
  }

  // Best hex within move range from which `u` can hit `target`.
  findAttackSpot(g, u, target) {
    if (!this.range) return null;
    const ut = UNIT_TYPES[u.type];
    let best = null;
    let bestCost = Infinity;
    for (const k of this.range.dests) {
      const { q, r } = parseKey(k);
      const d = hexDist({ q, r }, target);
      if (d >= ut.rangeMin && d <= ut.rangeMax) {
        const c = this.range.costs.get(k) ?? Infinity;
        if (c < bestCost) {
          bestCost = c;
          best = { q, r };
        }
      }
    }
    return best;
  }

  // Build the contextual action menu for unit u acting at (q,r).
  openMenuFor(u, q, r) {
    const g = this.r.state;
    const ut = UNIT_TYPES[u.type];
    const from = { q, r };
    const movingAway = q !== u.q || r !== u.r;
    const items = [];

    // Attack options from the (possibly new) position.
    if (!u.acted && !(ut.indirect && (u.moved || movingAway))) {
      const targets = attackTargets(g, u, q, r);
      for (const t of targets.slice(0, 6)) {
        // Forecast uses current hp/pos; good enough for UI.
        const dmg = calcDamage(g, u, t);
        items.push({
          label: `Attack ${UNIT_TYPES[t.type].name}`,
          dmg: `-${dmg}`,
          act: () => {
            const action = { kind: 'attack', unitId: u.id, targetId: t.id };
            if (movingAway) action.moveTo = { q, r };
            this.cb.sendAction(action);
          },
        });
      }
    }

    // Capture (infantry standing on enemy/neutral building).
    const tile = tileAt(g, q, r);
    if (ut.canCapture && tile?.b && tile.b.owner !== u.owner && !u.acted) {
      items.push({
        label: tile.b.cap != null ? `Capture (${tile.b.cap} left)` : 'Capture',
        act: () => {
          if (movingAway) {
            // Move first; capture next turn isn't needed — server allows move
            // then capture as separate actions in one turn only if not moved.
            // So: send move, then capture via chained callback on update.
            this.cb.sendAction({ kind: 'move', unitId: u.id, q, r }, () => {
              this.cb.sendAction({ kind: 'capture', unitId: u.id });
            });
          } else {
            this.cb.sendAction({ kind: 'capture', unitId: u.id });
          }
        },
      });
    }

    if (movingAway) {
      items.push({
        label: 'Move here',
        act: () => this.cb.sendAction({ kind: 'move', unitId: u.id, q, r }),
      });
    }

    items.push({
      label: 'Wait',
      act: () => {
        if (movingAway) {
          this.cb.sendAction({ kind: 'move', unitId: u.id, q, r }, () => {
            this.cb.sendAction({ kind: 'wait', unitId: u.id });
          });
        } else {
          this.cb.sendAction({ kind: 'wait', unitId: u.id });
        }
      },
    });

    items.push({ label: 'Cancel', act: () => {} });

    // Path preview to menu spot.
    if (movingAway && this.range) {
      this.r.pathPreview = pathTo(g, u, key(q, r));
    }

    this.cb.showActionMenu(q, r, items, () => this.deselect());
  }

  // ------------- pointer events -------------
  onDown(e) {
    if (e.button === 2) {
      this.deselect();
      return;
    }
    if (e.button !== 0) return;
    this.drag = {
      x: e.clientX, y: e.clientY,
      camX: this.r.cam.x, camY: this.r.cam.y,
      moved: false,
    };
  }

  onMove(e) {
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) this.drag.moved = true;
      if (this.drag.moved) {
        this.canvas.classList.add('panning');
        this.r.cam.x = this.drag.camX - dx / this.r.cam.zoom;
        this.r.cam.y = this.drag.camY - dy / this.r.cam.zoom;
      }
      return;
    }
    // Hover + path preview.
    const h = this.pickHex(e.clientX, e.clientY);
    this.r.hover = h;
    if (this.mode === 'unitSelected' && this.range && this.r.moveSet?.has(key(h.q, h.r))) {
      const u = this.r.state.units.get(this.selectedUnit);
      if (u && !u.moved) this.r.pathPreview = pathTo(this.r.state, u, key(h.q, h.r));
    } else if (!document.querySelector('#action-menu:not(.hidden)')) {
      this.r.pathPreview = null;
    }
  }

  onUp(e) {
    if (!this.drag) return;
    const wasDrag = this.drag.moved;
    this.drag = null;
    this.canvas.classList.remove('panning');
    if (wasDrag) return;
    if (e.target !== this.canvas) return;
    const h = this.pickHex(e.clientX, e.clientY);
    this.clickHex(h.q, h.r);
  }

  onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    this.zoomAt(e.clientX, e.clientY, factor);
  }

  zoomAt(cx, cy, factor) {
    const rect = this.canvas.getBoundingClientRect();
    const before = this.r.screenToWorld(cx - rect.left, cy - rect.top);
    this.r.cam.zoom = Math.max(0.35, Math.min(2.6, this.r.cam.zoom * factor));
    const after = this.r.screenToWorld(cx - rect.left, cy - rect.top);
    this.r.cam.x += before.x - after.x;
    this.r.cam.y += before.y - after.y;
  }

  // ------------- touch -------------
  onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this.drag = {
        x: t.clientX, y: t.clientY,
        camX: this.r.cam.x, camY: this.r.cam.y,
        moved: false,
      };
    } else if (e.touches.length === 2) {
      this.drag = null;
      const [a, b] = e.touches;
      this.pinch = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        zoom: this.r.cam.zoom,
      };
    }
  }

  onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && this.drag) {
      const t = e.touches[0];
      const dx = t.clientX - this.drag.x;
      const dy = t.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) this.drag.moved = true;
      if (this.drag.moved) {
        this.r.cam.x = this.drag.camX - dx / this.r.cam.zoom;
        this.r.cam.y = this.drag.camY - dy / this.r.cam.zoom;
      }
    } else if (e.touches.length === 2 && this.pinch) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      const target = Math.max(0.35, Math.min(2.6, this.pinch.zoom * (d / this.pinch.dist)));
      this.zoomAt(mid.x, mid.y, target / this.r.cam.zoom);
    }
  }

  onTouchEnd(e) {
    e.preventDefault();
    if (this.pinch && e.touches.length < 2) this.pinch = null;
    if (this.drag && e.touches.length === 0) {
      const wasDrag = this.drag.moved;
      const { x, y } = this.drag;
      this.drag = null;
      if (!wasDrag) {
        const h = this.pickHex(x, y);
        this.clickHex(h.q, h.r);
      }
    }
  }
}
