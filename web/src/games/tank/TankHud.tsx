/**
 * 坦克大战 HUD：纯 DOM 覆盖层（比分榜、血量/装填、计时、击杀播报、小地图）。
 *
 * 小地图用 Canvas 2D 直接绘制（与棋盘渲染方式一致），只依赖 10Hz 的 HUD 快照，
 * 不参与 three.js 渲染循环。
 */
import { useEffect, useRef } from 'react';
import type { Room, TankGame } from '../../types';
import { TANK_COLORS } from './palette';
import type { TankCameraMode } from './scene';

export interface KillFeedItem {
  id: number;
  text: string;
  tone: 'self' | 'enemy' | 'system';
  at: number;
}

export interface HudBlip {
  id: number;
  slot: number;
  kind: 0 | 1;
  x: number;
  y: number;
  hull: number;
  hp: number;
}

export interface TankHudState {
  hp: number;
  alive: boolean;
  /** 0–1，装填完成度。 */
  reload: number;
  timeLeft: number;
  scores: Record<string, { kills: number; deaths: number }>;
  feed: KillFeedItem[];
  cameraMode: TankCameraMode;
  tickRate: number;
  blips: HudBlip[];
  /** 最近一次掉血的时间戳（performance.now），HUD 用它触发一次性红闪。 */
  hitAt: number;
  /** 阵亡后经过的秒数（存活时为 0），用于复活倒计时。 */
  deadFor: number;
}

interface TankHudProps {
  room: Room;
  game: TankGame;
  hud: TankHudState;
  cameraMode: TankCameraMode;
  playerId: string | null;
  isSpectator: boolean;
  ranking: Room['players'];
  localSlot: number | null;
  onCycleCamera: () => void;
  controlMode: 'tank' | 'arcade';
  onToggleControl: () => void;
  soundOn: boolean;
  onToggleSound: () => void;
  onExit: () => void;
}

const CAMERA_LABEL: Record<TankCameraMode, string> = {
  iso: '等距视角',
  chase: '追尾视角',
  top: '全场视角',
};

function TankMinimap({
  map,
  blips,
  localId,
}: {
  map: TankGame['map'];
  blips: HudBlip[];
  localId: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;
    const size = 176;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size, size);
    const scale = size / Math.max(map.width, map.height);
    context.fillStyle = 'rgba(8, 14, 20, 0.82)';
    context.fillRect(0, 0, size, size);

    // 掩体
    context.fillStyle = 'rgba(150, 172, 190, 0.35)';
    for (const obstacle of map.obstacles) {
      context.fillRect(
        obstacle.x * scale,
        obstacle.y * scale,
        Math.max(1, obstacle.w * scale),
        Math.max(1, obstacle.h * scale),
      );
    }

    // 实体
    for (const blip of blips) {
      if (blip.kind === 1) {
        context.fillStyle = 'rgba(255, 226, 150, 0.9)';
        context.fillRect(blip.x * scale - 1, blip.y * scale - 1, 2, 2);
        continue;
      }
      const color = TANK_COLORS[blip.slot % TANK_COLORS.length] ?? '#fff';
      const isLocal = blip.id === localId;
      const radius = isLocal ? 3.6 : 2.8;
      context.beginPath();
      context.arc(blip.x * scale, blip.y * scale, radius, 0, Math.PI * 2);
      context.fillStyle = isLocal ? '#ffffff' : color;
      context.fill();
      if (isLocal) {
        context.strokeStyle = color;
        context.lineWidth = 1.6;
        context.stroke();
      }
      // 朝向短线段
      context.beginPath();
      context.moveTo(blip.x * scale, blip.y * scale);
      context.lineTo(
        blip.x * scale + Math.cos(blip.hull) * 6,
        blip.y * scale + Math.sin(blip.hull) * 6,
      );
      context.strokeStyle = color;
      context.lineWidth = 1.4;
      context.stroke();
    }
  }, [map, blips, localId]);

  return <canvas ref={canvasRef} className="tank-minimap" aria-label="小地图" />;
}

