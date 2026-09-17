export type LogFormat = 'human' | 'json';

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(format: LogFormat): Logger {
  const write = (
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ) => {
    // Under `--json` stdout carries exactly one document (the envelope), so
    // every log line — progress, warning, and error — goes to stderr. Human
    // output is unchanged: info/warn are the rendering, error is a failure.
    if (format === 'json') {
      console.error(JSON.stringify({ level, message, ...data }));
      return;
    }
    const stream = level === 'error' ? console.error : console.log;
    stream(data ? `${message} ${JSON.stringify(data)}` : message);
  };

  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
