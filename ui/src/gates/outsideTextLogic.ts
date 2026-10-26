/** The words on Settings, Gates, Outside text. Plain, no em dashes; the doc in docs/ and SECURITY.md say the same things. */
export const OUTSIDE_TEXT_COPY = {
  title: 'Outside text',
  lead: 'Legion labels a run that read text someone else wrote: the web, GitHub issues and comments, other tools, or files from outside your project. A labelled run works as normal. What it creates carries the label, and the next run is told when its working memory came from a labelled run. Money confirmations, GitHub write cards and trigger tags (which fire only from a note you wrote or edited yourself) still apply.',
  notice: 'New in this update: a run that read outside text is labelled, not locked. It can use the board, write memory and share notes as usual, and running a program no longer marks a run at all. In a repository you do not trust, choose Strict.',
  keep: 'Keep this',
  useStrict: 'Use strict',
  shellLabel: 'Shell commands',
  shell: {
    local: { name: 'By source (recommended)', help: 'Only text that comes in from outside marks a run: the web, GitHub text, and files outside your project or in node_modules. A marked run is labelled, not locked.' },
    strict: { name: 'Strict', help: 'Every shell command marks the run, and a marked run is locked: it cannot assign or delete board items, write working memory or links, or write shared notes directly (they wait in your Inbox). Web access after a run read GitHub data asks first. Use it in a repository you do not trust: a test or build script there can fetch a web page, and Legion judges the command you typed, not what the script does inside.' },
  },
  filesName: 'Files outside the project count',
  filesHelp: 'Reading a file outside your project, in node_modules or vendor, or inside a cloned repository marks the run.',
  limits: 'Not covered: text that a program fetches by itself while it runs. Strict marks every shell command, so use it when that matters.',
} as const;
