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
          <button
            type="button"
            className="btn btn-primary btn-small"
            aria-label={`进入${game.label}`}
            onClick={() => onOpenGame(game.game as GameType)}
          >
            进入游戏
          </button>
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
            好友同乐 · 无需注册
          </span>
          <h1 className="home-title">和朋友，随时开一局</h1>
          <p className="home-sub">
            五子棋、中国象棋，打开浏览器就能玩。约上朋友、开个房间，输赢都图个开心。
          </p>
          <div className="home-hero-meta">
            <span>{playableCount} 款游戏</span>
            <span>打开即玩</span>
            <span>{connected ? '好友可加入' : '正在连接…'}</span>
          </div>
        </div>

        <div className="home-hero-art" aria-hidden="true">
          <span className="home-art-tile tile-gomoku">五</span>
          <span className="home-art-tile tile-chess">象</span>
          <span className="home-art-tile tile-tank">坦</span>
        </div>
      </div>

      <div className="home-notice card glass" role="note">
        <span className="home-notice-badge">友情提示</span>
        <p>
          本站仅供朋友之间休闲娱乐，不提供赌博、押注、抽奖或任何真实货币交易。请文明游戏，友好交流。
        </p>
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
          <h2>更多小游戏在路上</h2>
          <p>坦克大战等实时玩法正在开发中，上线后会直接出现在这里。叫上朋友，一起等下一局。</p>
        </div>
        <span className="home-roadmap-badge">陆续上线</span>
      </div>
    </section>
  );
}
