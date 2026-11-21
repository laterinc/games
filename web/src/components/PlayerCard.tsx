import type { Color, Player } from '../types';
import { COLOR_LABEL } from '../lib/protocol';

interface PlayerCardProps {
  /** 该座位上的玩家；null 表示空座（等待加入）。 */
  player: Player | null;
  seatColor: Color;
  isMe: boolean;
}

/** 双方信息卡：昵称、黑白、在线/掉线、准备状态、房主标识。 */
export function PlayerCard({ player, seatColor, isMe }: PlayerCardProps) {
  const offline = player !== null && !player.connected;
  return (
    <div
      className={`player-card${isMe ? ' is-me' : ''}${offline ? ' is-offline' : ''}${
        player ? '' : ' is-empty'
      }`}
    >
      <span className={`stone-badge stone-${seatColor}`} aria-hidden="true" />
      <div className="player-main">
        <div className="player-name-row">
          <span className="player-name">{player ? player.name : '等待加入…'}</span>
          {player?.isBot ? <span className="badge badge-bot">电脑</span> : null}
          {player?.isHost ? <span className="badge badge-host">房主</span> : null}
          {isMe ? <span className="badge badge-me">我</span> : null}
        </div>
        <div className="player-meta">
          {player ? (
            <>
              <span className={`online-dot${player.connected ? ' is-online' : ' is-offline'}`} />
              <span>{player.connected ? '在线' : '掉线'}</span>
              <span className="meta-divider">·</span>
              <span>{COLOR_LABEL[seatColor]}</span>
              {player.ready ? <span className="badge badge-ready">已准备</span> : null}
            </>
          ) : (
            <>
              <span className="online-dot" />
              <span>空座</span>
              <span className="meta-divider">·</span>
              <span>{COLOR_LABEL[seatColor]}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
