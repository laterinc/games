import { useEffect, useRef, useState } from 'react';
import { Home } from './components/Home';
import { Lobby } from './components/Lobby';
import { RoomView } from './components/RoomView';
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
  const { state, actions } = useGameSocket();
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
        ? '棋类游戏 · 游戏中心'
        : `棋类游戏 · ${GAME_LABEL[gameType]}`;
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
        <a
          className="brand"
          href={homePath()}
          onClick={(event) => {
            event.preventDefault();
            navigate(homePath());
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            <span className="brand-stone black" />
            <span className="brand-stone white" />
          </span>
          <span className="brand-name">棋类游戏</span>
          <span className="brand-sub">游戏中心</span>
        </a>
        <span className={`conn-pill ${state.status}`}>
          <span className="conn-dot" aria-hidden="true" />
          {STATUS_TEXT[state.status]}
        </span>
      </header>

      <main className="app-main">
        {state.room ? (
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
            onAiGame={(color) => actions.createAiRoom(nickname, gameType, color)}
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
