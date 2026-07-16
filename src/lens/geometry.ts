/**
 * Pure geometry for the lens. No DOM, no data semantics: given a value in
 * [0,1] and a slot on an arm, produce the points to draw.
 *
 * The lens is a circle with three arms at 120 degree intervals. Each arm is a
 * population pyramid bent around the circle:
 *
 *   - Age runs ALONG the arm, one slot per five-year band, youngest nearest
 *     the core.
 *   - Each slot's bar grows perpendicular to the arm, away from a shared
 *     spine: males to one side, females to the other.
 *
 * That mirroring about the spine is what makes it read as a pyramid (or a
 * tornado chart) rather than as two fans pointing the same way.
 */

export interface LensSpec {
  /** Radius of the central dial, in px. */
  coreRadius: number;
  /** How far along the arm the age axis runs, in px. */
  armLength: number;
  /** Half-width of a bar at value = 1, in px, measured off the spine. */
  barReach: number;
  /** Gap between adjacent age bands, as a fraction of slot pitch. */
  slotGap: number;
}

export const DEFAULT_LENS: LensSpec = {
  coreRadius: 78,
  armLength: 190,
  // Bars are the data; they should dominate the arm, not decorate its spine.
  barReach: 88,
  slotGap: 0.22,
};

/** Arm directions in radians. Screen coords: 0 = east, y grows downward. */
export const ARM_ANGLE = {
  /** Upper left. */
  population: -Math.PI * 0.833,
  /** Upper right. */
  mortality: -Math.PI * 0.167,
  /** Straight down. */
  fertility: Math.PI * 0.5,
} as const;

export type ArmKey = keyof typeof ARM_ANGLE;

/** Which way a bar grows off the spine. */
export type Side = -1 | 1;

export interface Slot {
  /** Distance from the lens centre to this age band's spine position, px. */
  radius: number;
  /** Thickness of the band along the arm, px. */
  thickness: number;
}

/**
 * Lay out `count` age bands along an arm, youngest nearest the core.
 * Slots are positions on the spine; the bar hangs off them sideways.
 */
export function armSlots(spec: LensSpec, count: number): Slot[] {
  const pitch = spec.armLength / count;
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    slots.push({
      radius: spec.coreRadius + pitch * (i + 0.5),
      thickness: pitch * (1 - spec.slotGap),
    });
  }
  return slots;
}

/**
 * A point in lens space: `along` px out from the centre on the arm's axis,
 * `across` px perpendicular to it. Returns SVG "x,y".
 */
function point(arm: ArmKey, along: number, across: number): string {
  const a = ARM_ANGLE[arm];
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const x = cos * along - sin * across;
  const y = sin * along + cos * across;
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}

/**
 * One bar of the pyramid: a rounded capsule sitting on the spine at this age
 * band, extending `value` of the way to barReach on the given side.
 *
 * Straight, not curved to the circle: bars mirror across a straight spine, so
 * bending them would break the symmetry the pyramid is read by. The round cap
 * is what makes a dense stack of bands still read as individual bars.
 */
export function barPath(spec: LensSpec, arm: ArmKey, slot: Slot, value: number, side: Side): string {
  const v = Math.max(0, Math.min(1, value));
  const half = slot.thickness / 2;
  const a0 = slot.radius - half;
  const a1 = slot.radius + half;
  // Leave a hairline either side of the spine so the two halves stay distinct.
  const c0 = side * 0.8;
  const reach = v * spec.barReach;

  // Below the cap radius there is no room to round: draw a plain sliver.
  if (reach <= half) {
    const c1 = side * (0.8 + reach);
    return [
      `M${point(arm, a0, c0)}`,
      `L${point(arm, a1, c0)}`,
      `L${point(arm, a1, c1)}`,
      `L${point(arm, a0, c1)}`,
      'Z',
    ].join('');
  }

  // Capsule: square at the spine, semicircular cap at the far end.
  const cEnd = side * (0.8 + reach - half);
  const sweep = side > 0 ? 1 : 0;
  return [
    `M${point(arm, a0, c0)}`,
    `L${point(arm, a0, cEnd)}`,
    `A${half},${half} 0 0 ${sweep} ${point(arm, a1, cEnd)}`,
    `L${point(arm, a1, c0)}`,
    'Z',
  ].join('');
}

/** The spine an arm's bars mirror about. */
export function spinePath(spec: LensSpec, arm: ArmKey): string {
  return `M${point(arm, spec.coreRadius, 0)} L${point(arm, spec.coreRadius + spec.armLength, 0)}`;
}

/** Straight label path running alongside an arm, past the end of its bars. */
export function armLabelPath(spec: LensSpec, arm: ArmKey, offset: number): string {
  const a0 = spec.coreRadius + 2;
  const a1 = spec.coreRadius + spec.armLength;
  // Text on a path reading right-to-left would render upside down.
  const dir = Math.cos(ARM_ANGLE[arm]) < -0.01 || Math.abs(Math.sin(ARM_ANGLE[arm])) > 0.99;
  const [s, e] = dir ? [a1, a0] : [a0, a1];
  const across = dir ? -offset : offset;
  return `M${point(arm, s, across)} L${point(arm, e, across)}`;
}

/**
 * Where an age band's label sits. `across` offsets it off the spine, so a
 * label can be parked clear of the bars rather than underneath them.
 */
export function slotAnchor(arm: ArmKey, slot: Slot, across = 0): { x: number; y: number } {
  const [x, y] = point(arm, slot.radius, across).split(',');
  return { x: Number(x), y: Number(y) };
}

/** Tick mark across the spine at a given distance out from the core. */
export function axisTickPath(arm: ArmKey, along: number, len: number): string {
  return `M${point(arm, along, -len / 2)} L${point(arm, along, len / 2)}`;
}

/** Degrees to rotate text so it runs along an arm and stays upright. */
export function armTextAngle(arm: ArmKey): number {
  const deg = (ARM_ANGLE[arm] * 180) / Math.PI;
  // Anything pointing leftward would render the text upside down.
  return Math.cos(ARM_ANGLE[arm]) < -0.01 ? deg + 180 : deg;
}
