// /api/affiliate/ai.js
//
// The "upgraded Nova assistant" for affiliates — advice on improving
// sales, troubleshooting their account/links, and general Q&A about the
// program. Reuses the EXACT same Gemini key-rotation logic as nova-ai.js
// (via ../gemini-shared) — no duplicate API-key handling to maintain.
//
// POST { message, stats } — stats is the affiliate's OWN dashboard data
// (clicks, sales, earnings, per-link breakdown, recent commissions),
// sent from affiliate/index.html so advice is grounded in their real
// numbers instead of generic tips. No auth token needed here since
// nothing sensitive is written — the client only ever sends its own
// already-visible dashboard numbers, and this endpoint is read-only
// (talks to Gemini, touches no database).

const { getApiKeys, callGeminiWithRotation } = require('../gemini-shared');

function buildAffiliateSystemPrompt(stats) {
  const s = stats || {};
  const linkLines = (s.links || [])
    .map(l => `- ${l.name || l.productId || 'General store link'}: ${l.clicks || 0} clicks, ${l.sales || 0} sales (${l.clicks ? ((l.sales / l.clicks) * 100).toFixed(1) : '0'}% conversion)`)
    .join('\n');

  return `You are the NOVA AFFILIATE ASSISTANT — a specialized version of LEXDEN NOVA's AI, here to help a Nova affiliate
(not a shopper) improve their results, troubleshoot problems with their account or links, and get things done. Be direct,
practical, and specific — reference their actual numbers below rather than giving generic "post more on social media" advice.
When a link is converting far below their others, say so plainly and suggest a concrete reason and fix (wrong audience, no
context in the share caption, product needs a better presentation, etc.). When they ask about withdrawals, remind them
withdrawals are once every 7 days (Sundays don't count toward the wait) with a small processing fee — don't make up other
numbers. When you don't have enough information in their stats to answer something (e.g. WHY a specific click didn't
convert), say so honestly instead of guessing. Keep replies concise — this is a mobile chat widget.
Format your reply as clean HTML using only <p>, <strong>, <em>, <ul>, <li>, and <br> tags — no markdown, no code fences.

THIS AFFILIATE'S CURRENT STATS:
Total clicks: ${s.totalClicks ?? 'unknown'}
Total sales: ${s.totalSales ?? 'unknown'}
Total earned: ₦${s.totalEarned ?? 'unknown'}
Available balance: ₦${s.balanceAvailable ?? 'unknown'}

PER-LINK BREAKDOWN:
${linkLines || '(no link activity yet)'}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ text: 'Method not allowed' });
  }

  const { message, stats } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ text: 'No message provided.' });
  }

  const keys = getApiKeys();
  if (keys.length === 0) {
    return res.status(500).json({ text: 'Server is missing its Gemini API key(s).' });
  }

  try {
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: message.slice(0, 2000) }] }],
      systemInstruction: { parts: [{ text: buildAffiliateSystemPrompt(stats) }] },
      generationConfig: { maxOutputTokens: 500 },
    };
    const result = await callGeminiWithRotation(keys, requestBody);
    if (!result.ok) {
      console.error('Affiliate AI error after key rotation:', result.status, result.error);
      return res.status(200).json({ text: "I couldn't reach my full brain just now — please try again shortly." });
    }
    const html = result.data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";
    return res.status(200).json({ html });
  } catch (err) {
    console.error('Affiliate AI handler error:', err);
    return res.status(200).json({ text: 'Something went wrong. Try again in a moment.' });
  }
};
