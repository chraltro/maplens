/**
 * A tiny reactive layer. The lens reads a country under the map centre that
 * changes on every frame of a pan, so the two things that matter are: never
 * do work when the value did not actually change, and never snap a number
 * from one value to another without easing through it.
 */

export type Listener<T> = (value: T) => void;

export class Signal<T> {
  private listeners = new Set<Listener<T>>();

  constructor(private current: T, private equals: (a: T, b: T) => boolean = Object.is) {}

  get(): T {
    return this.current;
  }

  set(next: T): void {
    if (this.equals(this.current, next)) return;
    this.current = next;
    for (const l of this.listeners) l(next);
  }

  subscribe(fn: Listener<T>, immediate = true): () => void {
    this.listeners.add(fn);
    if (immediate) fn(this.current);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Critically damped spring. Reaches the target without overshoot, and unlike a
 * fixed-duration tween it retargets mid-flight without a visible restart,
 * which is exactly what a value being scrubbed by a pan needs.
 */
export class Spring {
  private velocity = 0;
  private target: number;

  constructor(private value: number, private stiffness = 120, private damping = 22) {
    this.target = value;
  }

  setTarget(v: number): void {
    this.target = v;
  }

  /** Jump without easing, e.g. on first paint. */
  reset(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  get(): number {
    return this.value;
  }

  get settled(): boolean {
    return Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-4;
  }

  /** Advance by dt seconds. Returns the new value. */
  step(dt: number): number {
    // Clamp dt so a background tab or a long frame cannot explode the spring.
    const h = Math.min(dt, 1 / 30);
    const accel = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
    this.velocity += accel * h;
    this.value += this.velocity * h;
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/** A vector of springs, for animating a whole age profile as one unit. */
export class SpringArray {
  private springs: Spring[];

  constructor(size: number, stiffness = 120, damping = 22) {
    this.springs = Array.from({ length: size }, () => new Spring(0, stiffness, damping));
  }

  setTargets(values: readonly number[]): void {
    for (let i = 0; i < this.springs.length; i++) {
      this.springs[i]!.setTarget(values[i] ?? 0);
    }
  }

  reset(values: readonly number[]): void {
    for (let i = 0; i < this.springs.length; i++) {
      this.springs[i]!.reset(values[i] ?? 0);
    }
  }

  get settled(): boolean {
    return this.springs.every((s) => s.settled);
  }

  step(dt: number): number[] {
    return this.springs.map((s) => s.step(dt));
  }

  values(): number[] {
    return this.springs.map((s) => s.get());
  }
}

/**
 * Drives a callback on rAF, but only while there is something to animate.
 * Idles at zero cost once every spring has settled.
 */
export class Ticker {
  private running = false;
  private last = 0;
  private frame = 0;

  constructor(private onTick: (dt: number) => boolean) {}

  /** Nudge the loop awake. Safe to call on every pan event. */
  wake(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private tick = (now: number): void => {
    const dt = (now - this.last) / 1000;
    this.last = now;
    const keepGoing = this.onTick(dt);
    if (keepGoing) {
      this.frame = requestAnimationFrame(this.tick);
    } else {
      this.running = false;
    }
  };
}
