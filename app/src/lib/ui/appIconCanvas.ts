// The live app icon on a canvas: the static icon's wall (appIcon.ts),
// moved by appIconMotion.ts. One `LiveIcon` per mounted canvas holds the
// wall's current glyphs and the timers of its effects;
// LiveAppIcon.svelte calls `frame` from requestAnimationFrame.
import { CURSOR, GLYPH_FONT, GLYPH_SIZE, BASELINE_DROP, ICON_ART, ICON_COLOURS, WALL_GLYPHS, WALL_OPACITY_MIN, wallCells, type WallCell } from "./appIcon";
import {
  AMBER,
  GLITCH_EVERY_MS,
  GLITCH_MS,
  NOISE_GLYPHS,
  PAUSED_ALPHA,
  PAUSED_GREY,
  PUNCH_MS,
  RED,
  STATIC_TICK_MS,
  cursorOn,
  flashAlpha,
  isDoubleClick,
  nextPunchPower,
  punchEnvelope,
  rerollsDue,
  ringOffset,
  rowTear,
  staticAt,
  type IconStatus,
} from "./appIconMotion";

// The 1024 frame's geometry, as the static icon draws it.
const INSET = 100 / 1024;
const SIDE = 824 / 1024;
const RADIUS = 184 / 824;

const COLS = ICON_ART[0].length;
const ROWS = ICON_ART.length;

export interface LiveIcon {
  /// Feeds a pointer press; a double click lands a punch.
  press(nowMs: number): void;
  /// Advances and draws one frame on a `size` CSS-pixel square.
  frame(ctx: CanvasRenderingContext2D, size: number, status: IconStatus, nowMs: number, dtMs: number): void;
  /// True while a punch is still playing, when every frame must draw.
  shaking(nowMs: number): boolean;
}

