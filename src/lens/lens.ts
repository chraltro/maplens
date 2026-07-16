import {
  AGE_BRACKETS, FERT_FIRST_BRACKET, N_AGES, N_FERT, type Snapshot,
} from '../data/types';
import {
  DEFAULT_LENS, armLabelPath, armSlots, armTextAngle, axisTickPath, barPath,
  slotAnchor, spinePath,
  type ArmKey, type LensSpec, type Side, type Slot,
} from './geometry';
import { Spring, SpringArray, Ticker } from './reactive';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** One half of a pyramid: which data series, which arm, which side of it. */
interface Half {
  key: SeriesKey;
  arm: ArmKey;
  side: Side;
  cls: string;
}

type SeriesKey = 'male' | 'female' | 'mortMale' | 'mortFemale' | 'fert';

/** Bar heights in [0,1], ready to draw. */
type Normalised = Record<SeriesKey, number[]>;

const EMPTY: Normalised = {
  male: new Array(N_AGES).fill(0),
  female: new Array(N_AGES).fill(0),
  mortMale: new Array(N_AGES).fill(0),
  mortFemale: new Array(N_AGES).fill(0),
  fert: new Array(N_FERT).fill(0),
};

/**
 * Normalise a snapshot into bar heights.
 *
 * Population is scaled by the country's own largest band, so the pyramid's
 * shape is comparable across countries of wildly different sizes: absolute
 * numbers live in the readout, the arm shows structure.
 *
 * Mortality is log-scaled against a fixed ceiling. Age-specific death rates
 * span orders of magnitude from childhood to old age, and on a linear scale
 * everything below 60 is an invisible stub. Fixed, not per-country, so the
 * arm stays comparable as you pan.
 */
function normalise(s: Snapshot): Normalised {
  const peak = Math.max(...s.male, ...s.female) || 1;
  const MORT_CEIL = Math.log1p(360);
  const logScale = (v: number) => Math.min(1, Math.log1p(Math.max(0, v)) / MORT_CEIL);
  const fertPeak = Math.max(...s.fertShare) || 1;
  return {
    male: s.male.map((v) => v / peak),
    female: s.female.map((v) => v / peak),
    mortMale: s.mortMale.map(logScale),
    mortFemale: s.mortFemale.map(logScale),
    fert: s.fertShare.map((v) => v / fertPeak),
  };
}

export interface LensOptions {
  spec?: LensSpec;
}

/**
 * The lens: a fixed overlay at the viewport centre. Three arms, each a
 * population pyramid bent around a dial, animating toward whatever snapshot
 * it is handed.
 */
export class Lens {
  readonly root: SVGSVGElement;
  private spec: LensSpec;

  private bars = new Map<SeriesKey, SVGPathElement[]>();
  private slots = new Map<SeriesKey, Slot[]>();
  private halves: Half[] = [
    { key: 'male', arm: 'population', side: -1, cls: 'bar-male' },
    { key: 'female', arm: 'population', side: 1, cls: 'bar-female' },
    { key: 'mortMale', arm: 'mortality', side: -1, cls: 'bar-male' },
    { key: 'mortFemale', arm: 'mortality', side: 1, cls: 'bar-female' },
    // Fertility is one series, not a sex split: it takes a single side.
    { key: 'fert', arm: 'fertility', side: 1, cls: 'bar-fert' },
  ];

  private springs: Record<SeriesKey, SpringArray>;
  private fade = new Spring(0, 90, 20);

  private nameEl!: SVGTextElement;
  private statTop!: SVGTextElement;
  private statMid!: SVGTextElement;
  private statBot!: SVGTextElement;

  private ticker: Ticker;
  private current: Snapshot | null = null;
  private firstPaint = true;

