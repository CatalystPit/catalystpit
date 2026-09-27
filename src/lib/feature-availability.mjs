/**
 * Which product surfaces are currently available to users.
 *
 * This is the single place a data-dependent module gets switched off, so that turning one back on is
 * a one-line change here rather than a hunt through the UI for conditionals. It follows the
 * `FUTURES_ENABLED` / `OPTIONS_SENTIMENT_ENABLED` precedent elsewhere in src/lib — the difference is
 * only that these live together, because we now have several of them and they are all the same kind
 * of decision: the implementation is finished and kept, but we are not showing it yet.
 *
 * NOTHING IS DELETED WHEN A FLAG GOES FALSE. The components, routes, parsers, types and tests all
 * stay exactly where they are; the flag governs rendering and routing only. That is deliberate — a
 * flag flip has to be reversible without archaeology.
 *
 * TO RESTORE A FEATURE: flip its flag to true and run the ticker-page suites. Read the note above
 * the flag first — each one records what has to be TRUE about the data before the flag should move,
 * and a flag flipped before that condition holds just puts the empty page back.
 */
export const FEATURES = {
  // Company-issued forward guidance (revenue/EPS forecasts and revisions). The tab and its
  // placeholder exist; what does not exist yet is a guidance feed to fill them, so today the tab
  // leads to an empty panel. RESTORE WHEN: a guidance provider is wired and backfilled.
  // Note: this flag governs the ticker GUIDANCE TAB only. The `guidance` event type in the news and
  // evidence pipelines (x-relevance, headline-compose, event-cluster, impact) is a different thing
  // entirely — it classifies headlines, is fully working, and must not be gated on this.
  guidance: false,

  // Wall Street analyst ratings, price targets, upgrades/downgrades and consensus. Same situation
  // as guidance: tab and placeholder copy exist, the ratings feed does not.
  // RESTORE WHEN: a ratings provider is licensed and ingested.
  analystRatings: false,

  // The "Tools & offers" affiliate strip on the ticker Overview. The component is env-driven and
  // already renders nothing when no partner IDs are set, so this flag is about not showing the
  // section at all rather than about configuration. RESTORE WHEN: affiliate partnerships are live
  // and we want the placement back. Note this does NOT touch the affiliate disclosure on
  // /disclaimer — that is a standing legal statement about the business, not about this strip.
  toolsAndOffers: false,
};

/** True when `name` is a known feature that is currently on. An unknown name is off, not on. */
export function featureEnabled(name) {
  return FEATURES[name] === true;
}

/**
 * Ticker-page tab id → the feature that governs it. A tab absent from this map is always available;
 * only gated tabs appear here.
 */
export const TICKER_TAB_FEATURES = {
  guidance: 'guidance',
  analyst: 'analystRatings',
};

/** True when this ticker tab should be shown and routable. Unknown ids are left to the caller. */
export function tickerTabEnabled(tabId) {
  const feature = TICKER_TAB_FEATURES[tabId];
  return feature ? featureEnabled(feature) : true;
}
