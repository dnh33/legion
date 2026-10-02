/**
 * A key that belongs to an IME (Japanese, Chinese, Korean input...). While composing, Enter confirms the candidate text and must not send,
 * queue, interrupt or save anything. Chromium reports isComposing; Safari fires the confirming keydown just AFTER compositionend, with
 * isComposing already false but keyCode 229, so both are checked.
 */
export const isImeKey = (e: { isComposing?: boolean; keyCode?: number }): boolean => e.isComposing === true || e.keyCode === 229;
