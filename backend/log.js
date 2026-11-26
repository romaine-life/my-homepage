// The backend's log: the estate's one log line (romaine-life/logline, AHT-204) on stdout,
// which the cluster ships.
//
//   2026-11-26T14:02:11.408-08:00 pid=1 info request method=GET path=/script.js status=200 ms=1
//
// A message is fixed text; what varies goes in fields. Text from outside the program (an
// error, a request path, an upstream's answer) goes through `outside` or `errorText`, which
// mask what looks like a credential and cap it. A session cookie, token or Authorization
// value is never passed to the log at all.
import { Logger, redact } from '@romaine-life/logline';

const stdout = Logger.stream(process.stdout);

// A field whose value is undefined or null is left out.
function present(fields) {
  return Object.entries(fields || {}).filter(([, value]) => value !== undefined && value !== null);
}

export const log = {
  log(level, message, fields) { stdout.log(level, message, present(fields)); },
  info(message, fields) { log.log('info', message, fields); },
  warn(message, fields) { log.log('warn', message, fields); },
  error(message, fields) { log.log('error', message, fields); },
};

// The most a field holding outside text keeps, so one upstream answer can't flood the log.
export const OUTSIDE_LIMIT = 4096;

// Text from outside the program, masked and capped for a field.
export function outside(text) {
  const masked = redact(String(text));
  return masked.length > OUTSIDE_LIMIT ? `${masked.slice(0, OUTSIDE_LIMIT)}...` : masked;
}

// An error for the `error` field: its stack (which starts with its message), masked. Pass
// { stack: false } for its message alone, where the stack says nothing.
export function errorText(error, { stack = true } = {}) {
  if (error instanceof Error) return outside(stack && error.stack ? error.stack : `${error.name}: ${error.message}`);
  if (error && typeof error === 'object' && 'message' in error) return outside(error.message);
  return outside(error);
}

// One line per request, once it is answered: method, path, status and milliseconds. The path
// is the URL's path alone: a query is never logged. A server failure (5xx) is an error.
export function requestLog() {
  return (req, res, next) => {
    const start = performance.now();
    // Read now: a router mounted under a prefix shortens req.path while it handles the request.
    const pathname = req.path;
    res.on('finish', () => {
      log.log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
        method: req.method,
        path: outside(pathname),
        status: res.statusCode,
        ms: Math.round(performance.now() - start),
      });
    });
    next();
  };
}
