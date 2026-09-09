// Catalyst-importance tiers — editorial flags, NOT a numeric score. Pure heuristic (free, no LLM):
// event-type keywords + category + 8-K material flag, dampened for routine boilerplate.
// Used by the news feed flags and the Top Catalysts module. tier ∈ 'high' | 'notable' | 'routine'.

// Market-moving: structural change to the company or a hard surprise.
const HIGH_KW = [
  'bankrupt', 'chapter 11', 'going concern', 'delist', 'restate', 'restatement',
  'to acquire', 'acquisition of', 'acquires', 'to be acquired', 'merger', 'merges', 'buyout', 'takeover', 'm&a',
  'fda approv', 'fda reject', 'complete response letter', 'breakthrough therapy', 'meets primary endpoint',
  'phase 3', 'topline', 'fails to meet', 'misses primary', 'halted', 'trading halt',
  'cuts guidance', 'raises guidance', 'withdraws guidance', 'profit warning', 'slashes',
  'sec charges', 'sec investigation', 'subpoena', 'recall', 'data breach', 'cyberattack',
  'strategic alternatives', 'explores sale',
];
// Meaningful but expected / second-order.
const NOTABLE_KW = [
  'earnings', 'results', 'quarter', 'quarterly', 'revenue', 'eps', 'beats', 'misses', 'guidance',
  'offering', 'convertible', 'private placement', 'registered direct', 'notes offering', 'prices',
  'ceo', 'cfo', 'resign', 'appoint', 'steps down', 'names new', 'interim',
  'buyback', 'repurchase', 'dividend', 'special dividend', 'partnership', 'collaboration',
  'contract', 'awarded', 'wins', 'upgrade', 'downgrade', 'initiates coverage', 'price target',
];
// Boilerplate that pulls importance back down (unless a HIGH keyword already fired).
const ROUTINE_KW = [
  'to present', 'to attend', 'to participate', 'webcast', 'conference call', 'to report',
  'to host', 'investor day', 'schedules', 'announces date', 'will present', 'to speak',
];

const CAT_HIGH = new Set(['M&A', 'SEC']);
const CAT_NOTABLE = new Set(['EARNINGS', 'IPO', 'FED']);

export function impactOf(item = {}) {
  const t = `${item.title || item.headline || ''}`.toLowerCase();
  const cat = `${item.category || item.tag || ''}`.toUpperCase();
  const material = item.material === true;

  const hitHigh = HIGH_KW.some((k) => t.includes(k)) || CAT_HIGH.has(cat);
  if (hitHigh) return 'high';

  const routine = ROUTINE_KW.some((k) => t.includes(k));
  const hitNotable = NOTABLE_KW.some((k) => t.includes(k)) || CAT_NOTABLE.has(cat) || material;
  if (hitNotable && !routine) return 'notable';

  return 'routine';
}

export const IMPACT_RANK = { high: 3, notable: 2, routine: 1 };

// Editorial flag styling — subtle colored tag, no number, no emoji. null = don't render a flag.
export const IMPACT_STYLE = {
  high:    { label: 'HIGH IMPACT', bg: '#FCE9E7', fg: '#B23B2E' },
  notable: { label: 'NOTABLE',     bg: '#FFF6E8', fg: '#7A5018' },
  routine: null,
};
