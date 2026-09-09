// Catalyst Pit curated theme taxonomy for the screener's Theme/Sub-Theme/Tags filters. Maintained in
// code (a differentiator — no vendor gives clean thematic buckets). Membership filter: ticker IN list.
// Refresh periodically. Sub-themes are finer cuts; tags reuse the same taxonomy for keyword-style picks.

export const THEMES = {
  'Artificial Intelligence': ['NVDA', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMD', 'AVGO', 'PLTR', 'SMCI', 'ARM', 'MU', 'TSM', 'DELL', 'ANET', 'SNOW', 'AI', 'PATH', 'BBAI', 'SOUN', 'CRWV', 'TEM', 'AMZN', 'ORCL'],
  'Semiconductors': ['NVDA', 'AMD', 'AVGO', 'TSM', 'INTC', 'MU', 'QCOM', 'TXN', 'ASML', 'AMAT', 'LRCX', 'KLAC', 'ARM', 'MRVL', 'ON', 'MCHP', 'ADI', 'NXPI', 'SWKS', 'MPWR', 'TER', 'ENTG', 'WOLF'],
  'Electric Vehicles': ['TSLA', 'RIVN', 'LCID', 'NIO', 'LI', 'XPEV', 'GM', 'F', 'BYDDY', 'CHPT', 'QS', 'ARBK'],
  'Nuclear & Uranium': ['CCJ', 'UEC', 'UUUU', 'DNN', 'NXE', 'SMR', 'OKLO', 'LEU', 'BWXT', 'VST', 'CEG', 'NNE'],
  'Quantum Computing': ['IONQ', 'RGTI', 'QBTS', 'QUBT', 'ARQQ', 'LAES'],
  'Crypto & Blockchain': ['COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'HOOD', 'BTBT', 'CIFR', 'WULF', 'CORZ'],
  'Cybersecurity': ['CRWD', 'PANW', 'ZS', 'FTNT', 'S', 'NET', 'OKTA', 'CYBR', 'TENB', 'RBRK', 'QLYS', 'VRNS'],
  'Cloud & SaaS': ['CRM', 'NOW', 'SNOW', 'DDOG', 'NET', 'MDB', 'TEAM', 'WDAY', 'HUBS', 'ZM', 'DBX', 'GTLB', 'PATH'],
  'Biotech & Pharma': ['MRNA', 'BNTX', 'VRTX', 'REGN', 'GILD', 'BIIB', 'AMGN', 'CRSP', 'NTLA', 'BEAM', 'LLY', 'ABBV', 'PFE', 'MRK'],
  'Solar & Renewables': ['FSLR', 'ENPH', 'SEDG', 'RUN', 'NEE', 'ARRY', 'SHLS', 'NOVA'],
  'Space': ['RKLB', 'LUNR', 'ASTS', 'RDW', 'PL', 'SPCE', 'RClB'],
  'Defense': ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'LHX', 'HII', 'PLTR', 'KTOS', 'AVAV', 'LDOS'],
  'Gold & Miners': ['NEM', 'GOLD', 'AEM', 'KGC', 'AU', 'WPM', 'FNV', 'HL', 'AG', 'PAAS'],
  'Cannabis': ['TLRY', 'CGC', 'ACB', 'CRON', 'SNDL', 'GTBIF'],
  'Fintech': ['XYZ', 'PYPL', 'HOOD', 'SOFI', 'AFRM', 'COIN', 'NU', 'UPST', 'DAVE', 'BILL'],
  'Data Center': ['NVDA', 'VRT', 'SMCI', 'DLR', 'EQIX', 'ANET', 'AVGO', 'CRWV', 'NBIS'],
  'Robotics & Automation': ['ISRG', 'ROK', 'ABB', 'TER', 'PATH', 'SYM', 'ZBRA'],
  'Meme': ['GME', 'AMC', 'BBBYQ', 'KOSS', 'BB'],
  'Consumer / Retail': ['AMZN', 'WMT', 'COST', 'HD', 'TGT', 'LOW', 'NKE', 'SBUX', 'MCD', 'LULU'],
  'Big Tech': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'],
};

// Sub-themes: finer buckets. Tags: same taxonomy, used as quick keyword picks.
export const SUBTHEMES = {
  'AI Infrastructure': ['NVDA', 'AVGO', 'SMCI', 'ARM', 'MU', 'ANET', 'VRT', 'DELL', 'CRWV', 'NBIS'],
  'AI Software': ['MSFT', 'GOOGL', 'META', 'PLTR', 'AI', 'PATH', 'SNOW', 'CRM', 'NOW'],
  'GPU / Accelerators': ['NVDA', 'AMD', 'AVGO', 'ARM'],
  'Memory': ['MU', 'WDC', 'STX'],
  'Bitcoin Miners': ['MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'WULF', 'CIFR', 'BTBT', 'CORZ'],
  'Bitcoin Treasury': ['MSTR', 'COIN', 'HOOD'],
  'SMR / Advanced Nuclear': ['SMR', 'OKLO', 'NNE', 'LEU', 'BWXT'],
  'Weight Loss / GLP-1': ['LLY', 'NVO', 'VKTX', 'AMGN'],
  'Gene Editing': ['CRSP', 'NTLA', 'BEAM', 'VERV'],
};

export const THEME_MAP = { themes: THEMES, subthemes: SUBTHEMES, tags: THEMES };
