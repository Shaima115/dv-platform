export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  /** Time-ordered UUID (v7). */
  next(): string;
}
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const TRANSACTIONS = Symbol('TRANSACTIONS');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const CORE_SETTINGS = Symbol('CORE_SETTINGS');

export interface CoreSettings {
  submissionClaimMs: number;
}
