// src/lib/congress-ocr.mjs
//
// OCR fallback for SCANNED House PTR PDFs (DocID 8xxx/9xxx = image scans, often handwritten)
// that the text extractor (unpdf) can't read. Sends the PDF straight to the Anthropic Messages
// API as a document block and asks Claude to TRANSCRIBE the transaction table into the same
// shape parsePtrTransactions() emits, so houseRec()/buildRow() consume it unchanged.
//
// Accuracy discipline ("no guessing"): the prompt forbids inferring/estimating — any illegible
// field is null. The caller additionally reconciles numeric counts against the disclosed dollar
// bracket and drops anything that doesn't add up. Pure fetch; no DB, no SDK.

import { validateBracket } from './congress-ingest.mjs';

const TXTYPE = { P: 'Purchase', S: 'Sale', E: 'Exchange' };
const OWNER = { SP: 'Spouse', JT: 'Joint', DC: 'Dependent Child' };
const toISO = (mdy) => { const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };

const PROMPT = `You are transcribing a U.S. House Periodic Transaction Report (PTR). Read the transaction table and output ONLY a JSON object of the form {"transactions":[ ... ]} with no prose and no markdown.

For EVERY transaction row, output an object with these fields:
- owner: one of "SP" (spouse), "JT" (joint), "DC" (dependent child), or "" (the filer). Use "" if not marked.
- ticker: the stock ticker symbol shown in parentheses (e.g. "AAPL"), or null if none is printed.
- asset: the asset/company name text as written.
- assetType: "ST" for stock/common shares, "OP" for an option (calls/puts), "MF" mutual fund, "ETF", "CB" corporate bond, or "OT" other. Choose by what is written.
- txType: "P" purchase, "S" sale (partial sales still "S"), "E" exchange.
- date: the transaction date as "MM/DD/YYYY".
- amount: the amount RANGE exactly as printed, e.g. "$1,001 - $15,000". Use the standard bracket text; do not invent a number.
- description: the filer's free-text comment/description for this row, transcribed VERBATIM, or null if there is none.
- shares: integer share count ONLY if a specific number of shares is explicitly written, else null.
- contracts: integer option-contract count ONLY if explicitly written, else null.
- strike: option strike price number ONLY if explicitly written, else null.
- expiration: option expiration date "MM/DD/YYYY" ONLY if explicitly written, else null.

ACCURACY RULES, follow exactly:
- Transcribe ONLY what is clearly legible. If any field is uncertain or illegible, use null. NEVER guess, infer, approximate, or compute a value.
- Do not derive shares from the dollar amount. Only report shares/contracts if the filer literally wrote that number.
- If the page is blank or entirely illegible, return {"transactions":[]}.`;

// One scanned PTR PDF -> { transactions } in parsePtrTransactions shape (or {transactions:[],error}).
export async function ocrPtrTransactions(pdfBuffer, apiKey, { model = 'claude-opus-4-8' } = {}) {
  if (!apiKey) return { transactions: [], error: 'no ANTHROPIC_API_KEY' };
  const data = Buffer.from(pdfBuffer).toString('base64');
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 8000,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });
  } catch (e) { return { transactions: [], error: `fetch:${e.message}` }; }
  if (!res.ok) return { transactions: [], error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };

  const body = await res.json();
  const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const jsonStr = (text.match(/\{[\s\S]*\}/) || [null])[0];
  if (!jsonStr) return { transactions: [], error: 'no JSON in response' };
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch (e) { return { transactions: [], error: `parse:${e.message}` }; }
  const raw = Array.isArray(parsed?.transactions) ? parsed.transactions : [];

  const transactions = [];
  for (const t of raw) {
    const amount = String(t.amount || '').replace(/\s+/g, ' ').trim();
    if (!validateBracket(amount)) continue;                 // must be a real disclosure bracket
    const date = toISO(t.date);
    if (!date) continue;
    const ticker = (t.ticker && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(t.ticker)) ? t.ticker.toUpperCase() : null;
    const owner = OWNER[t.owner] || 'Self';
    const base = String(t.txType || '').trim().charAt(0).toUpperCase();
    const asset = String(t.asset || '').trim();
    // Rebuild a verbatim description; keep the explicit counts the filer wrote (validated by caller).
    let description = t.description ? String(t.description).replace(/\s+/g, ' ').trim() : '';
    transactions.push({
      owner, ticker,
      assetDescription: asset ? `${asset}${ticker ? ` (${ticker})` : ''}` : (ticker || null),
      assetType: t.assetType || null,
      type: TXTYPE[base] || null,
      transactionDate: date,
      notificationDate: null,
      amount,
      description,
      // structured hints the caller reconciles before trusting:
      _shares: Number.isFinite(+t.shares) && +t.shares > 0 ? Math.round(+t.shares) : null,
      _contracts: Number.isFinite(+t.contracts) && +t.contracts > 0 ? Math.round(+t.contracts) : null,
    });
  }
  return { transactions, model, usage: body?.usage || null };
}
