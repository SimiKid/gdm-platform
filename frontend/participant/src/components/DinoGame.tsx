import { useEffect, useRef, useCallback } from "react";

/* ── Sprite geometry (all in logical "game pixels") ──────────── */

const W = 600;
const H = 150;
const GROUND_Y = 120;
const DINO_W = 40;
const DINO_H = 44;
const DINO_DUCK_H = 26;
const CACTUS_W = 18;
const CACTUS_MIN_H = 28;
const CACTUS_MAX_H = 46;
const BIRD_W = 36;
const BIRD_H = 28;
const JUMP_VEL = -10;
const GRAVITY = 0.42;
const BASE_SPEED = 2.5;
const MAX_SPEED = 9;
const SPAWN_MIN_EARLY = 400;
const SPAWN_MAX_EARLY = 650;
const SPAWN_MIN_LATE = 140;
const SPAWN_MAX_LATE = 280;

/** Lerp spawn gap from wide (early) to tight (late) based on distance travelled. */
function spawnGap(dist: number) {
  const t = Math.min(1, dist / 8000); // fully dense by ~8000 distance
  const lo = SPAWN_MIN_EARLY + (SPAWN_MIN_LATE - SPAWN_MIN_EARLY) * t;
  const hi = SPAWN_MAX_EARLY + (SPAWN_MAX_LATE - SPAWN_MAX_EARLY) * t;
  return lo + Math.random() * (hi - lo);
}

type Obstacle = {
  x: number;
  w: number;
  h: number;
  y: number; // bottom-edge y
  kind: "cactus" | "bird";
};

/* ── Drawing helpers ────────────────────────────────────── */

function drawDino(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  frame: number,
  ducking: boolean,
  running: boolean,
) {
  ctx.fillStyle = "#535353";
  const w = ducking ? DINO_W + 10 : DINO_W;
  // body
  ctx.fillRect(x, y - h, w - 8, h);
  // head
  ctx.fillRect(x + (ducking ? w - 20 : w - 18), y - h - (ducking ? 2 : 10), 18, ducking ? 12 : 16);
  // eye
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + (ducking ? w - 10 : w - 8), y - h - (ducking ? 0 : 6), 4, 4);
  // legs (animated)
  ctx.fillStyle = "#535353";
  const legOffset = Math.floor(frame / 12) % 2;
  if (!running) {
    // crashed – legs still
    ctx.fillRect(x + 6, y, 6, 8);
    ctx.fillRect(x + 18, y, 6, 8);
  } else if (y >= GROUND_Y) {
    // on ground – animate legs
    ctx.fillRect(x + 6, y, 6, legOffset === 0 ? 10 : 5);
    ctx.fillRect(x + 18, y, 6, legOffset === 1 ? 10 : 5);
  } else {
    // in air – legs together
    ctx.fillRect(x + 6, y, 6, 8);
    ctx.fillRect(x + 18, y, 6, 8);
  }
}

function drawCactus(ctx: CanvasRenderingContext2D, ob: Obstacle) {
  ctx.fillStyle = "#535353";
  // main trunk
  ctx.fillRect(ob.x, ob.y - ob.h, ob.w, ob.h);
  // arms
  if (ob.h > 34) {
    ctx.fillRect(ob.x - 6, ob.y - ob.h + 10, 6, 14);
    ctx.fillRect(ob.x + ob.w, ob.y - ob.h + 18, 6, 12);
  }
}

function drawBird(ctx: CanvasRenderingContext2D, ob: Obstacle, frame: number) {
  ctx.fillStyle = "#535353";
  const wingUp = Math.floor(frame / 8) % 2 === 0;
  // body
  ctx.fillRect(ob.x, ob.y - 12, ob.w, 12);
  // beak
  ctx.fillRect(ob.x + ob.w, ob.y - 10, 8, 6);
  // wing
  if (wingUp) {
    ctx.fillRect(ob.x + 8, ob.y - 12 - 10, 14, 10);
  } else {
    ctx.fillRect(ob.x + 8, ob.y, 14, 10);
  }
}

