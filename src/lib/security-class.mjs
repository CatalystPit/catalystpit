// Classifies a 13F position as common equity or something else, from evidence the FILING itself
// carries rather than from a guess about the issuer.
//
// Two authoritative signals, in order:
//   1. put_call, which the SEC form has its own column for. A put or a call is never common stock.
//   2. The filer's own "title of class" string. 13F requires it, and while the text is free-form
//      (13,519 distinct strings in one quarter) the vocabulary is small and conventional: COM, CL A,
//      SHS, ORD, PFD, WT, NOTE 3.625% 6/15/26. Reading what the filer declared is not inference.
//
// A third signal, the CUSIP's own structure, is used ONLY for the one thing it states unambiguously:
// a leading letter means a CINS, the international numbering scheme, so the security is foreign.
// That is a domicile fact, not a type, and it never overrides the declared class.
//
// Everything that does not match a rule stays 'unknown'. Unknown is a real answer here: it keeps a
// security out of the stock rankings without asserting anything false about it.

// Order matters. Debt is tested before equity because "CONV SUB NOTE COM" is a note, not a share,
// and preferred before common because "PFD CL A" is preferred, not class A common.
const RULES = [
  // Floating-rate and securitised paper first: "AAA CLO FLTNG RT" ends in RT and is emphatically not
  // a subscription right, and "BB RT USD HI YLD" is a high-yield bond basket.
  ['debt', /\b(FLTN?G|FLOATING|FLTG|CLO|CDO|MTGE?|MORTGAGE|TSY|TREAS|TREASURY|MUNI|CORP\s*BD)\b/i],
  ['debt', /\b(NOTE|NOTES|BOND|BONDS|DEB|DEBENTURE|SR\s*NT|SUB\s*NT|CONV\s*(SUB)?\s*NT|MTN)\b|\d\s*(\.\d+)?\s*%|\bDUE\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i],
  ['option', /\b(CALL|PUT|CALLS|PUTS)\b/i],
  ['warrant', /\b(WT|WTS|WARRANT|WARRANTS|WARR)\b/i],
  ['right', /\b(RTS|RIGHT|RIGHTS)\b|\bRT\b(?!\s*(INC|USD|FD))/i],
  ['unit', /\b(UNIT|UNITS|UNT)\b/i],
  ['preferred', /\b(PFD|PREF|PREFERRED|PRF)\b/i],
  ['etf_fund', /\b(ETF|ETN|FUND|FDS?|MUTUAL|INDEX\s*FD|CLOSED\s*END|UIT|TRUST\s*UNITS?|SPDR|ISHARES|MF\b)\b/i],
  ['adr', /\b(ADR|ADS|ADR'?S|SPONSORED\s*AD[RS]|GDR)\b/i],
  ['common', /\b(COM|COMMON|CMN|SHS|SH|STOCK|ORD|ORDINARY|EQUITY|EQUITIES|CL\s*[A-Z]|CLASS\s*[A-Z]|NPV|SHARES)\b/i],
];

// What may appear in a "Top Accumulated Stocks" style ranking. ADRs are ordinary equity exposure to
// an operating company and belong; funds and ETFs do not, because a flow into SPY is not a view on a
// company. Everything else is structurally a different instrument.
export const RANKABLE = new Set(['common', 'adr']);

export function classifySecurity({ cls, putCall, cusip }) {
  if (putCall && String(putCall).trim() !== '') {
    return { kind: 'option', source: 'put_call', confidence: 'high', evidence: String(putCall) };
  }
  const text = String(cls || '').trim();
  if (!text) return { kind: 'unknown', source: 'none', confidence: 'none', evidence: '' };
  for (const [kind, re] of RULES) {
    if (re.test(text)) return { kind, source: 'class_text', confidence: 'high', evidence: text.slice(0, 60) };
  }
  return { kind: 'unknown', source: 'none', confidence: 'none', evidence: text.slice(0, 60) };
}

// A CINS (leading letter) is a non-US issue. Stated by the identifier, so it is a fact, not a guess.
// It says nothing about whether the security is common stock, only where it was issued.
export const isForeignCusip = (cusip) => /^[A-Z]/i.test(String(cusip || ''));


// Secondary source, used ONLY when the filing's own words decide nothing. These are Polygon asset
// types already stored in screener_stocks for tickers we resolved, so it is a lookup in our own
// data rather than an inference about the security. Recorded at 'medium' confidence to keep the
// distinction visible: the filing said nothing, we matched on ticker.
const ASSET_TYPE_KIND = {
  CS: 'common', Stock: 'common', OS: 'common', ADRC: 'adr', ADRP: 'preferred',
  ETF: 'etf_fund', ETN: 'etf_fund', ETV: 'etf_fund', ETS: 'etf_fund', FUND: 'etf_fund',
  WARRANT: 'warrant', UNIT: 'unit', RIGHT: 'right', PFD: 'preferred', SP: 'other', BOND: 'debt',
};

export function classifyWithFallback({ cls, putCall, cusip, assetType }) {
  const primary = classifySecurity({ cls, putCall, cusip });
  if (primary.kind !== 'unknown') return primary;
  const kind = assetType ? ASSET_TYPE_KIND[assetType] : null;
  if (!kind) return primary;
  return { kind, source: 'asset_type', confidence: 'medium', evidence: String(assetType) };
}