export function liveIcon(reduced: boolean): LiveIcon {
  const cells: (WallCell | null)[] = wallCells(ICON_ART);
  const flashAt = new Float64Array(cells.length).fill(-Infinity);
  let rerollDebt = 0;
  let glitchRow = -1;
  let glitchAt = -Infinity;
  let nextGlitch = 0;
  let lastClick: number | null = null;
  let punchAt = -Infinity;
  let punchPower = 0;

  const rand = (n: number) => Math.floor(Math.random() * n);

  function reroll(i: number, now: number): void {
    const cell = cells[i];
    if (!cell) return;
    cell.ch = WALL_GLYPHS[rand(WALL_GLYPHS.length)];
    cell.opacity = WALL_OPACITY_MIN + (1 - WALL_OPACITY_MIN) * Math.random();
    flashAt[i] = now;
  }

  function step(status: IconStatus, now: number, dt: number): void {
    if (reduced || status.paused) return;
    const due = rerollsDue(rerollDebt, status.working, dt);
    rerollDebt = due.debt;
    for (let n = 0; n < due.count; n++) reroll(rand(cells.length), now);
    if (status.failed && now >= nextGlitch) {
      glitchRow = 2 + rand(ROWS - 4);
      glitchAt = now;
      nextGlitch = now + GLITCH_EVERY_MS * (0.7 + Math.random() * 0.6);
      for (let c = 0; c < COLS; c++) reroll(glitchRow * COLS + c, now);
    }
  }

  function draw(ctx: CanvasRenderingContext2D, px: number, status: IconStatus, now: number): void {
    ctx.clearRect(0, 0, px, px);
    const x0 = INSET * px;
    const side = SIDE * px;
    const radius = RADIUS * side;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = (22 / 1024) * px;
    ctx.shadowOffsetY = (14 / 1024) * px;
    const tile = ctx.createLinearGradient(0, x0, 0, x0 + side);
    tile.addColorStop(0, ICON_COLOURS.tileTop);
    tile.addColorStop(1, ICON_COLOURS.tileBottom);
    ctx.fillStyle = tile;
    ctx.beginPath();
    ctx.roundRect(x0, x0, side, side, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0, x0, side, side, radius);
    ctx.clip();
    ctx.translate(x0, x0);
    const cw = side / COLS;
    const ch = side / ROWS;
    const em = ch * GLYPH_SIZE;
    const drop = em * BASELINE_DROP;
    ctx.font = `700 ${em}px ${GLYPH_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const since = now - punchAt;
    const hit = reduced ? 0 : punchEnvelope(since, punchPower);
    if (hit > 0) {
      const [dx, dy] = ringOffset(since, hit);
      ctx.translate(dx * side, dy * side);
    }
    const shift: number[] = [];
    for (let row = 0; row < ROWS; row++) shift.push(rowTear(row, ROWS, since, hit) * cw);
    const tick = Math.floor(since / STATIC_TICK_MS);
    const at = (i: number) => [((i % COLS) + 0.5) * cw, (Math.floor(i / COLS) + 0.5) * ch + drop];

    if (hit > 0) {
      // Colour fringes: the wall drawn twice more, split red and cyan.
      const split = hit * cw * 0.45;
      for (const [fringe, dx] of [["#ff2d55", split], ["#2de2ff", -split]] as const) {
        ctx.fillStyle = fringe;
        cells.forEach((cell, i) => {
          if (!cell) return;
          const [x, y] = at(i);
          ctx.globalAlpha = Math.min(1, hit) * 0.45 * cell.opacity;
          ctx.fillText(cell.ch, x + dx + shift[Math.floor(i / COLS)], y);
        });
      }
    }

    const glitchShown = status.failed && (reduced || now - glitchAt < GLITCH_MS);
    const glitchRowShown = reduced ? Math.floor(ROWS / 2) + 3 : glitchRow;
    const glitchFade = reduced ? 1 : 1 - (now - glitchAt) / GLITCH_MS;

    cells.forEach((cell, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const [x, y] = at(i);
      if (!cell) {
        // Static drifts into the carving while the tube rings.
        if (hit > 0 && staticAt(col, row, tick) < hit * 0.4) {
          ctx.globalAlpha = Math.min(1, hit) * (0.35 + 0.5 * staticAt(row, col, tick));
          ctx.fillStyle = "#e8e8f0";
          ctx.fillText(NOISE_GLYPHS[Math.floor(staticAt(col + 7, row, tick) * NOISE_GLYPHS.length)], x + shift[row], y);
        }
        return;
      }
      let fill = cell.fill;
      let alpha = cell.opacity;
      let glyph = cell.ch;
      if (status.paused) {
        fill = PAUSED_GREY;
        alpha *= PAUSED_ALPHA;
      } else if (glitchShown && row === glitchRowShown) {
        fill = RED;
        alpha = Math.max(alpha, glitchFade);
      } else if (!reduced) {
        alpha = flashAlpha(alpha, now - flashAt[i]);
      }
      if (hit > 0 && staticAt(col, row, tick + 31) < hit * 0.22) {
        glyph = NOISE_GLYPHS[Math.floor(staticAt(row, col + 3, tick) * NOISE_GLYPHS.length)];
        alpha = Math.min(1, alpha + hit * 0.3);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fillText(glyph, x + shift[row], y);
    });
    ctx.globalAlpha = 1;

    if (status.waiting && cursorOn(now, reduced)) {
      ctx.fillStyle = AMBER;
      ctx.fillRect(CURSOR.col * cw, CURSOR.row * ch, CURSOR.width * cw, CURSOR.height * ch);
    }

    if (hit > 0) {
      const strength = Math.min(1, hit);
      // Scanlines.
      ctx.fillStyle = "#000";
      ctx.globalAlpha = 0.3 * strength;
      for (let y = 0; y < side; y += Math.max(2, side / 90)) ctx.fillRect(-side, y, side * 3, Math.max(1, side / 220));
      // The vertical hold slipping: a bright bar rolling down the tube.
      const barY = ((since / PUNCH_MS) * 1.6 * side) % side;
      const bar = ctx.createLinearGradient(0, barY - side * 0.08, 0, barY + side * 0.08);
      bar.addColorStop(0, "rgba(255,255,255,0)");
      bar.addColorStop(0.5, "rgba(255,255,255,0.35)");
      bar.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = strength;
      ctx.fillStyle = bar;
      ctx.fillRect(-side, barY - side * 0.08, side * 3, side * 0.16);
      // The flash of the blow itself, eased out.
      if (since < 200) {
        const f = 1 - since / 200;
        ctx.globalAlpha = 0.3 * f * f * strength;
        ctx.fillStyle = "#fff";
        ctx.fillRect(-side, -side, side * 3, side * 3);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // The rim, over everything, exactly where the static icon draws it.
    const rim = ctx.createLinearGradient(0, x0, 0, x0 + side);
    ICON_COLOURS.rim.forEach((colour, i) => rim.addColorStop(i / (ICON_COLOURS.rim.length - 1), colour));
    ctx.strokeStyle = rim;
    ctx.lineWidth = (12 / 1024) * px;
    const inset = (6 / 1024) * px;
    ctx.beginPath();
    ctx.roundRect(x0 + inset, x0 + inset, side - 2 * inset, side - 2 * inset, radius - inset);
    ctx.stroke();
  }

  return {
    press(now) {
      if (reduced) return;
      if (!isDoubleClick(lastClick, now)) {
        lastClick = now;
        return;
      }
      lastClick = null;
      punchPower = nextPunchPower(punchEnvelope(now - punchAt, punchPower));
      punchAt = now;
    },
    frame(ctx, size, status, now, dt) {
      step(status, now, dt);
      draw(ctx, size, status, now);
    },
    shaking(now) {
      return !reduced && punchEnvelope(now - punchAt, punchPower) > 0;
    },
  };
}
