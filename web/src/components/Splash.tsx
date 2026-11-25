import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';

/**
 * The loading animation (same as the apps' loading page, apps/common/loading.html): the note's stem
 * drops in as a hook, the fish swims up, stops short, bites in one snap, and the tug tilts it into
 * the logo; then it's reeled away and it starts again.
 */
const CSS = `
.tl svg{display:block;width:96px;height:96px;overflow:visible}
.tl .all,.tl .hook,.tl .fish,.tl .tailpos{transform-box:view-box;transform-origin:0 0}
.tl .fish{transform:translate(.02px,-2.8px) translate(41.34px,45.49px) rotate(-12deg) translate(-41.34px,-45.49px)}
.tl .tailpos{transform:translate(.14px,1.31px)}
.tl .curl{opacity:0}
.tl .all{animation:tl-all 3.2s infinite}.tl .hook{animation:tl-hook 3.2s infinite}.tl .curl{animation:tl-curl 3.2s infinite}
.tl .fish{animation:tl-fish 3.2s infinite}.tl .tailpos{animation:tl-tail 3.2s infinite}
.tl .tail{transform-box:fill-box;transform-origin:100% 50%;animation:tl-wag .45s ease-in-out infinite alternate}
@keyframes tl-all{0%,47%{transform:translate(0,0);opacity:1;animation-timing-function:cubic-bezier(.2,.8,.3,1)}50%{transform:translate(0,-5px);animation-timing-function:ease-in-out}56%{transform:translate(0,1px);animation-timing-function:ease-in-out}61%{transform:translate(0,0);animation-timing-function:ease-in-out}72%{transform:translate(0,-1.5px);animation-timing-function:ease-in-out}84%{transform:translate(0,0);opacity:1;animation-timing-function:cubic-bezier(.5,0,.8,.4)}100%{transform:translate(0,-70px);opacity:0}}
@keyframes tl-hook{0%{transform:translate(0,-46px);opacity:0;animation-timing-function:cubic-bezier(.3,.6,.4,1)}5%{opacity:1}13%{transform:translate(0,2px);animation-timing-function:ease-in-out}19%{transform:translate(0,0);animation-timing-function:ease-in-out}31%{transform:translate(0,-1.5px);animation-timing-function:ease-in-out}42%{transform:translate(0,.5px);animation-timing-function:ease-in-out}49%,100%{transform:translate(0,0)}}
@keyframes tl-curl{0%,49%{opacity:1;animation-timing-function:steps(1,end)}50%,100%{opacity:0}}
@keyframes tl-fish{0%,14%{transform:translate(-46px,-1px) translate(41.34px,45.49px) rotate(0) translate(-41.34px,-45.49px);opacity:0;animation-timing-function:cubic-bezier(.25,.6,.45,1)}22%{opacity:1}28%{transform:translate(-27px,-2.2px) translate(41.34px,45.49px) rotate(0) translate(-41.34px,-45.49px);animation-timing-function:ease-in-out}36%{transform:translate(-13.5px,-1.4px) translate(41.34px,45.49px) rotate(0) translate(-41.34px,-45.49px);animation-timing-function:ease-in-out}42%{transform:translate(-15.5px,-1px) translate(41.34px,45.49px) rotate(0) translate(-41.34px,-45.49px);animation-timing-function:cubic-bezier(.7,0,1,.6)}47%{transform:translate(0,-1px) translate(41.34px,45.49px) rotate(0) translate(-41.34px,-45.49px);animation-timing-function:cubic-bezier(.3,1.5,.5,1)}54%,100%{transform:translate(.02px,-2.8px) translate(41.34px,45.49px) rotate(-12deg) translate(-41.34px,-45.49px);opacity:1}}
@keyframes tl-tail{0%,14%{transform:translate(-46px,-1px);opacity:0;animation-timing-function:cubic-bezier(.25,.6,.45,1)}22%{opacity:1}28%{transform:translate(-27px,-2.2px);animation-timing-function:ease-in-out}36%{transform:translate(-13.5px,-1.4px);animation-timing-function:ease-in-out}42%{transform:translate(-15.5px,-1px);animation-timing-function:cubic-bezier(.7,0,1,.6)}47%{transform:translate(0,-1px);animation-timing-function:cubic-bezier(.3,1.5,.5,1)}54%,100%{transform:translate(.14px,1.31px);opacity:1}}
@keyframes tl-wag{from{transform:rotate(-10deg)}to{transform:rotate(10deg)}}
@media (prefers-reduced-motion: reduce){.tl .all,.tl .hook,.tl .curl,.tl .fish,.tl .tailpos,.tl .tail{animation:none!important}}
`;

