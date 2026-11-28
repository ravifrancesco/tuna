import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';

/**
 * The loading animation (as on the apps' loading page, apps/common/loading.html): the note's stem
 * hangs on a line, bent into a hook, and the fish nibbles at it, the hook twitching each time. Once
 * Tuna is ready it bites, and the tug tilts it into the logo.
 */
const F = (x: number, y: number, r = 0) => `translate(${x}px,${y}px) translate(41.34px,45.49px) rotate(${r}deg) translate(-41.34px,-45.49px)`;
type Frame = [at: string, x: number, y: number, ease?: string, r?: number];
const keyframes = (name: string, frames: Frame[], move: (f: Frame) => string) =>
  `@keyframes ${name}{${frames.map((f) => `${f[0]}{transform:${move(f)}${f[3] ? `;animation-timing-function:${f[3]}` : ''}}`).join('')}}`;
const DART = 'cubic-bezier(.5,0,.9,.5)';
const BACK = 'cubic-bezier(.2,.7,.4,1)';
/** Hovering, a dart in to touch the hook's point and back; then two quick ones. At rest at 0% and 42%. */
const NIBBLE: Frame[] = [
  ['0%', -16.5, -1.8, 'ease-in-out'],
  ['14%', -14.5, -2.4, DART],
  ['20%', -10, -1.5, BACK],
  ['32%', -15.5, -1.3, 'ease-in-out'],
  ['42%', -16.5, -1.8, 'ease-in-out'],
  ['54%', -14, -2.2, DART],
  ['59%', -10.5, -1.6, BACK],
  ['65%', -13, -1.4, DART],
  ['70%', -10.2, -1.5, BACK],
  ['84%', -15.8, -2.1, 'ease-in-out'],
  ['100%', -16.5, -1.8],
];
/** From rest: a little wind-up, one snap that takes the whole hook, then the tug tilts it nose-up. */
const BITE: Frame[] = [
  ['0%', -16.5, -1.8, 'cubic-bezier(.4,0,.6,1)'],
  ['22%', -18.5, -1.4, 'cubic-bezier(.7,0,1,.6)'],
  ['40%', 0, -1, 'cubic-bezier(.3,1.5,.5,1)'],
  ['62%,100%', 0.02, -2.8, undefined, -12],
];
const fish = (f: Frame) => F(f[1], f[2], f[4]);
// The tail keeps up with the fish and, once it's hooked, settles level, as in the logo.
const tail = (f: Frame) => (f[4] ? 'translate(.14px,1.31px)' : `translate(${f[1]}px,${f[2]}px)`);

const CSS = `
.tl svg{display:block;width:96px;height:96px;overflow:visible}
.tl .all,.tl .hook,.tl .fish,.tl .tailpos{transform-box:view-box;transform-origin:0 0}
.tl .fish{transform:${F(0.02, -2.8, -12)}}
.tl .tailpos{transform:translate(.14px,1.31px)}
.tl .tail{transform-box:view-box;transform-origin:0 0;animation:tl-wag .45s ease-in-out infinite alternate}
.tl .fish{animation:tl-fish 2.4s infinite}.tl .tailpos{animation:tl-tail 2.4s infinite}.tl .hook{animation:tl-hook 2.4s infinite}
.tl.is-biting .fish{animation:tl-bite-fish 1s forwards}.tl.is-biting .tailpos{animation:tl-bite-tail 1s forwards}.tl.is-biting .hook{animation:none}
.tl.is-biting .curl{animation:tl-curl 1s forwards}.tl.is-biting .all{animation:tl-tug 1s}.tl.is-biting .tail{animation:tl-thrash 1s}
.tl.is-logo .fish,.tl.is-logo .tailpos,.tl.is-logo .hook,.tl.is-logo .tail{animation:none}.tl.is-logo .curl{opacity:0}
${keyframes('tl-fish', NIBBLE, fish)}
${keyframes('tl-tail', NIBBLE, tail)}
${keyframes('tl-bite-fish', BITE, fish)}
${keyframes('tl-bite-tail', BITE, tail)}
@keyframes tl-hook{0%,19.5%{transform:translate(0,0);animation-timing-function:cubic-bezier(.2,.8,.3,1)}23%{transform:translate(0,1.4px);animation-timing-function:ease-in-out}29%{transform:translate(0,-.5px);animation-timing-function:ease-in-out}36%{transform:translate(0,.2px);animation-timing-function:ease-in-out}42%,58.5%{transform:translate(0,0);animation-timing-function:cubic-bezier(.2,.8,.3,1)}62%{transform:translate(0,1.1px);animation-timing-function:ease-in-out}69.5%{transform:translate(0,-.2px);animation-timing-function:cubic-bezier(.2,.8,.3,1)}73%{transform:translate(0,1.4px);animation-timing-function:ease-in-out}80%{transform:translate(0,-.5px);animation-timing-function:ease-in-out}88%{transform:translate(0,.15px);animation-timing-function:ease-in-out}94%,100%{transform:translate(0,0)}}
@keyframes tl-curl{0%,39%{opacity:1;animation-timing-function:steps(1,end)}40%,100%{opacity:0}}
@keyframes tl-tug{0%,40%{transform:translate(0,0);animation-timing-function:cubic-bezier(.2,.8,.3,1)}48%{transform:translate(0,-5px);animation-timing-function:ease-in-out}60%{transform:translate(0,1px);animation-timing-function:ease-in-out}70%{transform:translate(0,0);animation-timing-function:ease-in-out}85%{transform:translate(0,-1.5px);animation-timing-function:ease-in-out}100%{transform:translate(0,0)}}
@keyframes tl-thrash{0%{transform:translate(10.8px,44px) rotate(-10deg) translate(-10.8px,-44px)}15%{transform:translate(10.8px,44px) rotate(14deg) translate(-10.8px,-44px)}30%{transform:translate(10.8px,44px) rotate(-14deg) translate(-10.8px,-44px)}45%{transform:translate(10.8px,44px) rotate(12deg) translate(-10.8px,-44px)}60%{transform:translate(10.8px,44px) rotate(-8deg) translate(-10.8px,-44px)}78%{transform:translate(10.8px,44px) rotate(4deg) translate(-10.8px,-44px)}100%{transform:translate(10.8px,44px) rotate(0deg) translate(-10.8px,-44px)}}
@keyframes tl-wag{from{transform:translate(10.8px,44px) rotate(-10deg) translate(-10.8px,-44px)}to{transform:translate(10.8px,44px) rotate(10deg) translate(-10.8px,-44px)}}
@media (prefers-reduced-motion: reduce){.tl .all,.tl .hook,.tl .curl,.tl .fish,.tl .tailpos,.tl .tail{animation:none!important}.tl .curl{opacity:0}}
`;

