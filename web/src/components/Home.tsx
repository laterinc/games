import type { GameType } from '../types';
import { GAME_CATALOG, GAME_CATEGORIES } from '../games/registry';
import type { GameListing, GameMode } from '../games/types';

interface HomeProps {
  connected: boolean;
  onOpenGame: (game: GameType) => void;
}

const MODE_LABEL: Record<GameMode, string> = {
  'turn-based': '回合制',
  realtime: '实时',
};

function GameCard({
  game,
  onOpenGame,
}: {
  game: GameListing;
  onOpenGame: (game: GameType) => void;
}) {
  const playable = game.status === 'available' && game.game !== null;
  return (
    <article className={`game-card card glass${playable ? '' : ' is-planned'}`}>
      <div className="game-card-top">
        <span className={`game-card-icon game-${game.key}`} aria-hidden="true">
          {game.icon}
        </span>
        <span className="game-card-mode">
          {MODE_LABEL[game.mode]} · {game.players}
        </span>
        {playable ? null : <span className="game-card-status">开发中</span>}
      </div>

      <h3 className="game-card-title">{game.label}</h3>
      <p className="game-card-desc">{game.description}</p>

      <ul className="game-card-tags" aria-label="游戏特性">
        {game.tags.map((tag) => (
          <li key={tag}>{tag}</li>
        ))}
      </ul>

      <div className="game-card-foot">
        {playable ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-small"
              aria-label={`进入${game.label}`}
              onClick={() => onOpenGame(game.game as GameType)}
            >
              进入游戏
            </button>
            <span className="game-card-short">{game.short}</span>
          </>
        ) : (
          <span className="game-card-soon">敬请期待</span>
        )}
      </div>
    </article>
  );
}

/** 游戏中心首页：按分类展示全部已上线游戏与开发中游戏。 */
export function Home({ connected, onOpenGame }: HomeProps) {
  const playableCount = GAME_CATALOG.filter((game) => game.status === 'available').length;

  return (
    <section className="home">
      <div className="home-hero card glass">
        <div className="home-hero-copy">
          <span className="hero-eyebrow">
            <span className="live-dot" aria-hidden="true" />
            游戏中心 · 无需注册
          </span>
          <h1 className="home-title">选一个游戏，马上开局</h1>
          <p className="home-sub">
            棋类回合制与实时对战，全部在浏览器里联机。服务端裁判、邀请好友、断线可续。
          </p>
          <div className="home-hero-meta">
            <span>{playableCount} 款游戏可玩</span>
            <span>{connected ? '联机服务已就绪' : '正在连接服务器…'}</span>
            <span>更多游戏持续接入</span>
          </div>
        </div>

        <div className="home-hero-art" aria-hidden="true">
          <span className="home-art-tile tile-gomoku">五</span>
          <span className="home-art-tile tile-chess">象</span>
          <span className="home-art-tile tile-tank">坦</span>
        </div>
      </div>

      {GAME_CATEGORIES.map((category) => {
        const games = GAME_CATALOG.filter((game) => game.category === category.key);
        if (games.length === 0) return null;
        const available = games.filter((game) => game.status === 'available').length;
        return (
          <section className="home-section" key={category.key}>
            <header className="home-section-head">
              <div>
                <h2>{category.label}</h2>
                <p>{category.description}</p>
              </div>
              <span className="home-section-count">
                {available > 0 ? `${available} 款可玩` : '开发中'}
              </span>
            </header>
            <div className="game-grid">
              {games.map((game) => (
                <GameCard key={game.key} game={game} onOpenGame={onOpenGame} />
              ))}
            </div>
          </section>
        );
      })}

      <div className="home-roadmap card glass">
        <div>
          <h2>更多游戏正在接入</h2>
          <p>
            新游戏按“一个游戏一个目录”扩展：路由、房间、邀请链接与首页卡片自动生效。实时游戏将使用
            tick + 二进制增量快照，回合制继续使用 JSON。
          </p>
        </div>
        <span className="home-roadmap-badge">协议 v3 规划中</span>
      </div>
    </section>
  );
}
