'use client';
import { Dropdown, MenuItem } from './ChartUI';

// The chart-level view controls.
//
// CHART TYPE IS NOT HERE. It has its own compact icon control in the toolbar at every width, and a
// second selector in this menu would be both a duplicate and a worse one — the toggle this replaced
// flipped Candles/Line only, so it could not reach Area at all.
//
// Built on the shared Dropdown, so it is portalled and anchored like every other chart menu. It used
// to be a hand-rolled absolute panel, which the Terminal panel's `overflow: hidden` clipped exactly
// as it clipped the chart-type menu. Aligned right because it sits at the end of the toolbar.

/**
 * The rows, as an array, so the narrow-panel overflow menu can show exactly these controls rather
 * than carrying its own copy that drifts out of step with this one.
 *
 * Toggles keep the menu open: changing the price scale and then the auto-scale is one visit, not
 * two. Reset is a command, so it closes.
 */
export function viewMenuItems({ theme, view, canExtend, onPatch, onReset }) {
  const toggle = (label, on, onClick, onText = 'On', offText = 'Off') => (
    <MenuItem key={label} theme={theme} role="menuitemcheckbox" active={on} onClick={onClick}
      closeOnPick={false} right={on ? onText : offText}>{label}</MenuItem>
  );
  return [
    // Extended hours is meaningless on a daily bar, so the row is absent rather than disabled there.
    ...(canExtend ? [toggle('Extended hours', !!view.extended, () => onPatch({ extended: !view.extended }))] : []),
    toggle('Price scale', !!view.logScale, () => onPatch({ logScale: !view.logScale }), 'Log', 'Linear'),
    toggle('Auto scale', !!view.autoScale, () => onPatch({ autoScale: !view.autoScale })),
    <MenuItem key="Reset view" theme={theme} role="menuitem" onClick={onReset}>Reset view</MenuItem>,
  ];
}

export default function ChartMenu({ theme, view, canExtend, onPatch, onReset }) {
  return (
    <Dropdown theme={theme} title="Chart settings" menuLabel="Chart settings" align="right" width={186}
      label="⚙">
      {viewMenuItems({ theme, view, canExtend, onPatch, onReset })}
    </Dropdown>
  );
}
