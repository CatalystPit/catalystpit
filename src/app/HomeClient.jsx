'use client'

import CatalystPit from '../components/CatalystPit'

// ⚠️ THIS FILE USED TO BE `dynamic(() => import('../components/CatalystPit'), { ssr: false })`,
// AND THAT ONE OPTION EMPTIED THE MOST IMPORTANT PAGE ON THE SITE.
//
// Measured on production before the change, fetching https://www.catalystpit.com/ as Googlebot:
//
//   html            30,446 bytes
//   <body>          18,729 bytes
//   body minus <script>   248 bytes   ← the entire server-rendered page
//   h1 count        0
//   server text     0 words
//
// Those 248 bytes were `<template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING">` twice over.
// `ssr: false` tells Next not to render the component on the server at all, so the homepage —
// priority 1.0 in our own sitemap, the target of every inbound link and every brand search —
// shipped no heading, no nav, no footer, no prose and NO INTERNAL LINKS. Googlebot renders
// JavaScript and recovers most of it eventually; the crawlers that increasingly decide whether a
// finance site gets quoted do not. GPTBot, OAI-SearchBot, PerplexityBot, ClaudeBot and Applebot
// were each measured fetching this URL successfully and receiving nothing to read.
//
// Nothing in CatalystPit.jsx needs a browser at render time — no window, no document, no
// localStorage outside effects, which is why this was removable rather than load-bearing. It was
// the only `ssr: false` in the application. The data still arrives client-side exactly as before
// (fetchAll runs in an effect), so what the server now emits is the shell: the h1, the nav, the
// section headings, the footer and the links. That is the difference between a page a crawler can
// read and a page it has to execute.
// ⚠️ AND THE SHELL WAS ONLY HALF THE FIX — 192 WORDS OF IT.
//
// Removing `ssr: false` got the heading, the nav, the footer and seventeen internal links into the
// HTML. It did not get the RESEARCH in: every card, row, symbol, value and date still arrived in an
// effect, so the most important page on the site server-rendered a frame around an empty room.
// Measured on production at 1f9ff3fa, fetching / as Googlebot: 192 words of body text, and not one
// ticker symbol among them.
//
// app/page.jsx now reads the cached pit_snapshot and the published consensus board on the server,
// runs the SAME buildHomeModel the browser runs, and passes the result straight through here. These
// props are the whole mechanism; this file stays a two-line boundary because a 'use client' file
// cannot export metadata and a server component cannot use hooks.
export default function HomeClient({ initialData = null, initialConsensus = null }) {
  return <CatalystPit initialData={initialData} initialConsensus={initialConsensus} />
}
