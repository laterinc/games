import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ChessColor, ChessGame, ChessLegalMove, Point } from '../../types';

interface ChessBoardProps {
  game: ChessGame;
  myColor: ChessColor | null;
  /** 轮到自己且连接正常时才可操作。 */
  interactive: boolean;
  onMove: (move: { from: Point; to: Point }) => void;
}

const CELL = 64;
const MARGIN = 44;
const COLS = 9;
const ROWS = 10;
const BOARD_W = (COLS - 1) * CELL + MARGIN * 2;
const BOARD_H = (ROWS - 1) * CELL + MARGIN * 2;
const PIECE_RADIUS = CELL * 0.42;

const PIECE_GLYPH: Record<string, string> = {
  K: '帅',
  A: '仕',
  B: '相',
  N: '马',
  R: '车',
  C: '炮',
  P: '兵',
  k: '将',
  a: '士',
  b: '象',
  n: '马',
  r: '车',
  c: '炮',
  p: '卒',
};

function pieceColor(piece: string): ChessColor {
  return piece === piece.toUpperCase() ? 'red' : 'black';
}

function inBoard(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

function drawBoardBase(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, BOARD_W, BOARD_H);
  const x0 = MARGIN;
  const x1 = MARGIN + (COLS - 1) * CELL;
  const y0 = MARGIN;
  const y1 = MARGIN + (ROWS - 1) * CELL;
  const riverTop = y0 + 4 * CELL;
  const riverBottom = y0 + 5 * CELL;

  ctx.strokeStyle = 'rgba(70, 42, 15, 0.55)';
  ctx.lineWidth = 1.2;
  // 横线
  for (let row = 0; row < ROWS; row += 1) {
    const y = y0 + row * CELL;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
  // 竖线：楚河汉界处断开（两边缘不断）
  for (let col = 0; col < COLS; col += 1) {
    const x = x0 + col * CELL;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, col === 0 || col === COLS - 1 ? y1 : riverTop);
    ctx.stroke();
    if (col !== 0 && col !== COLS - 1) {
      ctx.beginPath();
      ctx.moveTo(x, riverBottom);
      ctx.lineTo(x, y1);
      ctx.stroke();
    }
  }
  // 九宫斜线
  const palace = (topRow: number) => {
    const top = y0 + topRow * CELL;
    const bottom = top + 2 * CELL;
    ctx.beginPath();
    ctx.moveTo(x0 + 3 * CELL, top);
    ctx.lineTo(x0 + 5 * CELL, bottom);
    ctx.moveTo(x0 + 5 * CELL, top);
    ctx.lineTo(x0 + 3 * CELL, bottom);
    ctx.stroke();
  };
  palace(0);
  palace(7);

  // 楚河汉界
  ctx.fillStyle = 'rgba(72, 43, 15, 0.62)';
  ctx.font = '600 25px "STKaiti", "KaiTi", "Songti SC", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('楚 河', x0 + 1.8 * CELL, (riverTop + riverBottom) / 2);
  ctx.fillText('汉 界', x0 + 6.2 * CELL, (riverTop + riverBottom) / 2);

  // 坐标（简单数字，红方底线为 1）
  ctx.fillStyle = 'rgba(72, 43, 15, 0.5)';
  ctx.font = '500 12px "PingFang SC", sans-serif';
  for (let col = 0; col < COLS; col += 1) {
    const x = x0 + col * CELL;
    ctx.fillText(String(col + 1), x, y0 - 22);
    ctx.fillText(String(col + 1), x, y1 + 22);
  }
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  piece: string,
  cx: number,
  cy: number,
  options: { selected?: boolean; checked?: boolean; alpha?: number } = {},
): void {
  const color = pieceColor(piece);
  const glyph = PIECE_GLYPH[piece] ?? piece;
  const { selected = false, checked = false, alpha = 1 } = options;
  ctx.save();
  ctx.globalAlpha = alpha;

  // 棋子底座
  const gradient = ctx.createRadialGradient(
    cx - PIECE_RADIUS * 0.35,
    cy - PIECE_RADIUS * 0.4,
    PIECE_RADIUS * 0.1,
    cx,
    cy,
    PIECE_RADIUS,
  );
  gradient.addColorStop(0, '#fff8e8');
  gradient.addColorStop(0.65, '#f3e0bd');
  gradient.addColorStop(1, '#d9bd8c');
  ctx.shadowColor = 'rgba(30, 18, 6, 0.5)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, PIECE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowColor = 'transparent';

  ctx.lineWidth = 1.8;
  ctx.strokeStyle = color === 'red' ? 'rgba(150, 38, 26, 0.9)' : 'rgba(34, 40, 46, 0.9)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, PIECE_RADIUS - 5, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle =
    color === 'red' ? 'rgba(150, 38, 26, 0.45)' : 'rgba(34, 40, 46, 0.4)';
  ctx.stroke();

  // 楷体的 CJK 字形在 textBaseline='middle' 下普遍偏低，不能直接画在圆心。
  // 用实际墨迹框（ascent/descent）做垂直居中，兼容不同系统的楷体/宋体。
  const fontSize = Math.round(CELL * 0.48);
  ctx.fillStyle = color === 'red' ? '#a5271a' : '#20262d';
  ctx.font = `700 ${fontSize}px "STKaiti", "KaiTi", "Songti SC", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const metrics = ctx.measureText(glyph);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.88;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.12;
  ctx.fillText(glyph, cx, cy + (ascent - descent) / 2);

  if (checked) {
    ctx.strokeStyle = 'rgba(255, 96, 78, 0.9)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(255, 96, 78, 0.8)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, PIECE_RADIUS + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowColor = 'transparent';
  }
  if (selected) {
    ctx.strokeStyle = '#e9b45f';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(233, 180, 95, 0.85)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, PIECE_RADIUS + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowColor = 'transparent';
  }

  ctx.restore();
}

/** 上一步起点：轻底 + 金色虚线棋子轮廓 + 半透明原棋子字。 */
function drawGhostPiece(
  ctx: CanvasRenderingContext2D,
  piece: string,
  cx: number,
  cy: number,
): void {
  const color = pieceColor(piece);
  const glyph = PIECE_GLYPH[piece] ?? piece;
  const fontSize = Math.round(CELL * 0.48);
  const radius = PIECE_RADIUS - 1;
  ctx.save();

  // 很轻的棋子底，让残影“有形”但不会像真棋子
  const fill = ctx.createRadialGradient(
    cx - radius * 0.35,
    cy - radius * 0.4,
    radius * 0.1,
    cx,
    cy,
    radius,
  );
  fill.addColorStop(0, 'rgba(255, 246, 226, 0.18)');
  fill.addColorStop(1, 'rgba(233, 180, 95, 0.04)');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // 外圈：加粗金色虚线 + 柔光
  ctx.globalAlpha = 0.92;
  ctx.setLineDash([7, 5]);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = 'rgba(244, 207, 148, 0.95)';
  ctx.shadowColor = 'rgba(233, 180, 95, 0.5)';
  ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.setLineDash([]);

  // 内圈：细虚线增加层次
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([3, 5]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 241, 214, 0.8)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // 原棋子字：保留可辨识度，但仍是半透明
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = color === 'red' ? 'rgba(165, 39, 26, 0.92)' : 'rgba(32, 38, 45, 0.9)';
  ctx.font = `700 ${fontSize}px "STKaiti", "KaiTi", "Songti SC", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 2;
  const metrics = ctx.measureText(glyph);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.88;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.12;
  ctx.fillText(glyph, cx, cy + (ascent - descent) / 2);
  ctx.restore();
}

