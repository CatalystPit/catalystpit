import { INDEXABLE_ROUTES, canonical } from '../lib/seo';

// Next serves this at /sitemap.xml. There was no sitemap before, so nothing told a crawler which
// URLs exist — which matters most for the rooms that are not in the top nav.
//
// NO lastModified FIELD, DELIBERATELY. The brief said not to fabricate freshness, and that is
// exactly what `new Date()` here would be: a timestamp that changes on every build and claims every
// legal page was edited this morning. Google treats an obviously synthetic lastmod as noise and
// discounts it. Real per-route modification times need a source we do not have yet — a content
// timestamp for the legal pages, and a latest-event timestamp for the data rooms. When Phase 3
// server-renders those rooms, the event time becomes a genuine lastmod and can be added then.
//
// The route list itself lives in lib/seo.js next to the canonical helper, so the sitemap and the
// canonical tags cannot disagree about which URLs are indexable.
export default function sitemap() {
  return INDEXABLE_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: canonical(path),
    changeFrequency,
    priority,
  }));
}
