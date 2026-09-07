// Curated 13F filers for the Institutions feature. `secName` = canonical SEC/EDGAR entity name
// (used to resolve the CIK when `cik` is omitted). `cik` seeded only where confident; the
// ingestion verifies every CIK (entity name + must file 13F-HR) and skips + logs mismatches,
// so a wrong/blank CIK never publishes a bogus fund. Edit freely — no migration needed.
export const INSTITUTIONS = [
  // ── Value & legends ──
  { slug: 'berkshire-hathaway', label: 'Berkshire Hathaway', manager: 'Warren Buffett', category: 'Value & legends', secName: 'Berkshire Hathaway Inc', cik: '1067983' },
  { slug: 'scion',             label: 'Scion Asset Management', manager: 'Michael Burry', category: 'Value & legends', secName: 'Scion Asset Management, LLC', cik: '1649339' },
  { slug: 'pershing-square',   label: 'Pershing Square', manager: 'Bill Ackman', category: 'Value & legends', secName: 'Pershing Square Capital Management, L.P.', cik: '1336528' },
  { slug: 'greenlight',        label: 'Greenlight Capital', manager: 'David Einhorn', category: 'Value & legends', secName: 'Greenlight Capital Inc' },
  { slug: 'baupost',           label: 'Baupost Group', manager: 'Seth Klarman', category: 'Value & legends', secName: 'Baupost Group LLC/MA' },
  { slug: 'third-point',       label: 'Third Point', manager: 'Dan Loeb', category: 'Value & legends', secName: 'Third Point LLC', cik: '1040273' },
  { slug: 'appaloosa',         label: 'Appaloosa', manager: 'David Tepper', category: 'Value & legends', secName: 'Appaloosa LP' },
  { slug: 'icahn',             label: 'Icahn Capital', manager: 'Carl Icahn', category: 'Value & legends', secName: 'Icahn Carl C', cik: '921669' },
  { slug: 'duquesne',          label: 'Duquesne Family Office', manager: 'Stanley Druckenmiller', category: 'Value & legends', secName: 'Duquesne Family Office LLC' },
  { slug: 'fairholme',         label: 'Fairholme Capital', manager: 'Bruce Berkowitz', category: 'Value & legends', secName: 'Fairholme Capital Management LLC' },
  { slug: 'gotham',            label: 'Gotham Asset Management', manager: 'Joel Greenblatt', category: 'Value & legends', secName: 'Gotham Asset Management, LLC' },
  { slug: 'himalaya',          label: 'Himalaya Capital', manager: 'Li Lu', category: 'Value & legends', secName: 'Himalaya Capital Management LLC' },
  { slug: 'akre',              label: 'Akre Capital', manager: 'Chuck Akre', category: 'Value & legends', secName: 'Akre Capital Management LLC' },
  { slug: 'pabrai',            label: 'Pabrai Investment Funds', manager: 'Mohnish Pabrai', category: 'Value & legends', secName: 'Dalal Street, LLC' },
  { slug: 'ruane-cunniff',     label: 'Ruane Cunniff (Sequoia)', manager: 'Ruane Cunniff', category: 'Value & legends', secName: 'Ruane Cunniff & Goldfarb L.P.' },

  // ── Quant & multi-strat ──
  { slug: 'bridgewater',       label: 'Bridgewater Associates', manager: 'Ray Dalio', category: 'Quant & multi-strat', secName: 'Bridgewater Associates, LP', cik: '1350694' },
  { slug: 'renaissance',       label: 'Renaissance Technologies', manager: 'Jim Simons', category: 'Quant & multi-strat', secName: 'Renaissance Technologies LLC', cik: '1037389' },
  { slug: 'citadel',           label: 'Citadel Advisors', manager: 'Ken Griffin', category: 'Quant & multi-strat', secName: 'Citadel Advisors LLC', cik: '1423053' },
  { slug: 'millennium',        label: 'Millennium Management', manager: 'Izzy Englander', category: 'Quant & multi-strat', secName: 'Millennium Management LLC' },
  { slug: 'two-sigma',         label: 'Two Sigma Investments', manager: 'Siegel / Overdeck', category: 'Quant & multi-strat', secName: 'Two Sigma Investments, LP' },
  { slug: 'aqr',               label: 'AQR Capital', manager: 'Cliff Asness', category: 'Quant & multi-strat', secName: 'AQR Capital Management LLC' },
  { slug: 'point72',           label: 'Point72', manager: 'Steve Cohen', category: 'Quant & multi-strat', secName: 'Point72 Asset Management, L.P.' },
  { slug: 'de-shaw',           label: 'D.E. Shaw', manager: 'David Shaw', category: 'Quant & multi-strat', secName: 'D. E. Shaw & Co, Inc.' },
  { slug: 'balyasny',          label: 'Balyasny', manager: 'Dmitry Balyasny', category: 'Quant & multi-strat', secName: 'Balyasny Asset Management LLC' },
  { slug: 'marshall-wace',     label: 'Marshall Wace', manager: 'Paul Marshall', category: 'Quant & multi-strat', secName: 'Marshall Wace LLP' },

  // ── Tiger cubs & growth ──
  { slug: 'tiger-global',      label: 'Tiger Global', manager: 'Chase Coleman', category: 'Tiger cubs & growth', secName: 'Tiger Global Management LLC', cik: '1167483' },
  { slug: 'coatue',            label: 'Coatue', manager: 'Philippe Laffont', category: 'Tiger cubs & growth', secName: 'Coatue Management LLC' },
  { slug: 'lone-pine',         label: 'Lone Pine Capital', manager: 'Steve Mandel', category: 'Tiger cubs & growth', secName: 'Lone Pine Capital LLC' },
  { slug: 'viking-global',     label: 'Viking Global', manager: 'Andreas Halvorsen', category: 'Tiger cubs & growth', secName: 'Viking Global Investors LP' },
  { slug: 'maverick',          label: 'Maverick Capital', manager: 'Lee Ainslie', category: 'Tiger cubs & growth', secName: 'Maverick Capital, LTD' },
  { slug: 'whale-rock',        label: 'Whale Rock Capital', manager: 'Alex Sacerdote', category: 'Tiger cubs & growth', secName: 'Whale Rock Capital Management LLC' },
  { slug: 'altimeter',         label: 'Altimeter Capital', manager: 'Brad Gerstner', category: 'Tiger cubs & growth', secName: 'Altimeter Capital Management, LP' },
  { slug: 'light-street',      label: 'Light Street Capital', manager: 'Glen Kacher', category: 'Tiger cubs & growth', secName: 'Light Street Capital Management, LLC' },
  { slug: 'hound-partners',    label: 'Hound Partners', manager: 'Jonathan Auerbach', category: 'Tiger cubs & growth', secName: 'Hound Partners, LLC' },

  // ── Activist & event-driven ──
  { slug: 'elliott',           label: 'Elliott Investment Mgmt', manager: 'Paul Singer', category: 'Activist & event-driven', secName: 'Elliott Investment Management L.P.' },
  { slug: 'starboard',         label: 'Starboard Value', manager: 'Jeff Smith', category: 'Activist & event-driven', secName: 'Starboard Value LP' },
  { slug: 'trian',             label: 'Trian Fund Management', manager: 'Nelson Peltz', category: 'Activist & event-driven', secName: 'Trian Fund Management, L.P.' },
  { slug: 'valueact',          label: 'ValueAct Capital', manager: 'Mason Morfit', category: 'Activist & event-driven', secName: 'ValueAct Holdings, L.P.' },
  { slug: 'corvex',            label: 'Corvex Management', manager: 'Keith Meister', category: 'Activist & event-driven', secName: 'Corvex Management LP' },
  { slug: 'sachem-head',       label: 'Sachem Head', manager: 'Scott Ferguson', category: 'Activist & event-driven', secName: 'Sachem Head Capital Management LP' },
  { slug: 'tci',               label: 'TCI Fund Management', manager: 'Chris Hohn', category: 'Activist & event-driven', secName: 'TCI Fund Management Ltd' },
  { slug: 'glenview',          label: 'Glenview Capital', manager: 'Larry Robbins', category: 'Activist & event-driven', secName: 'Glenview Capital Management, LLC' },

  // ── Macro & other ──
  { slug: 'soros',             label: 'Soros Fund Management', manager: 'George Soros', category: 'Macro & other', secName: 'Soros Fund Management LLC', cik: '1029160' },
  { slug: 'oaktree',           label: 'Oaktree Capital', manager: 'Howard Marks', category: 'Macro & other', secName: 'Oaktree Capital Management LP' },
  { slug: 'egerton',           label: 'Egerton Capital', manager: 'John Armitage', category: 'Macro & other', secName: 'Egerton Capital (UK) LLP' },
  { slug: 'pentwater',         label: 'Pentwater Capital', manager: 'Matthew Halbower', category: 'Macro & other', secName: 'Pentwater Capital Management LP' },
  { slug: 'ark',               label: 'ARK Invest', manager: 'Cathie Wood', category: 'Macro & other', secName: 'ARK Investment Management LLC', cik: '1697748' },

  // ── Asset managers (giant index/active shops) ──
  { slug: 'blackrock',         label: 'BlackRock', manager: 'BlackRock', category: 'Asset managers', secName: 'BlackRock Inc.', cik: '1364742' },
  { slug: 'vanguard',          label: 'Vanguard', manager: 'Vanguard', category: 'Asset managers', secName: 'Vanguard Group Inc', cik: '102909' },
  { slug: 'state-street',      label: 'State Street', manager: 'State Street', category: 'Asset managers', secName: 'State Street Corp', cik: '93751' },
  { slug: 'fidelity',          label: 'Fidelity (FMR)', manager: 'FMR LLC', category: 'Asset managers', secName: 'FMR LLC', cik: '315066' },
  { slug: 'capital-world',     label: 'Capital Group', manager: 'Capital World Investors', category: 'Asset managers', secName: 'Capital World Investors' },
  { slug: 't-rowe-price',      label: 'T. Rowe Price', manager: 'T. Rowe Price', category: 'Asset managers', secName: 'Price T Rowe Group Inc', cik: '1113169' },
  { slug: 'jpmorgan-am',       label: 'JPMorgan AM', manager: 'JPMorgan', category: 'Asset managers', secName: 'JPMorgan Chase & Co', cik: '19617' },
  { slug: 'goldman-am',        label: 'Goldman Sachs AM', manager: 'Goldman Sachs', category: 'Asset managers', secName: 'Goldman Sachs Group Inc', cik: '886982' },
  { slug: 'morgan-stanley',    label: 'Morgan Stanley (MSIM)', manager: 'Morgan Stanley', category: 'Asset managers', secName: 'Morgan Stanley', cik: '895421' },
  { slug: 'geode',             label: 'Geode Capital', manager: 'Geode', category: 'Asset managers', secName: 'Geode Capital Management, LLC' },
];

export const INSTITUTION_BY_SLUG = Object.fromEntries(INSTITUTIONS.map((f) => [f.slug, f]));
