/**
 * Composer Enter sends; Shift+Enter inserts a newline. IME composition must
 * not submit mid-candidate.
 */
export function shouldSendOnComposerKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  return true;
}
