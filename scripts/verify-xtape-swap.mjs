// The X Tape must never show an empty panel during a refresh.
//
// This models the DOM lifecycle of a rebuild against X's REAL reveal ordering, taken from
// platform.twitter.com/widgets.js: the sandbox creates its iframe with
//   { position:'absolute', visibility:'hidden', display:'block', width:'0px', height:'0px' }
// and reveals it later with { position:'static', visibility:'visible' } via makeVisible(). Because
// the timeline factory calls setWaitToSwapUntilRendered(true), that reveal is deferred to the end of
// the render chain, while the iframe's real height arrives EARLIER on the resize message. So there
// is a window in which the frame has full height and is still invisible.
//
// Two bugs shipped through that window, and both are pinned here:
//
//   1. THE CLEANUP BUG (the one users actually saw). React runs an effect's cleanup before the next
//      effect. The cleanup removed `slot` unconditionally — but `slot` is the staging slot only
//      until swapIn() succeeds; after that it IS the visible tape. So every refresh deleted the tape
//      from the DOM before the new build even started, leaving the panel empty for the whole build.
//
//   2. THE READINESS BUG. Waiting on offsetHeight alone resolves during the window above, because
//      visibility:hidden does not remove an element from layout. The swap then revealed a slot whose
//      iframe X had not yet made visible.
//
// Run: node scripts/verify-xtape-swap.mjs

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };

class El {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.parent = null;
    this._style = { visibility: '', zIndex: '', pointerEvents: '' };
    this._height = 0; this._revealed = false;
  }
  get style() {
    const t = this._style;
    return new Proxy(t, { set(o, k, v) {
      if (k === 'cssText') { o.visibility = /visibility:hidden/.test(v) ? 'hidden' : ''; o.zIndex = '0'; }
      o[k] = v; return true;
    } });
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  querySelector() { return this.children.find((c) => c.tag === 'iframe') || null; }
  // What a user would actually see: a slot that is not hidden, holding an iframe X has revealed.
  get showsTape() { return this.children.some((s) => s._style.visibility !== 'hidden' && s.querySelector()?._revealed); }
}

// `guardCleanup`  — cleanup only removes a slot that was never swapped in
// `waitForReveal` — readiness requires X's makeVisible(), not merely height
function simulate({ guardCleanup, waitForReveal, builds = 4 }) {
  const container = new El();
  let slot = null, blanks = 0, samples = 0, build = 0;
  const sample = () => { if (build === 0) return; samples++; if (!container.showsTape) blanks++; };

  for (; build < builds; build++) {
    if (build > 0) {                                  // React cleanup for the previous build
      if (slot && (!guardCleanup || slot._style.visibility === 'hidden')) slot.remove();
      slot = null;
    }
    sample();                                          // the instant a refresh begins
    slot = container.appendChild(new El());
    slot.style.cssText = 'position:absolute;left:0;top:0;width:100%;visibility:hidden;z-index:0';
    const frame = slot.appendChild(new El('iframe'));
    sample();
    frame._height = 600;                               // X: resize message, still visibility:hidden
    sample();

    const reveal = () => { slot.style.visibility = 'visible'; };
    const dropOld = () => { for (const c of [...container.children]) if (c !== slot) c.remove(); };
    const makeVisible = () => { frame._revealed = true; };

    if (waitForReveal) {
      // Readiness = height AND computed visibility, so nothing happens until X has revealed.
      makeVisible(); sample();
      reveal(); sample();
      dropOld(); sample();
    } else {
      // Height-only readiness fires while the frame is still invisible. The overlap removal then
      // drops the old tape BEFORE X gets round to makeVisible(), and that is the blank.
      reveal(); sample();
      dropOld(); sample();
      makeVisible(); sample();
    }
  }
  return { blanks, samples };
}

console.log('\n=== REFRESH MUST NEVER BLANK (first load excluded: it legitimately has no tape yet) ===');
const shipped = simulate({ guardCleanup: true, waitForReveal: true });
ok('the fixed lifecycle never shows an empty panel', shipped.blanks === 0, `${shipped.blanks}/${shipped.samples} blank`);
console.log(`  fixed: ${shipped.blanks} blank moments in ${shipped.samples} samples`);

console.log('\n=== each bug, pinned so it cannot come back ===');
const cleanupBug = simulate({ guardCleanup: false, waitForReveal: true });
ok('removing the visible tape in cleanup DOES blank the panel', cleanupBug.blanks > 0,
  'the regression this test exists for would pass silently');
console.log(`  unconditional cleanup removal: ${cleanupBug.blanks}/${cleanupBug.samples} blank`);

const revealBug = simulate({ guardCleanup: true, waitForReveal: false });
ok('swapping on height alone DOES blank the panel', revealBug.blanks > 0,
  'visibility:hidden keeps layout, so height is not readiness');
console.log(`  height-only readiness: ${revealBug.blanks}/${revealBug.samples} blank`);

const bothBugs = simulate({ guardCleanup: false, waitForReveal: false });
ok('both bugs together are worst of all', bothBugs.blanks >= cleanupBug.blanks);
console.log(`  both: ${bothBugs.blanks}/${bothBugs.samples} blank`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
