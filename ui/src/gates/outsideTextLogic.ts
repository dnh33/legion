/** The words on Settings, Gates, Outside text. Plain, no em dashes; the doc in docs/ and SECURITY.md say the same things. */
export const OUTSIDE_TEXT_COPY = {
  title: 'Outside text',
  lead: 'Legion marks a run when it may have read text that someone else wrote. A marked run cannot assign or delete board items, write working memory, or write shared notes directly (they wait in your Inbox). The mark passes on to helpers the run starts.',
  notice: 'New in this update: commands that only work inside your project (git status, search, tests and builds) no longer mark a run. The web, GitHub text, other tools, commands Legion cannot check and files from outside your project still do. In a repository you do not trust, choose Strict.',
  keep: 'Keep this',
  useStrict: 'Use strict',
  shellLabel: 'Shell commands',
  shell: {
    local: { name: 'By source (recommended)', help: 'Local commands in your project do not mark a run. A command that reaches the network, or that Legion cannot read with certainty, does.' },
    strict: { name: 'Strict', help: 'Every shell command marks the run. Use it in a repository you do not trust: a test or build script there can fetch a web page, and Legion judges the command you typed, not what the script does inside.' },
  },
  filesName: 'Files outside the project count',
  filesHelp: 'Reading a file outside your project, in node_modules or vendor, or inside a cloned repository marks the run.',
  limits: 'Not covered: a file that a marked run wrote with a shell command (not with the file tools), and text a project script fetches by itself.',
} as const;
