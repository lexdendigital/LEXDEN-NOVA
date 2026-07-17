export const config = {
  runtime: 'edge', // Runs on Vercel's global edge network
};

const GEMINI_MODEL = "gemini-2.5-flash";

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function buildSystemPrompt(context) {
  const products = (context.products || [])
    .map(p => {
      const price = p.free ? "Free" : `$${p.priceUSD}${p.salePriceUSD ? ` (sale $${p.salePriceUSD})` : ""}`;
      const specs = Object.entries(p.specs || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      return `- ${p.name} [${p.category}] — ${price}, rating ${p.rating}/5. ${specs ? "Specs: " + specs + ". " : ""}${p.description || ""}`;
    })
    .join("\n");

  const faqs = (context.faqs || []).map(f => `Q: ${f.q}\nA: ${f.a}`).join("\n");
  const appName = context.content?.appName || "LEXDEN NOVA";
  const currency = context.currency || "USD";

  return `You are NOVA, the friendly in-app shopping assistant for ${appName}, a digital products and gadgets marketplace.
Speak naturally and concisely — this is a mobile chat widget, not an essay. Ground every answer in the catalog and FAQ data
below; never invent products, prices, or policies that aren't listed. Prices shown to you are in USD; the shopper's selected
display currency is ${currency}, so mention amounts in a natural way rather than doing currency math yourself unless asked.
If a shopper asks something the catalog/FAQs can't answer, say so honestly and suggest contacting support instead of guessing.
Format your reply as clean HTML using only <p>, <strong>, <em>, <ul>, <li>, and <br> tags — no markdown, no code fences.

CATALOG:
${products || "(no published products yet)"}

FAQs:
${faqs || "(no FAQs yet)"}`;
}

export default async function handler(request) {
  const origin = request.headers.get("Origin") || "";

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ text: "Bad request." }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const { message, context } = body || {};
  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ text: "No message provided." }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // Vercel reads Environment Variables from process.env
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ text: "Server is missing its API key — please configure GEMINI_API_KEY in Vercel settings." }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: message.slice(0, 2000) }]
            }
          ],
          systemInstruction: {
            parts: [{ text: buildSystemPrompt(context || {}) }]
          },
          generationConfig: {
            maxOutputTokens: 600
          }
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return new Response(JSON.stringify({ text: "I couldn't reach my full brain just now — please try again shortly." }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const data = await geminiRes.json();
    const html = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

    return new Response(JSON.stringify({ html }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  } catch (err) {
    console.error("Handler error:", err);
    return new Response(JSON.stringify({ text: "Something went wrong reaching Gemini. Try again in a moment." }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
                                                       }
          const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return new Response(JSON.stringify({ text: "I couldn't reach my full brain just now — please try again shortly." }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const data = await geminiRes.json();
    const html = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

    return new Response(JSON.stringify({ html }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  } catch (err) {
    console.error("Handler error:", err);
    return new Response(JSON.stringify({ text: "Something went wrong reaching Gemini. Try again in a moment." }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
                                                       }
    
