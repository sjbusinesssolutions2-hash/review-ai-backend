const { GoogleGenAI } = require('@google/genai');

const rawKeysInput = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const geminiKeys = rawKeysInput
  .split(',')
  .map(k => k.trim())
  .filter(k => k.startsWith('AQ.'));

// Sequential Key & Model Failover Engine for Review Replies (Handles 1-3 Star Escalations & Standard Replies)
async function generate2LineAIReply(businessName, reviewerName, starRating, comment, supportEmail = '', supportPhone = '') {
  if (!geminiKeys || geminiKeys.length === 0) {
    console.error('[Gemini AI] No valid AQ. API keys found in environment variables.');
    return null;
  }

  const cleanComment = (comment && comment.trim() !== '') ? comment.trim() : 'Great service!';
  const cleanName = (reviewerName && reviewerName.trim() !== '') ? reviewerName.trim().split(' ')[0] : 'customer';

  let prompt = '';

  if (starRating <= 3) {
    // Critical Review Prompt (1 to 3 Stars)
    const contactInfo = [
      supportEmail ? `email (${supportEmail})` : '',
      supportPhone ? `phone (${supportPhone})` : ''
    ].filter(Boolean).join(' or ');

    const offlineCTA = contactInfo 
      ? `Invites them to resolve the issue directly offline by reaching out to our support team via ${contactInfo}.`
      : 'Invites them to reach out directly so we can make things right.';

    prompt = `You are replying to a critical ${starRating}-star Google Business review for "${businessName}" as the business owner.

Reviewer: ${cleanName}
Rating: ${starRating} Stars
Review: "${cleanComment}"

Instructions:
1. Match the exact language and script of the customer's comment (English, Roman Hindi, Roman Gujarati, etc.).
2. Write a calm, highly empathetic, and professional reply (1 to 2 sentences max).
3. Sincerely acknowledge their frustration and apologize for the shortfall without being defensive.
4. ${offlineCTA}
5. Do NOT follow a fixed formula or preambles.`;
  } else {
    // Standard 4-5 Star Review Prompt
    prompt = `You are replying to a Google Business review for "${businessName}" as a business owner.

Reviewer: ${cleanName}
Rating: ${starRating} Stars
Review: "${cleanComment}"

Instructions:
1. Match the exact language and script of the customer's comment (English, Roman Hindi, Roman Gujarati, etc.).
2. Write a concise, natural response (1 to 2 sentences max).
3. Do NOT follow a fixed formula or template. Speak like a genuine person writing a unique message on the spot, referencing specific details from their review.
4. Avoid repetitive sign-offs, quotes, or preambles.`;
  }

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          let cleanText = responseText.trim().replace(/^["']|["']$/g, '');
          const sentences = cleanText.match(/[^.!?]+[.!?]+/g);
          
          if (sentences && sentences.length >= 2) {
            return `${sentences[0].trim()} ${sentences[1].trim()}`;
          } else if (sentences && sentences.length === 1) {
            return `${sentences[0].trim()}`;
          }
          return cleanText;
        }
      } catch (err) {
        console.warn(`[Gemini AI] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  console.error('[Gemini AI] All keys and model fallbacks exhausted.');
  return null;
}

// Generator for Auto-Posts
async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    return `At ${locationName || 'our business'}, we take immense pride in delivering top-tier ${category || 'services'}. #${(locationName || 'Business').replace(/\s+/g, '')}`;
  }

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  let festivalContext = "Disabled";
  if (enableFestivals) {
    festivalContext = `ENABLED for today (${currentDate}). If there is a major SECULAR or NATIONAL non-religious day today (like Republic Day, Independence Day, Earth Day, New Year), or a relevant local weather/seasonal vibe (like summer care, monsoon prep, winter comfort), weave it in naturally. Strictly EXCLUDE all religious festivals or symbols.`;
  }

  const prompt = `You are an expert social media manager for a local business named "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
Generate an engaging Google Business Profile post based on these settings:
- Today's Date: ${currentDate}
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Seasonal & Event Context: ${festivalContext}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled (highlight customer satisfaction naturally)' : 'Disabled'}

Requirements:
1. Write 2 to 4 sentences naturally as a business owner.
2. Adapt seamlessly to the current time of year and weather/season if appropriate, without sounding forced.
3. Strictly NON-RELIGIOUS. Never mention religious festivals or rituals.
4. Include 1 clear call-to-action (walk-ins or phone calls only, NO online booking) and 2 relevant hashtags.
5. Avoid repetitive templates or formulas. Make every post feel fresh.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let responseText = '';
        if (typeof response.text === 'string') {
          responseText = response.text;
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
          responseText = response.candidates[0].content.parts.map(p => p.text).join('');
        }

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {}
    }
  }

  return `Visit us today for great service and special offers! #LocalBusiness #CustomerFirst`;
}

// Dynamic SVG Poster Generator
async function generateAiPosterSvg(locationName, category, topics, enableFestivals) {
  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  let headline = topics && topics.trim().length > 3 ? topics.trim() : `Expert ${bCat}`;
  if (headline.length > 50) headline = headline.substring(0, 47) + '...';

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const festivalInstruction = enableFestivals 
    ? `SEASONAL & EVENT ACCENT ACTIVE (Date: ${currentDate}): Complement the graphic with subtle visual accents matching the current weather/season or non-religious national occasion. Strictly NO religious symbols.` 
    : `Standard clean professional spotlight banner.`;

  const palettes = [
    { name: "Vintage Cream & Terracotta", bg: "#faf8f5", card: "#f2eae1", text: "#1c1917", accent: "#ea580c", border: "#e7e5e4" },
    { name: "Saffron & Gold Accent", bg: "#fffbeb", card: "#fef3c7", text: "#451a03", accent: "#d97706", border: "#fde68a" },
    { name: "Deep Forest & Mint", bg: "#f0fdf4", card: "#dcfce7", text: "#052e16", accent: "#16a34a", border: "#bbf7d0" },
    { name: "Midnight Navy & Sky", bg: "#f8fafc", card: "#e2e8f0", text: "#0f172a", accent: "#0284c7", border: "#cbd5e1" },
    { name: "Rich Burgundy & Rose", bg: "#fff1f2", card: "#ffe4e6", text: "#4c0519", accent: "#e11d48", border: "#fecdd3" },
    { name: "Warm Terracotta & Clay", bg: "#fdf8f6", card: "#faedcd", text: "#381d05", accent: "#bc6c25", border: "#e6ccb2" },
    { name: "Emerald Luxe", bg: "#ecfdf5", card: "#a7f3d0", text: "#022c22", accent: "#059669", border: "#6ee7b7" },
    { name: "Royal Indigo", bg: "#eef2ff", card: "#e0e7ff", text: "#1e1b4b", accent: "#4f46e5", border: "#c7d2fe" },
    { name: "Sunset Amber", bg: "#fff7ed", card: "#ffedd5", text: "#431407", accent: "#ea580c", border: "#fed7aa" },
    { name: "Charcoal Minimalist", bg: "#f8fafc", card: "#e2e8f0", text: "#18181b", accent: "#52525b", border: "#d4d4d8" }
  ];

  const selectedPalette = palettes[Math.floor(Math.random() * palettes.length)];

  const prompt = `You are an elite graphic designer creating a unique, high-end 1200x900 landscape vector banner SVG for "${bName}" (${bCat}).
Headline: "${headline}".
${festivalInstruction}

DESIGN & COLOR DIRECTIVE:
1. Return ONLY valid SVG code (<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">...</svg>) without markdown formatting or backticks.
2. COLOR SCHEME TO USE FOR THIS POST: Use the "${selectedPalette.name}" theme:
   - Background Fill: ${selectedPalette.bg}
   - Card/Container Fill: ${selectedPalette.card}
   - Primary Text Color: ${selectedPalette.text}
   - Accent / Highlight Color: ${selectedPalette.accent}
   - Border / Line Color: ${selectedPalette.border}
3. Layout & Typography: Clean editorial layout, beautiful spacing, professional hierarchy, vector graphics relevant to ${bCat}.
4. Background Coverage: Ensure a root <rect width="1200" height="900" fill="${selectedPalette.bg}"/> covers the entire canvas edge-to-edge.
5. Accuracy & Spelling: Double-check all rendered text for flawless English spelling and grammar. Do not invent misspelled words.
6. Restrictions: NO religious symbols or themes. NO customer reviews or star ratings in the graphic. Truthful workshop messaging only ("Walk-Ins Welcome • Direct Service").
7. XML Safety: All tags properly closed, zero duplicate attributes.`;

  if (geminiKeys && geminiKeys.length > 0) {
    for (let k = 0; k < geminiKeys.length; k++) {
      const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
      try {
        const response = await aiClient.models.generateContent({ model: 'gemini-3.5-flash', contents: prompt });
        let svg = response.text || '';
        svg = svg.replace(/```xml/g, '').replace(/```svg/g, '').replace(/```/g, '').trim();
        svg = svg.replace(/class="([^"]*)"\s+class="[^"]*"/g, 'class="$1"');

        if (svg.startsWith('<svg') && svg.endsWith('</svg>')) {
          return svg;
        }
      } catch (err) {}
    }
  }

  throw new Error('AI Banner generation failed.');
}

module.exports = {
  generate2LineAIReply,
  generateAutoPostText,
  generateAiPosterSvg
};
