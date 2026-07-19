import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type { BridgeLog, LogFields, LogLevel, LoggingPolicy } from './types.js';

const standardFields = new Set(['requestId', 'responseId', 'durationMs', 'errorCode']);

export const toLogEntry = (level: LogLevel, event: string, fields: LogFields = {}) => Object.fromEntries(Object.entries({
  timestamp: new Date().toISOString(),
  level,
  event,
  request_id: fields.requestId,
  response_id: fields.responseId,
  duration_ms: fields.durationMs,
  error_code: fields.errorCode,
  ...Object.fromEntries(Object.entries(fields).filter(([key]) => !standardFields.has(key))),
}).filter(([, value]) => value !== null && value !== undefined));

type BridgeLogEntry = ReturnType<typeof toLogEntry>;

const isBareValue = (value: unknown): value is string | number => (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && /^[A-Za-z0-9._:/@%+=?&-]+$/.test(value));

const formatValue = (value: unknown) => isBareValue(value) ? String(value) : JSON.stringify(value);

export const formatBridgeLogEntry = (entry: BridgeLogEntry) => {
  const fields = Object.entries(entry)
    .filter(([key]) => !['timestamp', 'level', 'event'].includes(key))
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  const prefix = `${entry.timestamp} ${String(entry.level).toUpperCase()} [bridge] ${entry.event}`;
  return fields.length ? `${prefix} ${fields.join(' ')}` : prefix;
};

export const createBridgeLogger = async (statePath: string, logging?: LoggingPolicy) => {
  const level = logging?.level ?? 'info';
  const retentionDays = logging?.retentionDays ?? 7;
  const logDir = logging?.path ?? join(dirname(statePath), 'logs');
  await mkdir(logDir, { recursive: true });
  const lineFormat = winston.format.printf((info) => {
    const entry = (info as { bridgeEntry?: BridgeLogEntry }).bridgeEntry;
    return entry ? formatBridgeLogEntry(entry) : `${info.level.toUpperCase()} ${info.message}`;
  });
  const logger = winston.createLogger({
    level,
    transports: [
      new winston.transports.Console({
        level,
        format: lineFormat,
      }),
      new DailyRotateFile({
        level,
        dirname: logDir,
        filename: 'bridge-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: `${retentionDays}d`,
        format: lineFormat,
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
