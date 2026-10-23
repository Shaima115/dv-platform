import { v7 as uuidv7 } from 'uuid';
import type { Clock, IdGenerator } from '../application/ports/runtime';

export const systemClock: Clock = { now: () => new Date() };
export const uuidV7Generator: IdGenerator = { next: () => uuidv7() };
