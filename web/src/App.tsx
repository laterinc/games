import { useEffect, useRef, useState } from 'react';
import { Home } from './components/Home';
import { Lobby } from './components/Lobby';
import { RoomView } from './components/RoomView';
import { TankRoom } from './games/tank/TankRoom';
import { Toast } from './components/Toast';
import { useGameSocket } from './hooks/useGameSocket';
import type { GameType } from './types';
import { DEFAULT_GAME, GAME_LABEL } from './games/registry';
import { homePath, lobbyPath, navigate, roomPath, useRoute } from './lib/router';
import type { SocketStatus } from './lib/socket';
import { loadNickname, randomNickname, saveNickname } from './lib/session';
import { unlockAudio } from './lib/sound';

const STATUS_TEXT: Record<SocketStatus, string> = {
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '连接已断开，正在重连…',
  closed: '连接已关闭',
  replaced: '该身份已在其他窗口建立连接，本页已暂停同步（刷新页面可重新接管）',
};

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export default function App() {
  const route = useRoute();
  const { state, actions, socket } = useGameSocket();
  const [nickname, setNickname] = useState(() => loadNickname() || randomNickname());
  const hadRoomRef = useRef(false);
  const lastRoomGameRef = useRef<GameType | null>(null);

  // 大厅展示的游戏来自 URI（/gomoku、/chess）；邀请链接在加入前也可确定游戏。
  const gameType: GameType =
    route.name === 'lobby'
      ? route.game
      : route.name === 'room'
        ? (route.game ?? state.room?.gameType ?? DEFAULT_GAME)
        : DEFAULT_GAME;
  const initialRoomCode = route.name === 'room' ? route.roomCode : '';

  useEffect(() => {
    if (nickname.trim()) saveNickname(nickname);
  }, [nickname]);

  // 浏览器自动播放限制：首次用户手势时解锁 WebAudio
  useEffect(() => {
    const unlock = (): void => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // 首帧把 /、?game=、?room= 规范成路径路由，兼容已经分享出去的旧链接。
  useEffect(() => {
    const target =
      route.name === 'home'
        ? homePath()
        : route.name === 'lobby'
          ? lobbyPath(route.game)
          : roomPath(route.game, route.roomCode);
    if (currentUrl() !== target) navigate(target, { replace: true });
    // 只在首次挂载时执行；后续 URL 变化由下面的房间同步逻辑处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进入/切换房间后，把 URL 规范成 /{game}/room/{code}（服务端返回的游戏为准）。
  useEffect(() => {
    if (!state.room) return;
    hadRoomRef.current = true;
    lastRoomGameRef.current = state.room.gameType;
    const target = roomPath(state.room.gameType, state.room.id);
    if (window.location.pathname !== target) navigate(target, { replace: true });
  }, [state.room, route]);

  // 浏览器后退回到首页/大厅时仍在房间里：保持对局页，需明确点「离开」才退出。
  useEffect(() => {
    if (!state.room || route.name === 'room') return;
    navigate(roomPath(state.room.gameType, state.room.id), { replace: true });
  }, [state.room, route]);

  // 离开房间后回到该游戏的大厅。
  useEffect(() => {
    if (state.room || !hadRoomRef.current) return;
    hadRoomRef.current = false;
    const game =
      lastRoomGameRef.current ??
      (route.name === 'room' ? route.game : null) ??
      DEFAULT_GAME;
    navigate(lobbyPath(game), { replace: true });
  }, [state.room, route]);

  useEffect(() => {
    document.title = state.room
      ? `${state.room.name} · ${GAME_LABEL[state.room.gameType]}`
      : route.name === 'home'
        ? '游戏中心'
        : `游戏中心 · ${GAME_LABEL[gameType]}`;
  }, [state.room, gameType, route.name]);

  const disconnected = state.status !== 'open';
  const isSpectator =
    state.room !== null &&
    state.playerId !== null &&
    !state.room.players.some((player) => player.id === state.playerId);

  return (
    <div className="app-shell">
      {disconnected ? (
        <div className={`conn-banner ${state.status}`} role="status">
          <span className="conn-spinner" aria-hidden="true" />
          <span>{STATUS_TEXT[state.status]}</span>
          {state.room ? (
            <span className="conn-banner-note">对局状态已保留，重连后自动恢复</span>
          ) : null}
        </div>
      ) : null}

      <header className="app-header">
        <div className="header-left">
        <a
          className="brand"
          href={homePath()}
          onClick={(event) => {
            event.preventDefault();
            navigate(homePath());
          }}
        >
          <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
            <defs>
              <linearGradient id="brand-tile" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#e0b273" />
                <stop offset="0.55" stopColor="#b27c3f" />
                <stop offset="1" stopColor="#8c5c2b" />
              </linearGradient>
            </defs>
            <rect width="40" height="40" rx="12" fill="url(#brand-tile)" />
            <rect x="8" y="8" width="10" height="10" rx="3" fill="#121820" />
            <rect x="22" y="8" width="10" height="10" rx="3" fill="#f6ead4" />
            <rect x="8" y="22" width="10" height="10" rx="3" fill="#f6ead4" />
            <rect x="22" y="22" width="10" height="10" rx="3" fill="#b53722" />
          </svg>
          <span className="brand-name">游戏中心</span>
          <span className="brand-sub">好友休闲</span>
        </a>
          {route.name !== 'home' && !state.room ? (
            <button
              type="button"
              className="header-back"
              onClick={() => navigate(homePath())}
              aria-label="返回游戏中心"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M15 5 8 12l7 7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>返回游戏中心</span>
            </button>
          ) : null}
        </div>

        <span className={`conn-pill ${state.status}`}>
          <span className="conn-dot" aria-hidden="true" />
          {STATUS_TEXT[state.status]}
        </span>
      </header>

      <main className="app-main">
        {state.room && state.room.gameType === 'tank' ? (
          <TankRoom
            room={state.room}
            socket={socket}
            status={state.status}
            playerId={state.playerId}
            isSpectator={isSpectator}
            chat={state.chat}
            onReady={actions.ready}
            onRematch={actions.rematch}
            onLeave={actions.leaveRoom}
            onChat={actions.chat}
            notify={actions.notify}
          />
        ) : state.room ? (
          <RoomView
            room={state.room}
            status={state.status}
            playerId={state.playerId}
            isSpectator={isSpectator}
            chat={state.chat}
            onMove={actions.move}
            onReady={actions.ready}
            onRematch={actions.rematch}
            onResign={actions.resign}
            onUndo={actions.undoRequest}
            onUndoResponse={actions.undoResponse}
            onLeave={actions.leaveRoom}
            onChat={actions.chat}
            notify={actions.notify}
          />
        ) : route.name === 'home' ? (
          <Home connected={state.status === 'open'} onOpenGame={(game) => navigate(lobbyPath(game))} />
        ) : (
          <Lobby
            nickname={nickname}
            onNicknameChange={setNickname}
            rooms={state.rooms}
            connected={state.status === 'open'}
            gameType={gameType}
            initialRoomCode={initialRoomCode}
            onQuickMatch={() => actions.quickMatch(nickname, gameType)}
            onCreateRoom={(options) =>
              actions.createRoom({ name: nickname, gameType, ...options })
            }
            onAiGame={(color, boardSize, botCount, botDifficulty) =>
              actions.createAiRoom(nickname, gameType, color, boardSize, botCount, botDifficulty)
            }
            records={state.records}
            onJoinRoom={(roomId) => actions.joinRoom(roomId, nickname)}
            onWatchRoom={(roomId) => actions.watchRoom(roomId, nickname)}
            onRefreshRooms={actions.refreshRooms}
            notify={actions.notify}
          />
        )}
      </main>

      <Toast toasts={state.toasts} onDismiss={actions.dismissToast} />

      <footer className="app-footer">仅供朋友之间休闲娱乐 · 请勿用于赌博或商业用途</footer>
    </div>
  );
}