export function TankHud({
  room,
  game,
  hud,
  cameraMode,
  playerId,
  isSpectator,
  ranking,
  localSlot,
  onCycleCamera,
  controlMode,
  onToggleControl,
  soundOn,
  onToggleSound,
  onExit,
}: TankHudProps) {
  const localId = localSlot !== null ? localSlot + 1 : null;
  const hpPercent = Math.max(0, Math.min(100, hud.hp));
  const reloadPercent = Math.round(hud.reload * 100);
  const leaderKills = ranking.reduce(
    (best, player) => Math.max(best, hud.scores[player.id]?.kills ?? 0),
    0,
  );

  return (
    <div className={`tank-hud${!isSpectator && hud.alive && hud.hp <= 25 ? ' is-low-hp' : ''}`}>
      {hud.hitAt > 0 ? <div key={hud.hitAt} className="tank-hit-flash" aria-hidden="true" /> : null}
      <div className="tank-hud-top">
        <span className="tank-hud-room">
          {room.name}
          <span className="tank-hud-code">{room.id}</span>
        </span>
        <span className="tank-hud-timer" role="timer">
          <span className="tank-hud-timer-label">剩余</span>
          {Math.floor(hud.timeLeft / 60)}:{String(hud.timeLeft % 60).padStart(2, '0')}
        </span>
        <span className="tank-hud-actions">
          <span className="tank-hud-goal">先到 {game.targetKills} 杀</span>
          <button type="button" className="tank-hud-btn" onClick={onCycleCamera}>
            {CAMERA_LABEL[cameraMode]}（V）
          </button>
          <button
            type="button"
            className={`tank-hud-btn${controlMode === 'arcade' ? ' is-on' : ''}`}
            onClick={onToggleControl}
            title="坦克式：A/D 原地转向；街机式：WASD 按屏幕方向移动"
          >
            {controlMode === 'arcade' ? '街机操作' : '坦克操作'}
          </button>
          <button
            type="button"
            className={`tank-hud-btn${soundOn ? '' : ' is-off'}`}
            onClick={onToggleSound}
            aria-pressed={soundOn}
          >
            {soundOn ? '音效开' : '音效关'}
          </button>
          <button type="button" className="tank-hud-btn" onClick={onExit}>
            离开
          </button>
        </span>
      </div>

      <div className="tank-hud-left">
        <ul className="tank-scoreboard" aria-label="比分榜">
          {ranking.map((player, index) => {
            const score = hud.scores[player.id] ?? { kills: 0, deaths: 0 };
            const color = TANK_COLORS[(player.slot ?? index) % TANK_COLORS.length] ?? '#fff';
            return (
              <li
                key={player.id}
                className={`tank-score-row${player.id === playerId ? ' is-me' : ''}`}
              >
                <span className="tank-score-bar" style={{ background: color }} />
                <span className="tank-score-name">{player.name}</span>
                <span className="tank-score-kills">{score.kills}</span>
                <span className="tank-score-deaths">/{score.deaths}</span>
              </li>
            );
          })}
        </ul>

        <div className="tank-feed" aria-live="polite">
          {hud.feed.map((item) => (
            <div key={item.id} className={`tank-feed-item tone-${item.tone}`}>
              {item.text}
            </div>
          ))}
        </div>
      </div>

      <div className="tank-hud-bottom-left">
        <div className="tank-vitals">
          <span className="tank-vitals-label">装甲</span>
          <span className="tank-hp-track">
            <span
              className={`tank-hp-fill${hpPercent <= 25 ? ' is-critical' : ''}`}
              style={{ width: `${hpPercent}%` }}
            />
          </span>
          <span className="tank-hp-value">{Math.round(hpPercent)}</span>
        </div>
        <div className="tank-vitals">
          <span className="tank-vitals-label">装填</span>
          <span className="tank-reload-track">
            <span className="tank-reload-fill" style={{ width: `${reloadPercent}%` }} />
          </span>
          <span className="tank-hp-value">
            {reloadPercent >= 100 ? '就绪' : `${Math.max(1, Math.ceil((100 - reloadPercent) / 100 * 0.9 * 10)) / 10}s`}
          </span>
        </div>
        {!isSpectator && hud.alive && hud.hp <= 25 ? (
          <p className="tank-hp-warning">装甲严重受损</p>
        ) : null}
        <p className="tank-controls-hint">
          {controlMode === 'arcade'
            ? '鼠标移动准星（炮塔跟随）· WASD 按屏幕方向移动 · 左键开火 · Shift 刹车 · 滚轮缩放 · Alt 释放鼠标'
            : '鼠标移动准星（炮塔跟随）· A/D 原地转向 · W/S 前进倒车 · 左键开火 · Shift 刹车 · Alt 释放鼠标'}
        </p>
      </div>

      <div className="tank-hud-bottom-right">
        <TankMinimap map={game.map} blips={hud.blips} localId={localId} />
      </div>

      {isSpectator ? <div className="tank-badge tank-badge-spectator">观战中</div> : null}
      {leaderKills > 0 ? (
        <div className="tank-badge tank-badge-leader">本局最高 {leaderKills} 杀</div>
      ) : null}
      {!isSpectator && !hud.alive ? (
        <div className="tank-dead-hint">
          已被击毁 · {Math.max(0, Math.ceil(3 - hud.deadFor))} 秒后复活
        </div>
      ) : null}
    </div>
  );
}
