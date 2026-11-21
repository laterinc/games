import { useEffect, useRef, useState } from 'react';
import { Lobby } from './components/Lobby';
import { RoomView } from './components/RoomView';
import { Toast } from './components/Toast';
import { useGameSocket } from './hooks/useGameSocket';
import type { GameType } from './types';
import { GAME_LABEL } from './lib/protocol';
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

function readGameFromUrl(): GameType {
  try {
    const raw = new URLSearchParams(window.location.search).get('game') ?? '';
    return raw === 'chess' ? 'chess' : 'gomoku';
  } catch {
    return 'gomoku';
  }
}

function readRoomCodeFromUrl(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get('room') ?? '';
    return raw
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 6)
      .toUpperCase();
  } catch {
    return '';
  }
}

export default function App() {
  const { state, actions } = useGameSocket();
  const [nickname, setNickname] = useState(() => loadNickname() || randomNickname());
  const [gameType, setGameType] = useState<GameType>(readGameFromUrl);
  const [initialRoomCode] = useState(readRoomCodeFromUrl);
  const syncedRoomRef = useRef<string | null>(null);

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

  // 房间 ID 同步到 URL，刷新/分享链接可回到对应入口；离开后移除。
  useEffect(() => {
    const room = state.room;
    const params = new URLSearchParams(window.location.search);
    if (room) {
      if (params.get('room') === room.id) {
        syncedRoomRef.current = room.id;
        return;
      }
      params.set('room', room.id);
      syncedRoomRef.current = room.id;
    } else if (syncedRoomRef.current) {
      params.delete('room');
      syncedRoomRef.current = null;
    } else {
      return;
    }
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
  }, [state.room]);

  useEffect(() => {
    document.title = state.room
      ? `${state.room.name} · ${GAME_LABEL[state.room.gameType]}`
      : `棋类游戏 · ${GAME_LABEL[gameType]}`;
  }, [state.room, gameType]);

  // 进入房间时以房间实际游戏为准；URL 里保留 game 参数便于刷新
  useEffect(() => {
    if (state.room) setGameType(state.room.gameType);
  }, [state.room?.gameType]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('game') === gameType) return;
    params.set('game', gameType);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params.toString()}${window.location.hash}`,
    );
  }, [gameType]);

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
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span className="brand-stone black" />
            <span className="brand-stone white" />
          </span>
          <span className="brand-name">棋类游戏</span>
          <span className="brand-sub">五子棋 · 中国象棋</span>
        </div>
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
        ) : (
          <Lobby
            nickname={nickname}
            onNicknameChange={setNickname}
            rooms={state.rooms}
            connected={state.status === 'open'}
            gameType={gameType}
            onGameTypeChange={setGameType}
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

      <footer className="app-footer">游戏协议 v2 · 服务端为唯一裁判</footer>
    </div>
  );
}
