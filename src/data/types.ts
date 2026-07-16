/** Five-year age brackets, index 0 = 0-4, index 16 = 80+. */
export const AGE_BRACKETS = [
  '0-4', '5-9', '10-14', '15-19', '20-24', '25-29', '30-34', '35-39',
  '40-44', '45-49', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80+',
] as const;

export const N_AGES = AGE_BRACKETS.length;

/** Fertility is only defined over reproductive ages: brackets 15-19 .. 45-49. */
export const FERT_FIRST_BRACKET = 3;
export const FERT_LAST_BRACKET = 9;
export const N_FERT = FERT_LAST_BRACKET - FERT_FIRST_BRACKET + 1;

/**
 * One country at one point in time. Arrays are indexed by age bracket.
 * Stored packed so the whole world at decade snapshots stays a small payload.
 */
export interface Snapshot {
  /** Population in thousands, by age bracket. */
  male: number[];
  female: number[];
  /** Deaths per 1000 in the bracket (age-specific mortality), by age bracket. */
  mortMale: number[];
  mortFemale: number[];
  /** Share of total births occurring in each reproductive bracket, sums to 1. */
  fertShare: number[];
  /** Total fertility rate: births per woman. */
  tfr: number;
  /** Life expectancy at birth, both sexes, in years. */
  e0: number;
  /** Total population in thousands. */
  total: number;
  /** Median age in years. */
  medianAge: number;
}

export interface Country {
  /** ISO 3166-1 alpha-3. */
  iso3: string;
  name: string;
  /** Representative point for the country, [lon, lat]. */
  centroid: [number, number];
  /** Keyed by year. */
  years: Record<number, Snapshot>;
}

export interface Dataset {
  years: number[];
  countries: Record<string, Country>;
}
