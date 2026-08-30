import pino from 'pino';
import { config } from './config';

/**
 * Structured logging (see docs/ARCHITECTURE.md §Observability). Every log line is JSON in
 * production so it's queryable by a log aggregator; pretty-printed locally for readability.
 * We log with `logger.child({...})` at call sites to attach requestId/userId context rather
 * than string-interpolating it into messages.
 */
export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