  constructor(opts: LensOptions = {}) {
    this.spec = opts.spec ?? DEFAULT_LENS;
    // Corner of the arm's far tip at full bar extension, plus room for the
    // arm's title sitting outside that.
    const tip = this.spec.coreRadius + this.spec.armLength;
    const size = (Math.hypot(tip, this.spec.barReach) + 26) * 2;

    this.root = el('svg', {
      class: 'lens',
      viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`,
      width: size,
      height: size,
      'aria-hidden': 'true',
    });

    this.springs = {
      male: new SpringArray(N_AGES),
      female: new SpringArray(N_AGES),
      mortMale: new SpringArray(N_AGES),
      mortFemale: new SpringArray(N_AGES),
      fert: new SpringArray(N_FERT),
    };

    this.buildDefs();
    this.buildArms();
    this.buildAxes();
    this.buildLabels();
    this.buildCore();

    this.ticker = new Ticker(this.frame);
  }

  private buildDefs(): void {
    const defs = el('defs');

    // No feDropShadow here, deliberately. An SVG filter over the arms forces a
    // full-surface re-rasterise on every frame of a pan, and it measured at
    // ~125ms per frame: about half the lens's entire cost, for decoration.
    // The bars carry their own contrast instead, via CSS.

    for (const arm of ['population', 'mortality', 'fertility'] as ArmKey[]) {
      defs.appendChild(el('path', {
        id: `label-${arm}`,
        d: armLabelPath(this.spec, arm, this.spec.barReach + 13),
        fill: 'none',
      }));
    }
    this.root.appendChild(defs);
  }

  private buildArms(): void {
    const g = el('g', { class: 'lens-arms' });

    for (const h of this.halves) {
      const count = h.key === 'fert' ? N_FERT : N_AGES;
      const slots = armSlots(this.spec, count);
      this.slots.set(h.key, slots);

      const group = el('g', { class: `arm arm-${h.arm} ${h.cls}` });
      const paths = slots.map((slot) => {
        const p = el('path', { d: barPath(this.spec, h.arm, slot, 0, h.side), class: 'bar' });
        group.appendChild(p);
        return p;
      });
      this.bars.set(h.key, paths);
      g.appendChild(group);
    }

    this.root.appendChild(g);
  }

  /**
   * The spine, its age labels and the value axis. Drawn after the bars so the
   * age pills stay legible on top of a dense pyramid.
   */
  private buildAxes(): void {
    const g = el('g', { class: 'lens-axes' });
    const arms: ArmKey[] = ['population', 'mortality', 'fertility'];

    for (const arm of arms) {
      const key: SeriesKey = arm === 'fertility' ? 'fert' : arm === 'mortality' ? 'mortMale' : 'male';
      const slots = this.slots.get(key)!;
      const labels = arm === 'fertility' ? Lens.fertAges : Lens.ages;
      const angle = armTextAngle(arm);

      g.appendChild(el('path', { d: spinePath(this.spec, arm), class: 'spine' }));

      // Value ticks: one at the spine, one at the far reach, on both sides.
      const at = this.spec.coreRadius + this.spec.armLength + 9;
      g.appendChild(el('path', { d: axisTickPath(arm, at, this.spec.barReach * 2), class: 'axis-rule' }));

      // Labelling all 17 bands turns the spine into noise. Anchor bands only:
      // the youngest, the oldest, and a couple of readable landmarks between.
      const marks = arm === 'fertility'
        ? [0, 3, N_FERT - 1]
        : [0, 4, 8, 12, slots.length - 1];

      for (const i of marks) {
        const slot = slots[i];
        const label = labels[i];
        if (!slot || !label) continue;

        // The label rides the spine, in a pill that masks the bars behind it.
        // Parked outside the pyramid it would float free of the data and, on
        // opposed arms, land on opposite sides; on the spine it always reads
        // against the band it names.
        const { x, y } = slotAnchor(arm, slot);
        const pill = el('g', {
          class: 'age-pill',
          transform: `rotate(${angle.toFixed(1)} ${x} ${y})`,
        });
        const w = label.length * 4.6 + 7;
        pill.appendChild(el('rect', {
          x: x - w / 2, y: y - 6, width: w, height: 12, rx: 6, class: 'age-pill-bg',
        }));
        const text = el('text', {
          class: 'age-label', x, y,
          'text-anchor': 'middle', 'dominant-baseline': 'central',
        });
        text.textContent = label;
        pill.appendChild(text);
        g.appendChild(pill);
      }
    }

    this.root.appendChild(g);
  }

  private buildLabels(): void {
    const g = el('g', { class: 'lens-labels' });
    const titles: Record<ArmKey, string> = {
      population: 'POPULATION',
      mortality: 'MORTALITY',
      fertility: 'FERTILITY',
    };
    for (const arm of ['population', 'mortality', 'fertility'] as ArmKey[]) {
      const text = el('text', { class: 'arm-label' });
      const tp = el('textPath', { href: `#label-${arm}`, startOffset: '50%' });
      tp.setAttribute('text-anchor', 'middle');
      tp.textContent = titles[arm];
      text.appendChild(tp);
      g.appendChild(text);
    }
    this.root.appendChild(g);
  }

  private buildCore(): void {
    const g = el('g', { class: 'lens-core' });
    g.appendChild(el('circle', { r: this.spec.coreRadius, class: 'core-disc' }));
    g.appendChild(el('circle', { r: this.spec.coreRadius, class: 'core-rim' }));
    g.appendChild(el('circle', { r: 2.5, class: 'core-dot' }));

    // Four lines stacked inside the disc. The rows are kept short enough that
    // each fits the chord at its own height: the disc narrows toward top and
    // bottom, so a line that fits at the centre can still overrun lower down.
    this.nameEl = el('text', { class: 'core-name', y: -38, 'text-anchor': 'middle' });
    this.statTop = el('text', { class: 'core-stat', y: -8, 'text-anchor': 'middle' });
    this.statMid = el('text', { class: 'core-sub', y: 20, 'text-anchor': 'middle' });
    this.statBot = el('text', { class: 'core-sub', y: 38, 'text-anchor': 'middle' });
    g.append(this.nameEl, this.statTop, this.statMid, this.statBot);

    this.root.appendChild(g);
  }

  /** Point the lens at a new snapshot. Null clears it (ocean, no data). */
  show(snapshot: Snapshot | null, name: string): void {
    this.current = snapshot;
    const target = snapshot ? normalise(snapshot) : EMPTY;
    this.fade.setTarget(snapshot ? 1 : 0);

    for (const key of Object.keys(this.springs) as SeriesKey[]) {
      this.springs[key].setTargets(target[key]);
    }

    if (snapshot) {
      // Long names would overrun the disc; the map label carries the full one.
      this.nameEl.textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name;
      this.statTop.textContent = formatPop(snapshot.total);
      // One line per fact: combined, these overran the disc's chord.
      this.statMid.textContent = `${snapshot.tfr.toFixed(1)} births/woman`;
      this.statBot.textContent = `${snapshot.e0.toFixed(0)} yr life · median ${snapshot.medianAge.toFixed(0)}`;
    }

    if (this.firstPaint && snapshot) {
      this.firstPaint = false;
      for (const key of Object.keys(this.springs) as SeriesKey[]) {
        this.springs[key].reset(target[key]);
      }
      this.fade.reset(1);
    }

    this.ticker.wake();
  }

  private frame = (dt: number): boolean => {
    const opacity = this.fade.step(dt);
    this.root.style.setProperty('--lens-data-opacity', opacity.toFixed(3));

    let animating = !this.fade.settled;
    for (const h of this.halves) {
      const springs = this.springs[h.key];
      if (springs.settled) continue;
      animating = true;
      const values = springs.step(dt);
      const bars = this.bars.get(h.key)!;
      const slots = this.slots.get(h.key)!;
      for (let i = 0; i < bars.length; i++) {
        bars[i]!.setAttribute('d', barPath(this.spec, h.arm, slots[i]!, values[i]!, h.side));
      }
    }
    return animating;
  };

  get snapshot(): Snapshot | null {
    return this.current;
  }

  static get ages(): readonly string[] {
    return AGE_BRACKETS;
  }

  static get fertAges(): readonly string[] {
    return AGE_BRACKETS.slice(FERT_FIRST_BRACKET, FERT_FIRST_BRACKET + N_FERT);
  }
}

/** Population arrives in thousands. */
function formatPop(thousands: number): string {
  const n = thousands * 1000;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} bn`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} k`;
  return `${n.toFixed(0)}`;
}
