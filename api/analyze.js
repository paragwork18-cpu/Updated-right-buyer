// Runs on the server (Vercel). Your Groq key stays hidden here, never sent to the browser.

async function fetchReviewText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      }
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    // Strip scripts/styles, then tags, collapse whitespace — good enough to hand to the AI as raw text.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 6000);
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { businessName, category, description, location, competitorsKnown, reviewsText, reviewsUrl } = req.body || {};

  if (!businessName || !description || !location) {
    return res.status(400).json({ error: 'Please provide a business/product name, description, and target location.' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing GROQ_API_KEY. Add it in Vercel → Project → Settings → Environment Variables.'
    });
  }

  // Ground sentiment in real reviews if provided.
  let reviewSource = null;
  let reviewContent = null;

  if (reviewsText && reviewsText.trim().length > 20) {
    reviewSource = 'pasted_text';
    reviewContent = reviewsText.trim().slice(0, 6000);
  } else if (reviewsUrl && reviewsUrl.trim().length > 5) {
    const fetched = await fetchReviewText(reviewsUrl.trim());
    if (fetched && fetched.length > 100) {
      reviewSource = 'url';
      reviewContent = fetched;
    }
  }

  const reviewBlock = reviewContent
    ? `\nREAL CUSTOMER REVIEW CONTENT (use this to ground sentiment — extract genuine praise/complaints from this text, do not invent):\n"""\n${reviewContent}\n"""\n`
    : `\nNo real review content was provided. Estimate sentiment based on typical patterns for this category, and clearly mark it as an estimate.\n`;

  const prompt = `
You are a market intelligence analyst producing a dashboard report for a small business owner.

BUSINESS/PRODUCT: ${businessName}
CATEGORY: ${category || 'Not specified'}
DESCRIPTION: ${description}
TARGET MARKET / LOCATION: ${location}
KNOWN COMPETITORS (if any, may be empty): ${competitorsKnown || 'None provided'}
${reviewBlock}

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
    "large": [ { "name": "realistic competitor type/name", "marketShare": 32, "tag": "Market Leader or empty string" } ],
    "local": [ { "name": "Local Player 1", "marketShare": 3 } ]
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
    { "keyword": "realistic search keyword for this business", "searchVolume": "e.g. 4.4K", "difficulty": 24 }
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
  }
}

Rules:
- 5 "large" competitors with descending marketShare, 3 "local" competitors with small marketShare. Base these on realistic players/patterns for this category and location if you don't have exact real names — use realistic archetype names (e.g. "Leading National Chain", "Regional Specialist Brand") rather than inventing fake specific brand names that sound like real companies.
- 6 channels covering a realistic mix (search, social, marketplace, local/offline as relevant to the category).
- Exactly 4 adAngles, each a distinct angle.
- 5-6 contentThemes that sum to roughly 100.
- 5 keywordOpportunities relevant to this exact business.
- All numbers should be internally consistent and plausible, not extreme.
- Every section must be specific to THIS business/category/location — no generic filler that could apply to any product.
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
            content: 'You are a market intelligence AI. You always respond with ONLY a single valid JSON object matching the schema given. Never include markdown formatting, code fences, or text outside the JSON object. When real review content is given, ground sentiment analysis in it strictly — do not invent complaints that are not supported by the text.'
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

    // Attach metadata about what was real vs estimated, and the location for the map.
    parsed._meta = {
      location,
      businessName,
      reviewSource: reviewSource || 'none',
      generatedAt: new Date().toISOString()
    };

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Something went wrong generating your report. Please try again.' });
  }
}
