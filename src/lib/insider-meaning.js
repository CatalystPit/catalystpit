// src/lib/insider-meaning.js
// Plain-English interpretation layer OVER raw SEC Form 4 transaction codes. The raw transaction_code
// is never replaced — this is the read-only meaning of each code. Every entry traces to the SEC code.
// Client-safe (no imports, no secrets).

export const TXN_MEANING = {
  P: { label: 'Purchase',        short: 'BUY',          kind: 'buy',      openMarket: true,
       tip: 'Open-market or private purchase. The insider acquired shares using their own capital rather than receiving them as compensation. This represents a discretionary investment decision.' },
  S: { label: 'Sale',            short: 'SELL',         kind: 'sell',     openMarket: true,
       tip: 'Open-market or private sale. If a Rule 10b5-1 plan is disclosed, the trade may have been scheduled in advance. Check that before reading it as a new discretionary decision.' },
  A: { label: 'Award / Grant',   short: 'AWARD',        kind: 'grant',    openMarket: false,
       tip: 'Shares received through a compensation or equity award. This is not an open-market purchase and does not necessarily reflect a discretionary investment decision.' },
  M: { label: 'Option Exercise', short: 'OPT EXERCISE', kind: 'exercise', openMarket: false,
       tip: 'Shares acquired by exercising or converting a derivative security (options, RSUs). This should not be read as an open-market purchase.' },
  F: { label: 'Tax Withholding', short: 'TAX',          kind: 'tax',      openMarket: false,
       tip: 'Shares withheld or disposed to satisfy taxes tied to vesting or compensation. This is not the same as a discretionary open-market sale.' },
  G: { label: 'Gift',            short: 'GIFT',         kind: 'gift',     openMarket: false,
       tip: 'Shares transferred as a gift. This is not an open-market purchase or sale.' },
  C: { label: 'Conversion',      short: 'CONVERT',      kind: 'exercise', openMarket: false,
       tip: 'Shares acquired through conversion of a derivative security. Not an open-market purchase.' },
  D: { label: 'Return to Issuer', short: 'DISPOSED',    kind: 'other',    openMarket: false,
       tip: 'Shares disposed to or returned to the issuer (e.g. forfeiture). Not a discretionary open-market sale.' },
  X: { label: 'Option Exercise', short: 'EXERCISE',     kind: 'exercise', openMarket: false,
       tip: 'An in-the-money derivative security was exercised. Not an open-market purchase.' },
  W: { label: 'Will / Inheritance', short: 'WILL',      kind: 'other',    openMarket: false,
       tip: 'Acquisition or disposition by will or the laws of descent and distribution. Not an open-market transaction.' },
  J: { label: 'Other',           short: 'OTHER',        kind: 'other',    openMarket: false,
       tip: 'Other acquisition or disposition reported on Form 4. See the SEC filing footnotes for the specific nature of the transaction.' },
  L: { label: 'Small Acquisition', short: 'OTHER',      kind: 'other',    openMarket: false,
       tip: 'Small acquisition under Rule 16a-6. See the SEC filing for details.' },
  U: { label: 'Tender / Merger', short: 'OTHER',        kind: 'other',    openMarket: false,
       tip: 'Disposition of shares pursuant to a tender of shares in a merger or acquisition. See the SEC filing.' },
  I: { label: 'Other',           short: 'OTHER',        kind: 'other',    openMarket: false,
       tip: 'Discretionary transaction other than by the above codes. See the SEC filing for details.' },
};

export const meaningFor = (code) =>
  TXN_MEANING[code] || { label: code || 'Unknown', short: code || 'OTHER', kind: 'other', openMarket: false,
    tip: 'Transaction reported on a SEC Form 4. See the filing for the specific nature of the transaction.' };

export const isOpenMarket = (code) => !!TXN_MEANING[code]?.openMarket;
