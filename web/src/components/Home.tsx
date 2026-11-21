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

/** 首页卡片里的游戏主题插画，全部用内联 SVG，无外部资源。 */
function GameArt({ kind }: { kind: string }) {
  if (kind === 'gomoku') {
    return (
      <svg className="game-art" viewBox="0 0 640 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g stroke="rgba(255, 255, 255, 0.11)" strokeWidth="1">
          {Array.from({ length: 11 }, (_, index) => (
            <line key={`v${index}`} x1={index * 64} y1="0" x2={index * 64} y2="160" />
          ))}
          {Array.from({ length: 6 }, (_, index) => (
            <line key={`h${index}`} x1="0" y1={index * 32} x2="640" y2={index * 32} />
          ))}
        </g>
        <line
          x1="220"
          y1="96"
          x2="412"
          y2="48"
          stroke="#e9b45f"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.75"
        />
        {[0, 1, 2, 3, 4].map((index) => (
          <circle
            key={index}
            cx={220 + index * 48}
            cy={96 - index * 12}
            r="11"
            fill="#111820"
            stroke="rgba(255, 255, 255, 0.22)"
            strokeWidth="1"
          />
        ))}
        <circle cx="510" cy="124" r="11" fill="#f6ead4" />
        <circle cx="126" cy="120" r="11" fill="#f6ead4" />
      </svg>
    );
  }

  if (kind === 'chess') {
    return (
      <svg className="game-art" viewBox="0 0 640 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g stroke="rgba(255, 236, 210, 0.12)" strokeWidth="1">
          {Array.from({ length: 11 }, (_, index) => (
            <line key={`v${index}`} x1={index * 64} y1="0" x2={index * 64} y2="160" />
          ))}
          {Array.from({ length: 6 }, (_, index) => (
            <line key={`h${index}`} x1="0" y1={index * 32} x2="640" y2={index * 32} />
          ))}
        </g>
        <g fontFamily="'STKaiti', 'KaiTi', serif" fontWeight="700" textAnchor="middle" dominantBaseline="central">
          <circle cx="198" cy="76" r="26" fill="#f3e0bd" stroke="#a5271a" strokeWidth="2" />
          <text x="198" y="77" fontSize="30" fill="#a5271a">帅</text>
          <circle cx="322" cy="102" r="26" fill="#f3e0bd" stroke="#20262d" strokeWidth="2" />
          <text x="322" y="103" fontSize="30" fill="#20262d">将</text>
          <circle cx="446" cy="62" r="26" fill="#f3e0bd" stroke="#a5271a" strokeWidth="2" />
          <text x="446" y="63" fontSize="30" fill="#a5271a">炮</text>
        </g>
        <path d="M198 102 L322 128" stroke="rgba(233, 180, 95, 0.4)" strokeWidth="1.5" strokeDasharray="5 5" />
      </svg>
    );
  }

  if (kind === 'tank') {
    return (
      <svg className="game-art" viewBox="0 0 640 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g stroke="rgba(216, 241, 209, 0.09)" strokeWidth="1">
          {Array.from({ length: 11 }, (_, index) => (
            <line key={`v${index}`} x1={index * 64} y1="0" x2={index * 64} y2="160" />
          ))}
          {Array.from({ length: 6 }, (_, index) => (
            <line key={`h${index}`} x1="0" y1={index * 32} x2="640" y2={index * 32} />
          ))}
        </g>
        <g transform="translate(180 26)">
          <rect x="0" y="40" width="280" height="54" rx="16" fill="#3c4e2c" stroke="#9cb17c" strokeWidth="1.5" />
          <rect x="48" y="12" width="128" height="38" rx="12" fill="#52683c" stroke="#a9be87" strokeWidth="1.5" />
          <rect x="168" y="26" width="126" height="11" rx="5.5" fill="#a9be87" />
          <circle cx="46" cy="96" r="13" fill="#141c10" stroke="#7e9462" strokeWidth="1.5" />
          <circle cx="116" cy="96" r="13" fill="#141c10" stroke="#7e9462" strokeWidth="1.5" />
          <circle cx="186" cy="96" r="13" fill="#141c10" stroke="#7e9462" strokeWidth="1.5" />
          <circle cx="256" cy="96" r="13" fill="#141c10" stroke="#7e9462" strokeWidth="1.5" />
        </g>
        <path d="M60 128h72M500 44h70" stroke="rgba(233, 180, 95, 0.5)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  return null;
}

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
      <div className={`game-card-cover cover-${game.key}`}>
        <GameArt kind={game.key} />
        <div className="game-card-cover-top">
          <span className="game-card-mode">
            {MODE_LABEL[game.mode]} · {game.players}
          </span>
          {playable ? null : <span className="game-card-status">开发中</span>}
        </div>
      </div>

      <div className="game-card-body">
        <div className="game-card-heading">
          <span className={`game-card-icon game-${game.key}`} aria-hidden="true">
            {game.icon}
          </span>
          <h3 className="game-card-title">{game.label}</h3>
        </div>
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
      </div>
    </article>
  );
}

function MoreGamesCard() {
  return (
    <article className="game-card card glass is-planned is-placeholder">
      <div className="game-card-cover cover-soon">
        <span className="cover-soon-mark" aria-hidden="true">
          ＋
        </span>
        <span className="cover-soon-caption">更多玩法</span>
      </div>
      <div className="game-card-body">
        <h3 className="game-card-title">更多小游戏</h3>
        <p className="game-card-desc">
          坦克大战等实时玩法正在开发中，之后还会继续加入新游戏。欢迎和朋友常来玩。
        </p>
        <div className="game-card-foot">
          <span className="game-card-soon">敬请期待</span>
        </div>
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
              {category.key === 'action' ? <MoreGamesCard /> : null}
            </div>
          </section>
        );
      })}
    </section>
  );
}
