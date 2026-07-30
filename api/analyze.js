// Runs on the server (Vercel). Your Groq key and Places key stay hidden here, never sent to the browser.

async function fetchPageText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      }
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 5000);
  } catch (e) {
    return null;
  }
}

async function fetchPlacesCompetitors(query, placesKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${placesKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) return null;

    return data.results.slice(0, 8).map(r => ({
      name: r.name,
      address: r.formatted_address || '',
      rating: r.rating || null,
      reviewCount: r.user_ratings_total || null,
      priceLevel: typeof r.price_level === 'number' ? r.price_level : null,
      lat: r.geometry?.location?.lat ?? null,
      lng: r.geometry?.location?.lng ?? null,
      mapsUrl: r.place_id ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}` : null
    }));
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    businessName, category, description, location, competitorsKnown,
    reviewsText, reviewsUrl, competitorUrls
  } = req.body || {};

  if (!businessName || !description || !location) {
    return res.status(400).json({ error: 'Please provide a business/product name, description, and target location.' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing GROQ_API_KEY. Add it in Vercel → Project → Settings → Environment Variables.'
    });
  }

  // ---- 1. Real competitors via Google Places (if key configured) ----
  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  let realCompetitors = null;
  if (placesKey) {
    const query = `${category || businessName} in ${location}`;
    realCompetitors = await fetchPlacesCompetitors(query, placesKey);
  }

  // ---- 2. Ground sentiment in real reviews if provided ----
  let reviewSource = null;
  let reviewContent = null;
  if (reviewsText && reviewsText.trim().length > 20) {
    reviewSource = 'pasted_text';
    reviewContent = reviewsText.trim().slice(0, 6000);
  } else if (reviewsUrl && reviewsUrl.trim().length > 5) {
    const fetched = await fetchPageText(reviewsUrl.trim());
    if (fetched && fetched.length > 100) {
      reviewSource = 'url';
      reviewContent = fetched;
    }
  }
  const reviewBlock = reviewContent
    ? `\nREAL CUSTOMER REVIEW CONTENT (ground sentiment in this — extract genuine praise/complaints, do not invent):\n"""\n${reviewContent}\n"""\n`
    : `\nNo real review content was provided. Estimate sentiment based on typical patterns for this category, and mark it as an estimate.\n`;

  // ---- 3. Real pricing from pasted competitor URLs (up to 4) ----
  let pricingBlock = '';
  let pricingUrlList = [];
  if (competitorUrls && competitorUrls.trim().length > 5) {
    pricingUrlList = competitorUrls
      .split(/[\n,]/)
      .map(u => u.trim())
      .filter(u => u.length > 5)
      .slice(0, 4);

    const fetchedPages = await Promise.all(pricingUrlList.map(async (u) => {
      const text = await fetchPageText(u);
      return { url: u, text };
    }));

    const validPages = fetchedPages.filter(p => p.text && p.text.length > 100);
    const failedUrls = fetchedPages.filter(p => !p.text || p.text.length <= 100).map(p => p.url);

    if (validPages.length > 0) {
      pricingBlock = `\nREAL COMPETITOR PAGE CONTENT (use ONLY this text to extract real prices/positioning — do not guess if not present in the text):\n` +
        validPages.map((p, i) => `PAGE ${i + 1} (${p.url}):\n"""\n${p.text}\n"""`).join('\n\n');
    }
    if (failedUrls.length > 0) {
      pricingBlock += `\n\nThese URLs could not be read (site blocked automated access) — mark them "unavailable" in pricingComparison, do not invent data for them: ${failedUrls.join(', ')}`;
    }
  }

  // ---- 4. Real competitor list block for the prompt, if we have one ----
  const competitorsBlock = realCompetitors
    ? `\nREAL NEARBY COMPETITORS (from Google Places — use these EXACT names, do not invent different ones. Just add an "estMarketShare" number and short "tag" for each based on their rating/review count):\n${JSON.stringify(realCompetitors, null, 2)}\n`
    : `\nNo real competitor data available — estimate realistic archetype competitors for this category and location (e.g. "Leading National Chain", "Regional Specialist Brand"), not invented specific brand names that sound like real companies.\n`;

  const prompt = `
You are a market intelligence analyst producing a dashboard report for a small business owner.

BUSINESS/PRODUCT: ${businessName}
CATEGORY: ${category || 'Not specified'}
DESCRIPTION: ${description}
TARGET MARKET / LOCATION: ${location}
KNOWN COMPETITORS (if any, may be empty): ${competitorsKnown || 'None provided'}
${reviewBlock}
${competitorsBlock}
${pricingBlock}

Return ONLY a single valid JSON object with this EXACT shape (no markdown fences, no commentary):

{
  "summary": {
    "opportunityScore": 8.3,
    "opportunityLabel": "short label e.g. High Potential",
    "competitionLevel": "Low, Medium, or High",
    "competitionScore": 4.7,
    "competitionLabel": "short label e.g. Moderate Competition",
    "searchDemandLabel": "Low, Medium, or High",
    "monthlySearches": "estimated searches like 12.4K",
    "growthLabel": "Low, Medium, or High",
    "growthPercent": "estimated YoY growth like 18%"
  },
  "competitors": {
    "source": "${realCompetitors ? 'google_places' : 'ai_estimate'}",
    "items": [
      ${realCompetitors
        ? `{ "name": "EXACT name from the real list above", "estMarketShare": 28, "tag": "Market Leader or empty string" }`
        : `{ "name": "realistic archetype competitor name", "estMarketShare": 28, "tag": "Market Leader or empty string" }`
      }
    ]
  },
  "sentiment": {
    "source": "${reviewSource ? 'real_reviews' : 'ai_estimate'}",
    "positive": 65,
    "neutral": 20,
    "negative": 15,
    "topPraise": ["point 1", "point 2", "point 3", "point 4"],
    "topComplaints": ["point 1", "point 2", "point 3", "point 4"]
  },
  "channels": [
    { "name": "channel name", "effectiveness": "Low, Medium, or High", "cost": "Low, Medium, or High", "competition": "Low, Medium, or High" }
  ],
  "adAngles": [
    { "headline": "short ad headline", "body": "1-2 sentence ad copy", "angleType": "e.g. Price angle, Trust angle, Urgency angle, Social proof angle" }
  ],
  "contentThemes": [
    { "theme": "theme name", "percent": 40 }
  ],
  "keywordOpportunities": [
    { "keyword": "realistic search keyword for this business", "searchVolume": "e.g. 4.4K (estimate)", "difficulty": 24 }
  ],
  "marketGap": {
    "title": "short punchy name for the gap",
    "description": "1-2 sentences describing the underserved segment",
    "opportunityScore": 9.2,
    "recommendation": "1-2 sentence positioning recommendation"
  },
  "growthPlan": {
    "phases": [
      { "title": "Phase 1: Foundation (Days 1-30)", "tasks": ["task 1", "task 2", "task 3", "task 4"] },
      { "title": "Phase 2: Growth (Days 31-60)", "tasks": ["task 1", "task 2", "task 3", "task 4"] },
      { "title": "Phase 3: Scale (Days 61-90)", "tasks": ["task 1", "task 2", "task 3", "task 4"] }
    ],
    "expectedOutcomes": ["e.g. 20-30% Increase in Leads", "e.g. 15-25% Lower CAC", "e.g. 10-15% Revenue Growth"]
  }${pricingUrlList.length > 0 ? `,
  "pricingComparison": [
    { "url": "the exact url", "name": "site/business name if identifiable, else the domain", "source": "real_page or unavailable", "price": "price found in the text, or null", "positioning": "1 sentence on how they position themselves, based only on the real text", "note": "short note, e.g. 'page blocked automated access' if unavailable" }
  ]` : ''}
}

Rules:
- ${realCompetitors ? 'Use the exact real competitor names given, in the same order, just add estMarketShare and tag.' : 'Provide 6-8 realistic archetype competitors.'}
- 6 channels covering a realistic mix (search, social, marketplace, local/offline as relevant to the category).
- Exactly 4 adAngles, each a distinct angle.
- 5-6 contentThemes that sum to roughly 100.
- 5 keywordOpportunities relevant to this exact business (label as estimates, since real search volume requires a paid tool).
- ${pricingUrlList.length > 0 ? 'Include pricingComparison with one entry per URL provided, strictly grounded in the real page text given — never invent a price that is not in the text.' : 'Omit pricingComparison entirely if no competitor URLs were given.'}
- Every section must be specific to THIS business/category/location — no generic filler.
- Return raw JSON only, no markdown fences.
`.trim();

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a market intelligence AI. You always respond with ONLY a single valid JSON object matching the schema given. Never include markdown formatting, code fences, or text outside the JSON object. Ground sentiment and pricing strictly in any real text provided — never invent facts that contradict or go beyond that text.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.6,
        response_format: { type: 'json_object' }
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq API error:', errText);
      return res.status(502).json({ error: 'The AI provider returned an error. Please try again in a moment.' });
    }

    const data = await groqResponse.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) {
      return res.status(502).json({ error: 'The AI did not return a usable response. Please try again.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse AI JSON:', raw);
      return res.status(502).json({ error: 'The AI response was not valid JSON. Please try again.' });
    }

    // Merge real Places coordinates back in (the AI never sees/returns lat/lng — keeps it from inventing them).
    if (realCompetitors && parsed.competitors?.items) {
      parsed.competitors.items = parsed.competitors.items.map(item => {
        const match = realCompetitors.find(r => r.name === item.name);
        return match ? { ...item, ...match } : item;
      });
    }

    parsed._meta = {
      location,
      businessName,
      reviewSource: reviewSource || 'none',
      placesConfigured: !!placesKey,
      generatedAt: new Date().toISOString()
    };

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Something went wrong generating your report. Please try again.' });
  }
}
