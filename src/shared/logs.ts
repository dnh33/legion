/** Settings, Logs: the text and the shape of GET /api/logs. Shared by the core route and the window. */

/** The lead line of the Logs screen. It says what the record is for and what it holds, in plain words. */
export const LOGS_DESCRIPTION =
  'Legion keeps a short record of what it did (runs, errors, updates) on this computer, so you can see what went wrong and share it if you ask for help. It never includes what you or your agents wrote, and it is never sent anywhere.';

export interface LogFileView { name: string; bytes: number }
export interface LogsView {
  /** The folder the files are in (the user's own computer). */
  dir: string;
  files: LogFileView[];
  description: string;
}
export interface LogsErrorsView {
  /** The tail of errors.log (newest at the end), capped; empty when nothing went wrong. */
  text: string;
  truncated: boolean;
}