const G = 'url(#tl-g)';

export function HookFish({ size = 96 }: { size?: number }) {
  return (
    <div className="tl" style={{ width: size, height: size }}>
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
  const periods: Record<string, number> = { 'tl-all': 3200, 'tl-hook': 3200, 'tl-curl': 3200, 'tl-fish': 3200, 'tl-tail': 3200, 'tl-wag': 900, 'tl-breathe': 1600 };
  for (const a of root.getAnimations({ subtree: true })) {
    const period = periods[(a as CSSAnimation).animationName];
    if (period) a.startTime = (document.timeline.currentTime as number) - (Date.now() % period);
  }
}

/** Stops the loop where it is (on the logo, when called at the right moment). */
function hold(root: HTMLElement | null, at?: number) {
  for (const a of root?.querySelector('.tl')?.getAnimations({ subtree: true }) ?? []) {
    if (at !== undefined && (a as CSSAnimation).animationName !== 'tl-wag') a.currentTime = at;
    a.pause();
  }
}

/** In each 3.2 s loop, the fish has bitten and the mark is the logo from here… */
const LOGO_FROM = 1730;
/** …until about here, when it's reeled away. */
const LOGO_UNTIL = 2600;

/**
 * The opening animation, doubling as the loading screen, as in Netfish: the hook and the fish carry
 * on in step from the apps' loading page; once Tuna is ready the loop lands on the logo at the next
 * bite, the word gives a little hop, and it all fades. Away from home (#tunnel), the loading page
 * left only the tunnel, a breathing ring the mark swam into: it's taken over here at the same place,
 * size and breath, and the mark comes out of it. Click or any key: as soon as Tuna is ready.
 * `quick`: just the loop while Tuna starts (it played already this session).
 */
export function Splash({ ready = false, quick = false, onDone }: { ready?: boolean; quick?: boolean; onDone?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [hurry, setHurry] = useState(false);
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useLayoutEffect(() => {
    onClock(root.current);
    // In the tunnel, the mark waits as the logo.
    if (viaTunnel) hold(root.current, LOGO_FROM + 100);
  }, []);

  useEffect(() => {
    const skip = () => setHurry(true);
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, []);

  useEffect(() => {
    if (!ready || landed) return;
    if (quick || hurry || reducedMotion()) return setLanded(true);
    const phase = Date.now() % 3200;
    const wait = viaTunnel ? 300 : phase >= LOGO_FROM && phase <= LOGO_UNTIL ? 0 : (LOGO_FROM - phase + 3200) % 3200;
    const timer = setTimeout(() => {
      if (!viaTunnel) hold(root.current);
      setLanded(true);
    }, wait);
    return () => clearTimeout(timer);
  }, [ready, landed, quick, hurry]);

  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLeaving(true), quick || hurry ? 0 : viaTunnel ? 1100 : 650);
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
      className={`splash${viaTunnel ? ' splash--tunnel' : ''}${landed ? ' is-landed' : ''}${leaving ? ' is-leaving' : ''}`}
      onClick={() => setHurry(true)}
      role="presentation"
    >
      <div className="splash__stage">
        <div className="splash__mark">
          {viaTunnel && (
            <span className="splash__ring" aria-hidden="true">
              <i />
            </span>
          )}
          <HookFish />
        </div>
        <div className="splash__below">
          <span className="splash__word">tuna</span>
          {viaTunnel && !landed && <span className="splash__says">{t('Connected through WireGuard')}</span>}
        </div>
      </div>
    </div>
  );
}
