// UNDO / REDO, as a pure value.
//
// A history is a plain object and every operation returns a NEW one — no mutation, no subscriptions,
// no singleton. That is what lets each Terminal chart panel own its own stack: two charts side by
// side undo independently because each holds its own value, and nothing global exists to confuse.
//
// SNAPSHOTS, NOT COMMANDS. Each entry is the whole drawing list as it was before a change. A command
// log (an "add", an "undo-add") would be smaller, but every operation would need its own inverse —
// move, resize, clone, lock, hide, restyle — and one missing inverse is a corrupted chart. The lists
// are bounded (MAX_PER_SYMBOL drawings) so a hundred snapshots is a trivial amount of memory, and
// correctness is worth more here than bytes.
//
// COALESCING IS THE REASON `tag` EXISTS. Dragging a trend line fires a change on every pointer move;
// without coalescing a single drag would fill the entire stack and undo would step back through it
// one pixel at a time. The caller passes a token that is stable for the duration of one gesture, so
// only the FIRST change of that gesture records — which is exactly the state to come back to.

export const MAX_HISTORY = 100;

/** A fresh, empty history. */
export const emptyHistory = () => ({ past: [], future: [], tag: null });

export const canUndo = (h) => !!h && h.past.length > 0;
export const canRedo = (h) => !!h && h.future.length > 0;

/**
 * Record the state that existed BEFORE a change.
 *
 * `tag` coalesces a gesture: passing the same non-null token again records nothing, because the
 * state to return to was already captured when the gesture began. Passing null (or a new token)
 * always records.
 *
 * Recording clears the redo stack, which is what every editor does: once you branch off an undone
 * edit, the future you undid is no longer reachable and pretending otherwise loses the new work.
 */
export function record(history, prevState, tag = null) {
  const h = history || emptyHistory();
  if (tag != null && h.tag === tag) return h;           // same gesture; already captured
  const past = [...h.past, prevState];
  // Oldest entries fall off the bottom rather than the stack growing without limit.
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { past, future: [], tag };
}

/**
 * Step back one change.
 *
 * Returns null when there is nothing to undo, so the caller can leave its state untouched rather
 * than re-rendering with an identical value.
 */
export function undo(history, currentState) {
  if (!canUndo(history)) return null;
  const past = history.past.slice(0, -1);
  const state = history.past[history.past.length - 1];
  // The tag is cleared so the next edit always records: a gesture cannot span an undo.
  return { history: { past, future: [...history.future, currentState], tag: null }, state };
}

/** Step forward one change. Null when there is nothing to redo. */
export function redo(history, currentState) {
  if (!canRedo(history)) return null;
  const future = history.future.slice(0, -1);
  const state = history.future[history.future.length - 1];
  return { history: { past: [...history.past, currentState], future, tag: null }, state };
}

/**
 * A token that is stable for one gesture and unique across gestures.
 *
 * Used as the coalescing `tag`: a drag takes one token at pointer-down and passes the same one on
 * every move, so the whole drag is a single undo step.
 */
let seq = 0;
export function gestureToken(prefix = 'g') {
  seq += 1;
  return `${prefix}:${seq}`;
}