const G = 'url(#tl-g)';

/** `biting`: Tuna is ready, the fish bites. `logo`: just the logo. */
export function HookFish({ size = 96, state }: { size?: number; state?: 'biting' | 'logo' }) {
  return (
    <div className={`tl${state ? ` is-${state}` : ''}`} style={{ width: size, height: size }}>
      <style>{CSS}</style>
      <svg viewBox="0 0 64 64" style={{ width: size, height: size }} aria-hidden="true">
        <defs>
          <linearGradient id="tl-g" gradientUnits="userSpaceOnUse" x1="2.44" y1="12" x2="50.81" y2="53.99">
            <stop offset="0" stopColor="#dccbff" />
            <stop offset="1" stopColor="#7c4dff" />
          </linearGradient>
        </defs>
        <g transform="translate(32 32) scale(1.0957) translate(-26.625 -32.995)">
          <g className="all">
            <g className="hook">
              <line x1="39.06" y1="-90" x2="39.06" y2="13" stroke="#b9a3ff" strokeWidth="0.9" opacity="0.5" />
              <path className="curl" d="M36.76 42.4 L41.36 42.4 L41.36 43 A5.2 5.2 0 0 1 30.96 43 L30.96 41 L33.26 37.4 L35.56 41 L35.56 43 A0.6 0.6 0 0 0 36.76 43 Z" fill={G} />
              <rect x="36.76" y="12" width="4.6" height="30.69" fill={G} />
              <path
                d="M37.36 12.6 L41.36 12.6 C42.71 17.55 50.81 20.25 50.81 28.35 C50.81 31.5 49.91 33.75 48.56 36 C49.1 29.7 45.86 25.65 41.36 23.85 L37.36 23.85 Z"
                fill={G}
                stroke={G}
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </g>
            <g className="tailpos">
              <path className="tail" d="M10.8 44 L2.3 36.5 L2.3 51.5 Z" fill={G} stroke={G} strokeWidth="3" strokeLinejoin="round" />
            </g>
            <g className="fish">
              <ellipse cx="28" cy="44" rx="13.5" ry="9.8" fill={G} />
              <circle cx="32.05" cy="41.06" r="2.7" fill="#140a2e" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}

/** Read (and dropped from the address) before anything else looks at it: the apps came through WireGuard. */
const viaTunnel = (() => {
  if (location.hash !== '#tunnel') return false;
  history.replaceState(history.state, '', location.pathname + location.search);
  return true;
})();

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The opening animation plays once a session, as Netfish's does. */
export function shouldShowSplash(): boolean {
  try {
    if (sessionStorage.getItem('tuna.splash')) return false;
    sessionStorage.setItem('tuna.splash', '1');
  } catch {
    /* storage blocked: just show it */
  }
  return true;
}

/** Each loop on the clock, as on the apps' loading page, so the hand-over between them carries on in step. */
function onClock(root: HTMLElement | null) {
  if (!root || !document.timeline || !Element.prototype.getAnimations) return;
  const periods: Record<string, number> = { 'tl-fish': NIBBLE_MS, 'tl-tail': NIBBLE_MS, 'tl-hook': NIBBLE_MS, 'tl-wag': 900, 'tl-breathe': 1600 };
  for (const a of root.getAnimations({ subtree: true })) {
    const period = periods[(a as CSSAnimation).animationName];
    if (period) a.startTime = (document.timeline.currentTime as number) - (Date.now() % period);
  }
}

const NIBBLE_MS = 2400;
/** Where in each nibbling loop the fish is back at rest, ready to bite (0% and 42%). */
const REST = [0, 1008, NIBBLE_MS];
/** From the start of the bite to the tug. */
const TUG_MS = 450;

/**
 * Away from home: the tunnel above the mark, taken over from the apps' loading page. The fish bites
 * the next time it's back at rest, the logo is reeled up into the tunnel, the tunnel comes down below
 * it, and the logo rises out of its top into place. How long each takes (ms).
 */
type Tunnel = 'nibble' | 'bite' | 'reel' | 'slide' | 'rise' | 'done';
const THROUGH: Partial<Record<Tunnel, [next: Tunnel, ms: number]>> = { bite: ['reel', 700], reel: ['slide', 850], slide: ['rise', 800], rise: ['done', 800] };

/**
 * The opening animation, doubling as the loading screen, as in Netfish: the fish nibbling at the
 * hook carries on in step from the apps' loading page; once Tuna is ready it bites the next time it's
 * back at rest, the tug makes the logo, the word gives a little hop, and it all fades. Away from home
 * (#tunnel) it goes through the tunnel first (Tunnel, above) and the word comes once Tuna is ready.
 * Click or any key: as soon as Tuna is ready. `quick`: just the loop while Tuna starts (it played
 * already this session).
 */
export function Splash({ ready = false, quick = false, onDone }: { ready?: boolean; quick?: boolean; onDone?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [hurry, setHurry] = useState(false);
  const [biting, setBiting] = useState(false);
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [tunnel, setTunnel] = useState<Tunnel>(viaTunnel && !quick && !reducedMotion() ? 'nibble' : 'done');

  useEffect(() => {
    if (!viaTunnel || tunnel === 'done') return;
    if (hurry) return setTunnel('done');
    let timer: number;
    if (tunnel === 'nibble') {
      const phase = Date.now() % NIBBLE_MS;
      timer = window.setTimeout(() => setTunnel('bite'), Math.min(...REST.filter((at) => at >= phase)) - phase);
    } else {
      const [next, ms] = THROUGH[tunnel]!;
      timer = window.setTimeout(() => setTunnel(next), ms);
    }
    return () => clearTimeout(timer);
  }, [tunnel, hurry]);

  useLayoutEffect(() => onClock(root.current), []);

  useEffect(() => {
    const skip = () => setHurry(true);
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, []);

  useEffect(() => {
    if (!ready || landed) return;
    if (quick || hurry || reducedMotion()) return setLanded(true);
    if (viaTunnel) {
      if (tunnel === 'done') setLanded(true);
      return;
    }
    if (biting) {
      const timer = setTimeout(() => setLanded(true), TUG_MS);
      return () => clearTimeout(timer);
    }
    const phase = Date.now() % NIBBLE_MS;
    const timer = setTimeout(() => setBiting(true), Math.min(...REST.filter((at) => at >= phase)) - phase);
    return () => clearTimeout(timer);
  }, [ready, landed, biting, quick, hurry, tunnel]);

  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLeaving(true), quick || hurry ? 0 : 650);
    return () => clearTimeout(timer);
  }, [landed, quick, hurry]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => onDone?.(), 450);
    return () => clearTimeout(timer);
  }, [leaving, onDone]);

  return (
    <div
      ref={root}
      className={`splash${viaTunnel ? ` splash--tunnel is-${tunnel}` : ''}${landed ? ' is-landed' : ''}${leaving ? ' is-leaving' : ''}`}
      onClick={() => setHurry(true)}
      role="presentation"
    >
      <div className="splash__stage">
        <div className="splash__mark">
          {viaTunnel && (
            <span className="splash__ring splash__ring--back" aria-hidden="true">
              <i />
            </span>
          )}
          {/* The logo whenever it isn't nibbling or biting: once through the tunnel, when it played
              already this session, or when it's skipped, so it never leaves on the fish and the hook apart. */}
          <div className="splash__clip">
            <HookFish
              state={
                viaTunnel
                  ? tunnel === 'nibble'
                    ? undefined
                    : tunnel === 'bite'
                      ? 'biting'
                      : 'logo'
                  : biting
                    ? 'biting'
                    : quick || landed
                      ? 'logo'
                      : undefined
              }
            />
          </div>
          {viaTunnel && (
            <span className="splash__ring splash__ring--front" aria-hidden="true">
              <i />
            </span>
          )}
        </div>
        <div className="splash__below">
          <span className="splash__word">tuna</span>
          {viaTunnel && !landed && <span className="splash__says">{t('Connected through WireGuard')}</span>}
        </div>
      </div>
    </div>
  );
}
