/** The pieces of a proposal that the Inbox and the chat card share, kept pure so both say the same thing. */

/** The board store's actions resolve to the result on success and to undefined on failure (the error is already on screen). */
export function actionNotice(result: unknown, okText: string): string | null { return result ? okText : null; }

export function actionState(o: { archived: boolean; busy: boolean }): { disabled: boolean; reason?: string } {
  if (o.archived) return { disabled: true, reason: 'This project is archived. Unarchive it to decide.' };
  if (o.busy) return { disabled: true, reason: 'Working on the board. Try again in a moment.' };
  return { disabled: false };
}

export function proposalNote(by: string, tainted: boolean): string {
  return `Suggested by ${by}. Not reviewed.${tainted ? ' Its run had read outside content (the web, GitHub text, other tools or files from outside the project), so treat the text with extra care.' : ''}`;
}

/** Whether the description is longer than the three lines the card shows before its More toggle. */
export function descriptionNeedsMore(text: string): boolean { return text.split('\n').length > 3 || text.length > 240; }
