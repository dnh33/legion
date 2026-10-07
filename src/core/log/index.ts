/**
 * The logs module: opens the one sink, subscribes to the bus for event lines, and serves the admin-only routes behind
 * Settings, Logs. The routes are not on the MCP client list (src/core/admin.ts), so the default-deny gate answers a
 * bearer-only caller 403.
 */
import { closeSync, openSync, fstatSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreModule, ModuleDeps, RouteAdder } from '../modules.js';
import { LOGS_DESCRIPTION, type LogsErrorsView, type LogsView } from '../../shared/logs.js';
import { attachLogEvents } from './events.js';
import { LogSink } from './logger.js';

export const ERRORS_TAIL_BYTES = 64 * 1024;

/** Opens the sink on `<dataDir>/logs`. One per core. */
export function openLogSink(dataDir: string): LogSink {
  return new LogSink({ dir: join(dataDir, 'logs') });
}

function view(sink: LogSink): LogsView {
  let names: string[] = [];
  try { names = readdirSync(sink.dir).filter((n) => /^(legion|errors|agents|app)\.log(\.[1-3])?$/.test(n)).sort(); } catch { /* no folder yet */ }
  const files = names.map((name) => { try { return { name, bytes: statSync(join(sink.dir, name)).size }; } catch { return { name, bytes: 0 }; } });
  return { dir: sink.dir, files, description: LOGS_DESCRIPTION };
}

function errorsTail(sink: LogSink): LogsErrorsView {
  sink.flushSync();
  let fd: number | undefined;
  try {
    fd = openSync(join(sink.dir, 'errors.log'), 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, ERRORS_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1); // drop the cut first line
    return { text, truncated: size > len };
  } catch { return { text: '', truncated: false }; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

export function createLogsModule(deps: ModuleDeps, opts: { sink: LogSink }): CoreModule {
  const { sink } = opts;
  const detach = attachLogEvents(deps.bus, sink);
  return {
    id: 'logs',
    routes(add: RouteAdder) {
      add('GET', '/api/logs', () => { sink.flushSync(); return view(sink); });
      add('GET', '/api/logs/errors', () => errorsTail(sink));
      // Windows: an open handle makes the delete fail, so close every handle first, then delete, then reopen.
      add('POST', '/api/logs/clear', () => {
        sink.closeAll();
        sink.clearQueue();
        try { rmSync(sink.dir, { recursive: true, force: true }); } finally { sink.reopen(); }
        return view(sink);
      });
    },
    dispose() { detach(); sink.flushSync(); },
  };
}
