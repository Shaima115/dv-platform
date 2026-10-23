/** Nest injection tokens for shared infrastructure. */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const LOGGER = Symbol('LOGGER');
export const READINESS_CHECK = Symbol('READINESS_CHECK');

/** Returns true when the service can do useful work (database reachable). */
export type ReadinessCheck = () => Promise<boolean>;