/* ── Component ───────────────────────────────────────────── */

export default function DinoGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    running: false,
    gameOver: false,
    dinoY: GROUND_Y,
    velY: 0,
    ducking: false,
    obstacles: [] as Obstacle[],
    nextSpawn: spawnGap(0),
    dist: 0,
    speed: BASE_SPEED,
    frame: 0,
    score: 0,
    highScore: 0,
  });

  /* input handling */
  const handleAction = useCallback((action: "jump" | "duck-start" | "duck-end") => {
    const s = stateRef.current;
    if (action === "jump") {
      if (s.gameOver) {
        // restart
        s.gameOver = false;
        s.running = true;
        s.dinoY = GROUND_Y;
        s.velY = 0;
        s.ducking = false;
        s.obstacles = [];
        s.nextSpawn = spawnGap(0);
        s.dist = 0;
        s.speed = BASE_SPEED;
        s.score = 0;
        s.frame = 0;
        return;
      }
      if (!s.running) {
        s.running = true;
        return;
      }
      if (s.dinoY >= GROUND_Y) {
        s.velY = JUMP_VEL;
        s.ducking = false;
      }
    } else if (action === "duck-start") {
      if (s.running && !s.gameOver) {
        s.ducking = true;
        if (s.dinoY < GROUND_Y) s.velY = Math.max(s.velY, 6); // fast-fall
      }
    } else {
      s.ducking = false;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        handleAction("jump");
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        handleAction(e.type === "keydown" ? "duck-start" : "duck-end");
      }
    };
    const onTouch = (e: TouchEvent) => {
      e.preventDefault();
      handleAction("jump");
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    canvas.addEventListener("touchstart", onTouch, { passive: false });
    canvas.addEventListener("click", () => handleAction("jump"));

    function tick() {
      const s = stateRef.current;
      s.frame++;

      /* ── Scale canvas for sharp rendering ─── */
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas!.getBoundingClientRect();
      const cw = rect.width;
      const ch = rect.height;
      if (canvas!.width !== cw * dpr || canvas!.height !== ch * dpr) {
        canvas!.width = cw * dpr;
        canvas!.height = ch * dpr;
      }
      ctx.setTransform(dpr * (cw / W), 0, 0, dpr * (ch / H), 0, 0);

      ctx.clearRect(0, 0, W, H);

      /* ground line */
      ctx.fillStyle = "#535353";
      ctx.fillRect(0, GROUND_Y + 12, W, 1);

      if (!s.running && !s.gameOver) {
        /* idle — draw dino + prompt */
        drawDino(ctx, 40, GROUND_Y, DINO_H, 0, false, false);
        ctx.fillStyle = "#535353";
        ctx.font = "14px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Press Space or tap to play a waiting game", W / 2, 60);
        ctx.font = "11px monospace";
        ctx.fillStyle = "#888";
        // draw key icons
        const midX = W / 2;
        // Space bar
        const spaceW = 48, spaceH = 16, spaceX = midX - 80, spaceY = 86;
        ctx.strokeStyle = "#888";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(spaceX, spaceY, spaceW, spaceH, 3);
        ctx.stroke();
        ctx.fillStyle = "#888";
        ctx.font = "8px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("SPACE", spaceX + spaceW / 2, spaceY + 11.5);
        // "Jump" label
        ctx.font = "11px monospace";
        ctx.fillText("Jump", spaceX + spaceW + 24, spaceY + 12);

        // Down arrow key
        const arrowS = 16, arrowX = midX + 30, arrowY = spaceY;
        ctx.beginPath();
        ctx.roundRect(arrowX, arrowY, arrowS, spaceH, 3);
        ctx.stroke();
        // arrow glyph
        ctx.beginPath();
        ctx.moveTo(arrowX + arrowS / 2, arrowY + 12);
        ctx.lineTo(arrowX + arrowS / 2 - 4, arrowY + 6);
        ctx.lineTo(arrowX + arrowS / 2 + 4, arrowY + 6);
        ctx.closePath();
        ctx.fill();
        // "Duck" label
        ctx.font = "11px monospace";
        ctx.fillText("Duck", arrowX + arrowS + 24, arrowY + 12);
        raf = requestAnimationFrame(tick);
        return;
      }

      if (!s.gameOver) {
        /* ── physics ─── */
        s.speed = Math.min(MAX_SPEED, BASE_SPEED + s.dist / 4000);
        s.dist += s.speed;
        s.score = Math.floor(s.dist / 10);

        // dino
        s.velY += GRAVITY;
        s.dinoY += s.velY;
        if (s.dinoY >= GROUND_Y) {
          s.dinoY = GROUND_Y;
          s.velY = 0;
        }

        // spawn
        s.nextSpawn -= s.speed;
        if (s.nextSpawn <= 0) {
          const isBird = s.score > 50 && Math.random() < 0.3;
          if (isBird) {
            const birdY =
              [GROUND_Y - 10, GROUND_Y - 30, GROUND_Y - 50][
                Math.floor(Math.random() * 3)
              ];
            s.obstacles.push({
              x: W + 10,
              w: BIRD_W,
              h: BIRD_H,
              y: birdY,
              kind: "bird",
            });
          } else {
            const h =
              CACTUS_MIN_H +
              Math.random() * (CACTUS_MAX_H - CACTUS_MIN_H);
            s.obstacles.push({
              x: W + 10,
              w: CACTUS_W,
              h,
              y: GROUND_Y + 12,
              kind: "cactus",
            });
          }
          s.nextSpawn = spawnGap(s.dist);
        }

        // move & cull
        for (let i = s.obstacles.length - 1; i >= 0; i--) {
          s.obstacles[i].x -= s.speed;
          if (s.obstacles[i].x + s.obstacles[i].w < -10) {
            s.obstacles.splice(i, 1);
          }
        }

        // collision
        const dinoH = s.ducking ? DINO_DUCK_H : DINO_H;
        const dx = 40,
          dy = s.dinoY - dinoH,
          dw = s.ducking ? DINO_W + 2 : DINO_W - 8;
        for (const ob of s.obstacles) {
          const ox = ob.x,
            oy = ob.y - ob.h,
            ow = ob.w,
            oh = ob.h;
          if (dx + dw > ox && dx < ox + ow && dy + dinoH > oy && dy < oy + oh) {
            s.gameOver = true;
            s.running = false;
            if (s.score > s.highScore) s.highScore = s.score;
            break;
          }
        }
      }

      /* ── draw ─── */
      const dinoH = s.ducking ? DINO_DUCK_H : DINO_H;
      drawDino(ctx, 40, s.dinoY, dinoH, s.frame, s.ducking, s.running);

      for (const ob of s.obstacles) {
        if (ob.kind === "cactus") drawCactus(ctx, ob);
        else drawBird(ctx, ob, s.frame);
      }

      // score
      ctx.fillStyle = "#535353";
      ctx.font = "12px monospace";
      ctx.textAlign = "right";
      ctx.fillText(
        String(s.score).padStart(5, "0"),
        W - 10,
        20,
      );
      if (s.highScore > 0) {
        ctx.fillText(
          "HI " + String(s.highScore).padStart(5, "0"),
          W - 80,
          20,
        );
      }

      if (s.gameOver) {
        ctx.fillStyle = "#535353";
        ctx.font = "16px monospace";
        ctx.textAlign = "center";
        ctx.fillText("GAME OVER", W / 2, 50);
        ctx.font = "12px monospace";
        ctx.fillText("Press Space or tap to restart", W / 2, 72);
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      canvas.removeEventListener("touchstart", onTouch);
    };
  }, [handleAction]);

  return (
    <div className="dino-game">
      <canvas
        ref={canvasRef}
        className="dino-canvas"
        tabIndex={0}
        aria-label="Dinosaur jumping game — press Space to jump, Down to duck"
      />
    </div>
  );
}
