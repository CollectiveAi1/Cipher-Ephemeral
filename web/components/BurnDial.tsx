import { useCallback, useEffect, useRef } from "react";
import {
  dialPositionToSeconds,
  formatLifespan,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  secondsToDialPosition,
  snapToNotch,
  stepNotch,
} from "../../shared/burn-scale.ts";
import { decayPaint } from "../../shared/decay.ts";

/** Geometry, per the spec: a 280° sweep with the gap centred at the bottom. */
const START_ANGLE = 130;
const SWEEP = 280;
const RADIUS = 52;
const TRACK_WIDTH = 10;
const KNOB_RADIUS = 13;
const CENTER = 70;
const SIZE = 140;

/** A notch within this arc distance snaps. 1.5° expressed as dial position. */
const SNAP_TOLERANCE = 1.5 / SWEEP;

type Point = { x: number; y: number };

const pointAt = (position: number): Point => {
  const radians = ((START_ANGLE + position * SWEEP) * Math.PI) / 180;
  return { x: CENTER + RADIUS * Math.cos(radians), y: CENTER + RADIUS * Math.sin(radians) };
};

/** Arc path between two dial positions. */
function arcBetween(from: number, to: number): string {
  const start = pointAt(from);
  const end = pointAt(to);
  const largeArc = (to - from) * SWEEP > 180 ? 1 : 0;
  if (to <= from) return `M ${start.x} ${start.y}`;
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/** Arc path from the track start to `position`. */
const arcTo = (position: number) => arcBetween(0, position);

/**
 * Projects a pointer onto the dial. A pointer inside the bottom gap clamps to the
 * nearer terminal instead of wrapping, so a fast drag cannot jump 15s to 7d.
 */
function positionFromPointer(element: SVGSVGElement, clientX: number, clientY: number): number {
  const box = element.getBoundingClientRect();
  const scale = SIZE / box.width;
  const x = (clientX - box.left) * scale - CENTER;
  const y = (clientY - box.top) * scale - CENTER;

  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  const relative = (degrees - START_ANGLE + 720) % 360;
  if (relative <= SWEEP) return relative / SWEEP;
  // In the gap: the far half belongs to the start terminal, the near half to the end.
  return relative < (SWEEP + 360) / 2 ? 1 : 0;
}

type BurnDialProps = {
  seconds: number;
  onChange: (seconds: number) => void;
  /**
   * Upper bound on the lifespan, used when a community sets a retention ceiling. The
   * dial will not travel past it, and the barred span is drawn so the limit is visible
   * rather than just felt.
   */
  maxSeconds?: number;
  disabled?: boolean;
};

/**
 * The Burn Dial. During a gesture the SVG is painted imperatively inside a single
 * rAF callback, and `onChange` fires only when the quantized lifespan actually
 * changes — so scrubbing costs no React renders per pointer move.
 */
export function BurnDial({ seconds, onChange, maxSeconds = MAX_TTL_SECONDS, disabled = false }: BurnDialProps) {
  const ceiling = Math.min(MAX_TTL_SECONDS, maxSeconds);
  const ceilingPosition = secondsToDialPosition(ceiling);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fillRef = useRef<SVGPathElement | null>(null);
  const knobRef = useRef<SVGCircleElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const gradientFrom = useRef<SVGStopElement | null>(null);
  const gradientTo = useRef<SVGStopElement | null>(null);

  const position = useRef(secondsToDialPosition(seconds));
  const reported = useRef(seconds);
  const frame = useRef<number | null>(null);
  const dragging = useRef(false);

  const paint = useCallback(() => {
    frame.current = null;
    const value = dialPositionToSeconds(position.current);
    // Tinted along the decay ramp by selected lifespan: a 15s burn reads cool, a 7d
    // burn reads warm, so the dial shows retention cost while you are choosing it.
    const tint = decayPaint(1 - position.current);

    fillRef.current?.setAttribute("d", arcTo(position.current));
    const knob = pointAt(position.current);
    knobRef.current?.setAttribute("cx", String(knob.x));
    knobRef.current?.setAttribute("cy", String(knob.y));
    gradientFrom.current?.setAttribute("stop-color", tint.from);
    gradientTo.current?.setAttribute("stop-color", tint.to);
    if (labelRef.current !== null) labelRef.current.textContent = formatLifespan(value);

    svgRef.current?.setAttribute("aria-valuenow", String(value));
    svgRef.current?.setAttribute("aria-valuetext", `Burns after ${formatLifespan(value)}`);

    if (value !== reported.current) {
      reported.current = value;
      onChange(value);
    }
  }, [onChange]);

  /** Coalesces pointer moves to one paint per frame. */
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(paint);
  }, [paint]);

  /**
   * Paints immediately instead of waiting for a frame. Used for discrete changes
   * (releasing the dial, pressing a key) so a selection is still committed when frames
   * are throttled — a background tab, or a browser that has stopped animating.
   */
  const flush = useCallback(() => {
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    paint();
  }, [paint]);

  const applyPosition = useCallback(
    (next: number) => {
      const bounded = Math.min(ceilingPosition, Math.max(0, next));
      position.current = Math.min(ceilingPosition, snapToNotch(bounded, SNAP_TOLERANCE));
      schedule();
    },
    [ceilingPosition, schedule],
  );

  // Paint once on mount and whenever the lifespan is changed from outside the dial
  // (switching conversations loads that conversation's default).
  useEffect(() => {
    if (dragging.current || seconds === reported.current) return;
    reported.current = seconds;
    position.current = Math.min(ceilingPosition, secondsToDialPosition(seconds));
    schedule();
  }, [ceilingPosition, schedule, seconds]);

  // A ceiling that drops below the current selection pulls the dial down to it.
  useEffect(() => {
    if (position.current <= ceilingPosition) return;
    position.current = ceilingPosition;
    flush();
  }, [ceilingPosition, flush]);

  useEffect(() => {
    schedule();
    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, [schedule]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (svgRef.current === null) return;
      applyPosition(positionFromPointer(svgRef.current, event.clientX, event.clientY));
    },
    [applyPosition],
  );

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    handlePointer(event);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    handlePointer(event);
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    flush();
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (disabled) return;

    const current = dialPositionToSeconds(position.current);
    const stepped =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? stepNotch(current, 1)
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? stepNotch(current, -1)
          : event.key === "Home"
            ? MIN_TTL_SECONDS
            : event.key === "End"
              ? ceiling
              : null;

    if (stepped === null) return;
    event.preventDefault();
    position.current = Math.min(ceilingPosition, secondsToDialPosition(Math.min(ceiling, stepped)));
    flush();
  };

  return (
    // Sized in CSS rather than with fixed attributes, so the dial can give the composer
    // more room on a narrow screen. Pointer maths reads the rendered box, so it follows.
    <div className="relative size-[104px] shrink-0 sm:size-[118px]">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Message lifespan"
        aria-valuemin={MIN_TTL_SECONDS}
        aria-valuemax={ceiling}
        aria-valuenow={seconds}
        aria-orientation="vertical"
        aria-disabled={disabled}
        className={`h-full w-full touch-none select-none ${disabled ? "opacity-40" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <defs>
          <linearGradient id="burn-dial-arc" x1="0" y1="1" x2="1" y2="0">
            <stop ref={gradientFrom} offset="0%" stopColor="#22d3ee" />
            <stop ref={gradientTo} offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>

        <path
          d={arcTo(1)}
          fill="none"
          stroke="var(--color-edge)"
          strokeWidth={TRACK_WIDTH}
          strokeLinecap="round"
        />
        {ceilingPosition < 1 && (
          <path
            d={arcBetween(ceilingPosition, 1)}
            fill="none"
            stroke="var(--color-amber)"
            strokeOpacity={0.25}
            strokeWidth={TRACK_WIDTH}
            strokeLinecap="round"
          />
        )}
        <path
          ref={fillRef}
          d={arcTo(secondsToDialPosition(seconds))}
          fill="none"
          stroke="url(#burn-dial-arc)"
          strokeWidth={TRACK_WIDTH}
          strokeLinecap="round"
        />
        <circle
          ref={knobRef}
          cx={pointAt(secondsToDialPosition(seconds)).x}
          cy={pointAt(secondsToDialPosition(seconds)).y}
          r={KNOB_RADIUS}
          fill="var(--color-ink-800)"
          stroke="url(#burn-dial-arc)"
          strokeWidth={3}
        />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span ref={labelRef} className="tabular text-xl font-semibold text-hi sm:text-2xl">
          {formatLifespan(seconds)}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-lo">burn</span>
      </div>
    </div>
  );
}
