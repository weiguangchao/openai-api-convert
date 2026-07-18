import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type { BridgeLog, LogFields, LogLevel, LoggingPolicy } from './types.ts';

export const toLogEntry = (level: LogLevel, event: string, fields: LogFields = {}) => ({
  timestamp: new Date().toISOString(),
  level,
  event,
  request_id: fields.requestId ?? null,
  response_id: fields.responseId ?? null,
  duration_ms: fields.durationMs ?? 0,
  error_code: fields.errorCode ?? null,
  ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['requestId', 'responseId', 'durationMs', 'errorCode'].includes(key))),
});

export const createBridgeLogger = async (statePath: string, logging?: LoggingPolicy) => {
  const level = logging?.level ?? 'info';
  const retentionDays = logging?.retentionDays ?? 7;
  const logDir = logging?.path ?? join(dirname(statePath), 'logs');
  await mkdir(logDir, { recursive: true });
  const entryFormat = winston.format((info) => {
    const entry = (info as { bridgeEntry?: ReturnType<typeof toLogEntry> }).bridgeEntry;
    if (!entry) return info;
    Object.assign(info, entry);
    info.message = entry.event;
    return info;
  })();
  const logger = winston.createLogger({
    level,
    transports: [
      new winston.transports.Console({
        level,
        format: winston.format.combine(
          entryFormat,
          winston.format.printf((info) => {
            const entry = (info as { bridgeEntry?: ReturnType<typeof toLogEntry> }).bridgeEntry;
            return JSON.stringify(entry ?? { level: info.level, event: info.message });
          }),
        ),
      }),
      new DailyRotateFile({
        level,
        dirname: logDir,
        filename: 'bridge-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: `${retentionDays}d`,
        format: winston.format.combine(
          entryFormat,
          winston.format.printf((info) => {
            const entry = (info as { bridgeEntry?: ReturnType<typeof toLogEntry> }).bridgeEntry;
            if (!entry) return `${info.level} ${info.message}`;
            return `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.event}\n${JSON.stringify(entry, null, 2)}`;
          }),
        ),
      }),
    ],
  });
  const log: BridgeLog = (logLevel, event, fields = {}) => {
    const bridgeEntry = toLogEntry(logLevel, event, fields);
    logger.log({ level: logLevel, message: event, bridgeEntry });
  };
  const close = () => new Promise<void>((resolve, reject) => {
    logger.on('error', reject);
    logger.on('finish', () => resolve());
    logger.end();
  });
  return { log, close, level };
};