function ChessBoardComponent({ game, myColor, interactive, onMove }: ChessBoardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [sizePx, setSizePx] = useState(0);
  const [selected, setSelected] = useState<Point | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [focused, setFocused] = useState(false);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [cursor, setCursor] = useState<Point>({ row: 7, col: 4 });

  const board = game.board;
  const myTurn = interactive;
  // 始终让玩家自己在下：执黑时整盘 180° 翻转。未入座/观战默认红方在下。
  const flipped = myColor === 'black';
  const toDisplay = useCallback(
    (point: Point): Point =>
      flipped ? { row: ROWS - 1 - point.row, col: COLS - 1 - point.col } : point,
    [flipped],
  );
  const toBoard = useCallback(
    (point: Point): Point =>
      flipped ? { row: ROWS - 1 - point.row, col: COLS - 1 - point.col } : point,
    [flipped],
  );
  const pieceAt = useCallback(
    (point: Point): string | null => {
      const source = toBoard(point);
      return board[source.row]?.[source.col] ?? null;
    },
    [board, toBoard],
  );

  const legalMoves = useMemo(() => {
    if (!selected || !myTurn) return [] as ChessLegalMove[];
    const origin = toBoard(selected);
    return game.legalMoves.filter(
      (move) => move.from.row === origin.row && move.from.col === origin.col,
    );
  }, [game.legalMoves, myTurn, selected, toBoard]);

  const legalTargets = useMemo(
    () =>
      new Set(
        legalMoves.map((move) => {
          const target = toDisplay(move.to);
          return `${target.row}:${target.col}`;
        }),
      ),
    [legalMoves, toDisplay],
  );

  const selectedBoardPoint = selected ? toBoard(selected) : null;
  const selectedPiece = selectedBoardPoint
    ? (board[selectedBoardPoint.row]?.[selectedBoardPoint.col] ?? null)
    : null;

  // 棋盘变化/换边后清空选择
  useEffect(() => {
    setSelected(null);
    setHover(null);
  }, [game.moves.length, game.currentTurn, myColor]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      if (width > 0) setSizePx((previous) => (previous === width ? previous : width));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    baseRef.current = document.createElement('canvas');
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || sizePx <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pixelWidth = Math.round(sizePx * dpr);
    const scale = pixelWidth / BOARD_W;
    const pixelHeight = Math.round(BOARD_H * scale);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.height = `${Math.round(pixelHeight / dpr)}px`;
    }
    const ctx = canvas.getContext('2d');
    const base = baseRef.current;
    if (!ctx || !base) return;
    if (base.width !== pixelWidth || base.height !== pixelHeight) {
      base.width = pixelWidth;
      base.height = pixelHeight;
    }
    const baseCtx = base.getContext('2d');
    if (!baseCtx) return;
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, pixelWidth, pixelHeight);
    baseCtx.setTransform(scale, 0, 0, scale, 0, 0);
    drawBoardBase(baseCtx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // 棋子
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const piece = board[row]?.[col];
        if (!piece) continue;
        const display = toDisplay({ row, col });
        const isCheckedKing =
          game.check &&
          ((game.currentTurn === 'red' && piece === 'K') ||
            (game.currentTurn === 'black' && piece === 'k'));
        drawPiece(ctx, piece, MARGIN + display.col * CELL, MARGIN + display.row * CELL, {
          selected: selected?.row === display.row && selected?.col === display.col,
          checked: isCheckedKing,
        });
      }
    }

    // 上一步：起点虚线棋子轮廓，落点棋子加虚线选中圈
    if (game.lastMove) {
      const from = toDisplay(game.lastMove.from);
      const to = toDisplay(game.lastMove.to);
      const fromX = MARGIN + from.col * CELL;
      const fromY = MARGIN + from.row * CELL;
      const toX = MARGIN + to.col * CELL;
      const toY = MARGIN + to.row * CELL;
      const lastMove = game.moves.length > 0 ? game.moves[game.moves.length - 1] : null;

      if (lastMove) {
        drawGhostPiece(ctx, lastMove.piece, fromX, fromY);
      }

      ctx.save();
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(244, 207, 148, 0.95)';
      ctx.shadowColor = 'rgba(233, 180, 95, 0.5)';
      ctx.shadowBlur = 9;
      ctx.beginPath();
      ctx.arc(toX, toY, PIECE_RADIUS + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 合法落点提示
    if (selectedPiece) {
      for (const move of legalMoves) {
        const display = toDisplay(move.to);
        const x = MARGIN + display.col * CELL;
        const y = MARGIN + display.row * CELL;
        const target = board[move.to.row]?.[move.to.col];
        if (target) {
          ctx.strokeStyle = 'rgba(233, 180, 95, 0.9)';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.arc(x, y, PIECE_RADIUS + 5, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          // 空落点用空心圈标在交叉点上，避免小圆点被看成“偏半格”。
          ctx.strokeStyle = 'rgba(233, 180, 95, 0.92)';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // 悬停提示
    if (interactive && hover) {
      const targetPiece = pieceAt(hover);
      if (targetPiece) {
        ctx.strokeStyle = 'rgba(255, 248, 231, 0.35)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(
          MARGIN + hover.col * CELL,
          MARGIN + hover.row * CELL,
          PIECE_RADIUS + 5,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    }

    // 键盘光标
    if (focused && keyboardNav) {
      const x = MARGIN + cursor.col * CELL;
      const y = MARGIN + cursor.row * CELL;
      ctx.strokeStyle = 'rgba(255, 246, 224, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const half = PIECE_RADIUS + 5;
      ctx.roundRect(x - half, y - half, half * 2, half * 2, 8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [
    board,
    game.check,
    game.currentTurn,
    game.lastMove,
    hover,
    interactive,
    keyboardNav,
    cursor.col,
    cursor.row,
    focused,
    legalMoves,
    selected,
    selectedPiece,
    sizePx,
    toDisplay,
    pieceAt,
    flipped,
  ]);

  const pointFromEvent = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * BOARD_W;
      const y = ((clientY - rect.top) / rect.height) * BOARD_H;
      const col = Math.round((x - MARGIN) / CELL);
      const row = Math.round((y - MARGIN) / CELL);
      if (!inBoard(row, col)) return null;
      const offsetX = Math.abs(x - (MARGIN + col * CELL));
      const offsetY = Math.abs(y - (MARGIN + row * CELL));
      if (offsetX > CELL * 0.48 || offsetY > CELL * 0.48) return null;
      return { row, col };
    },
    [],
  );

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!interactive || !myColor) return;
    const point = pointFromEvent(event.clientX, event.clientY);
    if (!point) {
      setSelected(null);
      return;
    }
    const piece = pieceAt(point);
    if (selected) {
      if (legalTargets.has(`${point.row}:${point.col}`)) {
        onMove({ from: toBoard(selected), to: toBoard(point) });
        setSelected(null);
        return;
      }
      if (piece && pieceColor(piece) === myColor) {
        setSelected(point);
        return;
      }
      setSelected(null);
      return;
    }
    if (piece && pieceColor(piece) === myColor && game.currentTurn === myColor) {
      setSelected(point);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) {
      if (hover) setHover(null);
      return;
    }
    const point = pointFromEvent(event.clientX, event.clientY);
    setHover((previous) => {
      if (!point) return previous === null ? previous : null;
      if (previous && previous.row === point.row && previous.col === point.col) return previous;
      return point;
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const moveCursor = (dr: number, dc: number): void => {
      setKeyboardNav(true);
      setCursor((previous) => ({
        row: Math.min(Math.max(previous.row + dr, 0), ROWS - 1),
        col: Math.min(Math.max(previous.col + dc, 0), COLS - 1),
      }));
    };
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        moveCursor(-1, 0);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveCursor(1, 0);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveCursor(0, -1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        moveCursor(0, 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!interactive || !myColor) return;
        const piece = pieceAt(cursor);
        if (selected && legalTargets.has(`${cursor.row}:${cursor.col}`)) {
          onMove({ from: toBoard(selected), to: toBoard(cursor) });
          setSelected(null);
        } else if (piece && pieceColor(piece) === myColor) {
          setSelected(cursor);
        } else {
          setSelected(null);
        }
        break;
      }
      case 'Escape':
        setSelected(null);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className={`board-frame chess-frame${focused ? ' is-focused' : ''}${interactive ? ' is-interactive' : ''}`}
      ref={frameRef}
      tabIndex={0}
      role="application"
      aria-label="中国象棋棋盘：点击选子后再点目标，方向键移动光标，回车确认"
      aria-disabled={!interactive}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        setFocused(true);
        setKeyboardNav(frameRef.current?.matches(':focus-visible') ?? false);
      }}
      onBlur={() => {
        setFocused(false);
        setKeyboardNav(false);
        setHover(null);
      }}
      onPointerDown={() => {
        setKeyboardNav(false);
        frameRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="board-surface chess-surface">
        <div
          className="chess-canvas-wrap"
          ref={wrapRef}
          style={{ aspectRatio: `${BOARD_W} / ${BOARD_H}` }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHover(null)}
          onClick={handleClick}
        >
          <canvas ref={canvasRef} className="chess-canvas" aria-hidden="true" />
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        共 {game.moves.length} 手，当前{game.currentTurn === 'red' ? '红方' : '黑方'}行棋
        {game.check ? '，被将军' : ''}
      </span>
    </div>
  );
}

export const ChessBoard = memo(ChessBoardComponent);
ChessBoard.displayName = 'ChessBoard';
