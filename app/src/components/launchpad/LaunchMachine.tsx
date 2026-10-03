"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { Pause, Play, ArrowUpRight, LockKeyhole } from "lucide-react";
import { launchpad } from "@/lib/launchpad/config";
import { CHAIN_KEYS, CHAIN_SHORT, explorerAddress } from "@/lib/chainPublic";
import { shouldAnimateLaunch } from "@/lib/launchpad/hero-animation";
import LaunchSequence from "./LaunchSequence";
import styles from "./LaunchMachine.module.css";

const stages = [
  { label: "Your token", title: "An idea becomes a token.", description: "Your name. Your symbol. A fixed supply, created in one transaction." },
  { label: "The pool", title: "Open from the first trade.", description: "100% of the supply enters a Uniswap v4 pool at the starting market cap you choose." },
  { label: "The lock", title: "Liquidity locked. No keys kept.", description: "The liquidity position stays in an ownerless locker forever. Tokens remain tradeable." },
] as const;
const MOTION_QUERY = "(prefers-reduced-motion: no-preference)";
const TILT_QUERY = "(min-width: 1024px) and (hover: hover) and (prefers-reduced-motion: no-preference)";
function subscribeMotion(listener: () => void) {
  const media = window.matchMedia(MOTION_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
const motionSnapshot = () => window.matchMedia(MOTION_QUERY).matches;
const visibilitySnapshot = () => !document.hidden;
const serverSnapshot = () => false;

/** Original SVG/CSS illustration. The browser owns its clock; React never ticks per frame. */
export default function LaunchMachine() {
  const root = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(2);
  const [paused, setPaused] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inView, setInView] = useState(false);
  const motionAllowed = useSyncExternalStore(subscribeMotion, motionSnapshot, serverSnapshot);
  const pageVisible = useSyncExternalStore(subscribeVisibility, visibilitySnapshot, serverSnapshot);
  const looping = motionAllowed && !inspecting;
  const playing = shouldAnimateLaunch({ paused, inspecting, motionAllowed, inView, pageVisible });

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting && entry.intersectionRatio >= 0.15);
    }, { threshold: [0, 0.15] });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function togglePlayback() {
    if (!motionAllowed) return;
    if (inspecting) {
      setInspecting(false);
      setPaused(false);
      setStage(0);
    } else {
      setPaused((value) => !value);
    }
    scene.current?.style.removeProperty("transform");
  }

  function tilt(event: PointerEvent<HTMLDivElement>) {
    if (!playing || event.pointerType !== "mouse" || !window.matchMedia(TILT_QUERY).matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    if (scene.current) scene.current.style.transform = `perspective(1000px) rotateX(${-y * 5}deg) rotateY(${x * 7}deg)`;
  }

  const lockers = CHAIN_KEYS.flatMap((k) => { const locker = launchpad(k).locker; return locker ? [{ chain: k, locker }] : []; });

  return <div ref={root} className={styles.machine} data-stage={stage} data-loop={looping} data-playing={playing}>
    <div className={styles.heading}>
      <span className={styles.eyebrow}><span className={styles.crosshair} aria-hidden /> One transaction. Built to stay.</span>
      <button type="button" onClick={togglePlayback} className={styles.playback} disabled={!motionAllowed} aria-label={!motionAllowed ? "Animation disabled by reduced motion" : paused || inspecting ? "Play launch animation" : "Pause launch animation"}>
        {!motionAllowed ? <span>Motion off</span> : <>{paused || inspecting ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}<span>{paused || inspecting ? "Play" : "Pause"}</span></>}
      </button>
    </div>
    <div className={styles.viewport} onPointerMove={tilt} onPointerLeave={() => scene.current?.style.removeProperty("transform")}>
      <div ref={scene} className={styles.scene}>
        <svg viewBox="0 0 560 398" fill="none" className={styles.drawing} aria-hidden="true" focusable="false">
          <LaunchSequence stage={stage} />
          <g className={styles.grid}>
            {[-100, -50, 0, 50, 100].map((n) => <g key={n}><line x1={280 + n * .86 - 111.8} y1={308 + n * .38 + 49.4} x2={280 + n * .86 + 111.8} y2={308 + n * .38 - 49.4} /><line x1={280 - n * .86 - 111.8} y1={308 + n * .38 - 49.4} x2={280 - n * .86 + 111.8} y2={308 + n * .38 + 49.4} /></g>)}
          </g>
          <g className={styles.assembly}>
          {/* The captured object is the LP position, not circulating tokens. */}
          <g className={styles.locker}>
            <Plate y={300} size={110} depth={20} />
            <path d="M123 299 280 369 437 299" className={styles.engraving} />
            <path d="M150 296 280 238 410 296 280 354Z" className={styles.inset} />
            <path d="M169 296 280 247 391 296 280 345Z" className={styles.outline} />
            <g transform="matrix(.86 .38 -.86 .38 280 287)">
              <rect x="-39" y="-39" width="78" height="78" rx="9" className={styles.position} />
              <rect x="-43" y="-43" width="86" height="86" rx="11" pathLength="100" className={styles.lockTrace} />
              <path d="M-14 -5V-14A14 14 0 0 1 14 -14V-5M-19 -5H19V22H-19ZM0 5V13" className={styles.lockMark} />
            </g>
            <g className={styles.clampLeft}><Plate y={294} size={13} depth={13} x={123} /><path d="M113 283 123 278 133 283" className={styles.inkLine} /></g>
            <g className={styles.clampRight}><Plate y={294} size={13} depth={13} x={437} /><path d="M427 283 437 278 447 283" className={styles.inkLine} /></g>
            <path d="M280 374V391M276 391H284" className={styles.axis} />
            <g transform="matrix(.86 -.38 0 1 317 350)"><text className={styles.etched}>NO WITHDRAWAL KEY</text></g>
          </g>
          <g className={styles.guides}><path d="M139 211V283M421 211V283M280 261V285M280 131V176" /><circle cx="139" cy="253" r="2" /><circle cx="421" cy="253" r="2" /></g>
          <g className={styles.pool}>
            <Plate y={203} size={90} depth={17} />
            <path d="M149 202 280 144 411 202 280 260Z" className={styles.outline} />
            <ellipse cx="280" cy="202" rx="80" ry="35.5" className={styles.rim} />
            <ellipse cx="280" cy="202" rx="73" ry="32.2" className={styles.poolCurrent} />
            <ellipse cx="280" cy="202" rx="65" ry="28.8" className={styles.well} />
            <path d="M219 211C242 180 318 180 341 211" className={styles.wellBack} />
            <ellipse cx="280" cy="213" rx="46" ry="18" className={styles.poolFloor} />
            <ellipse cx="280" cy="202" rx="65" ry="28.8" className={styles.inkLine} />
            <path d="M173 205 183 209M188 212 198 216M203 219 213 223" className={styles.ridges} />
            <g transform="matrix(.86 -.38 0 1 357 218)"><text className={styles.etched}>UNISWAP v4</text></g>
          </g>
          <ellipse cx="280" cy="202" rx="74" ry="33" className={styles.ripple} />
          <ellipse cx="280" cy="202" rx="74" ry="33" className={styles.rippleAfter} />
          <g className={styles.token}>
            <path d="M228 88V106A52 23 0 0 0 332 106V88Z" className={styles.tokenSide} />
            {[-40, -30, -20, -10, 0, 10, 20, 30, 40].map((n) => <path key={n} d={`M${280 + n} ${106 + 23 * Math.sqrt(1 - (n / 52) ** 2)}v-12`} className={styles.tokenRidge} />)}
            <ellipse cx="280" cy="88" rx="52" ry="23" className={styles.tokenTop} />
            <ellipse cx="280" cy="88" rx="43" ry="18" className={styles.tokenRing} />
            <g transform="matrix(.86 .38 -.86 .38 280 87)"><path d="M-22 -14H-4V14H-22ZM6 -14V14H24" className={styles.tokenMark} /></g>
          </g>
          </g>
          <g className={styles.callouts}>
            <path d="M226 91H184L163 73H60" /><circle cx="226" cy="91" r="2" />
            <text x="60" y="61" className={styles.calloutLabel}>01 / YOUR TOKEN</text>
            <text x="60" y="90" className={styles.calloutSub}>Fixed supply</text>
            <path d="M395 183 431 160H511" /><circle cx="395" cy="183" r="2" />
            <text x="432" y="148" className={styles.calloutLabel}>02 / POOL</text>
            <path d="M154 327 126 344H50" /><circle cx="154" cy="327" r="2" />
            <text x="50" y="332" className={styles.calloutLabel}>03 / LOCK</text>
            <text x="50" y="361" className={styles.calloutSub}>No expiry.</text>
          </g>
          <g className={styles.axis}><path d="M493 326v29l24 -11M493 355l-24 -11" /><circle cx="493" cy="355" r="2" /></g>
        </svg>
      </div>
    </div>
    <div className={styles.controls} role="group" aria-label="Explore the launch mechanism">
      {stages.map((item, index) => <button key={item.label} type="button" aria-pressed={stage === index} aria-controls="launch-stage-detail" onClick={() => { setInspecting(true); setPaused(true); setStage(index); scene.current?.style.removeProperty("transform"); }} className={styles.stageButton}>
        <span className={styles.stageNumber}>0{index + 1}</span><span>{item.label}</span><span className={styles.stageDot} aria-hidden />
        {/* CSS phase boundaries drive React only when a step changes, never per frame. */}
        <span className={styles.stageProgress} data-phase={index} aria-hidden="true"
          onAnimationStart={() => { if (looping) setStage(index); }}
          onAnimationIteration={() => { if (looping) setStage(index); }} />
      </button>)}
    </div>
    <div id="launch-stage-detail" className={styles.detail} aria-live="off">
      {/* Stack all copy to reserve the tallest stage, even at narrow widths or text zoom. */}
      {stages.map((item, index) => <div key={item.label} className={styles.detailContent} aria-hidden={stage !== index}>
        <p className={styles.detailTitle}>{item.title}</p>
        <p className={styles.detailCopy}>{item.description}</p>
      </div>)}
    </div>
    <div className={styles.proof}>
      <span><LockKeyhole size={12} aria-hidden /> Verify the locker</span>
      <span>{lockers.map(({ chain, locker }) => <a key={chain} href={explorerAddress(chain, locker)} target="_blank" rel="noreferrer">{CHAIN_SHORT[chain]} <ArrowUpRight size={11} aria-hidden /></a>)}</span>
    </div>
  </div>;
}

/** Eight-corner machined plate, projected isometrically with opaque faces. */
function Plate({ x = 280, y, size, depth }: { x?: number; y: number; size: number; depth: number }) {
  const cut = Math.min(10, size / 3);
  const points = [[-size + cut, -size], [size - cut, -size], [size, -size + cut], [size, size - cut], [size - cut, size], [-size + cut, size], [-size, size - cut], [-size, -size + cut]].map(([a, b]) => [x + (a - b) * .86, y + (a + b) * .38]);
  return <g>
    {[2, 3, 4, 5, 6].map((index) => {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      return <polygon key={index} points={`${a} ${b} ${b[0]},${b[1] + depth} ${a[0]},${a[1] + depth}`} className={index < 4 ? styles.faceRight : styles.faceLeft} />;
    })}
    <polygon points={points.map((p) => p.join(",")).join(" ")} className={styles.plateTop} />
  </g>;
}
