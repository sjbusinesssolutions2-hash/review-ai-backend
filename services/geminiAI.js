const { GoogleGenAI } = require('@google/genai');

const rawKeysInput = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const geminiKeys = rawKeysInput
  .split(',')
  .map(k => k.trim())
  .filter(k => k.startsWith('AQ.'));

// Helper to safely extract response text across @google/genai response shapes
function extractResponseText(response) {
  if (!response) return '';
  if (typeof response.text === 'string') {
    return response.text;
  }
  if (response.candidates && response.candidates[0] && response.candidates[0].content) {
    return response.candidates[0].content.parts.map(p => p.text || '').join('');
  }
  return '';
}

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
1. Detect and reply in the exact same language and script as the customer's review comment (e.g., Russian, Arabic, French, Spanish, Roman Hindi, etc.). Default to standard English only if the comment is in English or cannot be determined.
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
1. Detect and reply in the exact same language and script as the customer's review comment (e.g., Russian, Arabic, French, Spanish, Roman Hindi, etc.). Default to standard English only if the comment is in English or cannot be determined.
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
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const responseText = extractResponseText(response);

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
        console.warn(`[Gemini AI - Reply] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  console.error('[Gemini AI - Reply] All keys and model fallbacks exhausted.');
  return null;
}

// Generator for Auto-Posts (Varied Angles & Fresh Copy)
async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  if (!geminiKeys || geminiKeys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  let festivalContext = "Disabled";
  if (enableFestivals) {
    festivalContext = `ENABLED for today (${currentDate}). If there is a major SECULAR or NATIONAL non-religious day today (like Republic Day, Independence Day, Earth Day, New Year), or a relevant local weather/seasonal vibe (like summer care, monsoon prep, winter comfort), weave it in naturally. Strictly EXCLUDE all religious festivals or symbols.`;
  }

  const copyAngles = [
    "Behind-the-scenes craftsmanship & attention to detail in our daily work",
    "Practical pro-tip or maintenance advice every customer should know",
    "Seasonal / weather readiness check for best performance",
    "Quick spotlight on one specific specialty service we take pride in",
    "Warm invitation to drop by the shop for an honest checkup or consultation",
    "Celebrating quality materials, precision tools, and lasting durability"
  ];
  const chosenAngle = copyAngles[Math.floor(Math.random() * copyAngles.length)];

  const prompt = `You are an expert social media copywriter for a local business named "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
Write an authentic, fresh Google Business Profile post based on these settings:
- Today's Date: ${currentDate}
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Creative Angle for Today: ${chosenAngle}
- Seasonal & Event Context: ${festivalContext}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled (mention customer satisfaction subtly without quoting fake reviews)' : 'Disabled'}

Requirements:
1. Write 2 to 4 natural sentences as a real local business owner.
2. Vary your opening line completely—do NOT start with "Nothing beats..." or "It's always a proud moment...".
3. Strictly NON-RELIGIOUS. Never mention religious festivals or rituals.
4. Include 1 clear call-to-action (walk-ins or phone calls only, NO online booking) and 2 relevant hashtags.
5. Output ONLY the final post text, no labels or quotes.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (let k = 0; k < geminiKeys.length; k++) {
    const key = geminiKeys[k];
    const aiClient = new GoogleGenAI({ apiKey: key });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const responseText = extractResponseText(response);

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        console.warn(`[Gemini AI - Post Text] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  throw new Error('AI Post text generation failed across all keys and models.');
}

// Dynamic SVG Poster Generator (10 Distinct Layouts & Styles — Zero Repeating Brochure Grid)
async function generateAiPosterSvg(locationName, category, topics, enableFestivals) {
  if (!geminiKeys || geminiKeys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  const rawTopic = topics && topics.trim().length > 2 ? topics.trim() : bCat;

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const festivalInstruction = enableFestivals 
    ? `SEASONAL & EVENT ACCENT ACTIVE (Date: ${currentDate}): Add subtle visual accents matching the current weather/season or non-religious national occasion. Strictly NO religious symbols.` 
    : `Clean, timeless brand artwork.`;

  const palettes = [
    { name: "Vintage Cream & Terracotta", bg: "#faf8f5", surface: "#f2eae1", text: "#1c1917", accent: "#ea580c", muted: "#57534e" },
    { name: "Deep Forest & Warm Gold", bg: "#062c1e", surface: "#0d3d2b", text: "#f8fafc", accent: "#fbbf24", muted: "#a7f3d0" },
    { name: "Midnight Navy & Electric Cyan", bg: "#0f172a", surface: "#1e293b", text: "#f8fafc", accent: "#38bdf8", muted: "#94a3b8" },
    { name: "Warm Saffron & Espresso", bg: "#fffbeb", surface: "#fef3c7", text: "#451a03", accent: "#d97706", muted: "#78350f" },
    { name: "Rich Crimson & Ivory", bg: "#fff1f2", surface: "#ffe4e6", text: "#4c0519", accent: "#e11d48", muted: "#881337" },
    { name: "Charcoal Slate & Lime", bg: "#18181b", surface: "#27272a", text: "#fafafa", accent: "#a3e635", muted: "#a1a1aa" },
    { name: "Royal Indigo & Soft Lavender", bg: "#eef2ff", surface: "#e0e7ff", text: "#1e1b4b", accent: "#4f46e5", muted: "#4338ca" },
    { name: "Terracotta Clay & Sand", bg: "#fdf8f6", surface: "#faedcd", text: "#381d05", accent: "#bc6c25", muted: "#6c584c" },
    { name: "Emerald & Crisp White", bg: "#ecfdf5", surface: "#d1fae5", text: "#022c22", accent: "#059669", muted: "#065f46" },
    { name: "Bold Cobalt & Tangerine", bg: "#172554", surface: "#1e3a8a", text: "#ffffff", accent: "#fb923c", muted: "#bfdbfe" }
  ];

  const layoutBlueprints = [
    {
      name: "Bold Full-Bleed Editorial Poster",
      rules: "Oversized expressive display typography across the upper canvas, clean architectural divider lines, and a large bespoke vector illustration anchored in the bottom-right or center-bottom. DO NOT use a 2-column card split or 4-box feature grid."
    },
    {
      name: "Diagonal Dynamic Split",
      rules: "Use a bold diagonal polygon backdrop splitting the 1200x900 canvas into two contrasting color zones. Place crisp, concise headline typography on one side and a large, detailed vector illustration of the craft/product on the other. NO mini-card grids."
    },
    {
      name: "Centered Heritage Emblem & Frame",
      rules: "Classic vintage poster composition with an ornate double-line border, a bold central circular or shield emblem containing custom vector artwork relevant to the business, curved or stacked bold title above, and a clean bottom ribbon banner."
    },
    {
      name: "Minimalist Swiss Grid Typography",
      rules: "Ultra-clean Swiss modernist poster style: huge bold headline on the left/top, generous negative space, geometric accent shapes, and one crisp minimalist vector illustration. Maximum 3 text blocks total—NO tiny boxes or bullet cards."
    },
    {
      name: "Top Panoramic Illustration + Bold Bottom Strip",
      rules: "Top 62% of the canvas is an expansive, rich panoramic vector scene illustrating the workshop/service in action. Bottom 38% is a solid high-contrast band featuring the business name, a punchy 3-5 word headline, and a simple walk-in callout."
    },
    {
      name: "Magazine Cover Spotlight",
      rules: "Styled like a modern trade magazine cover: bold masthead title at the very top, a centerpiece hero illustration filling the middle of the canvas, and one bold editorial headline overlay at the bottom."
    },
    {
      name: "Circular Spotlight & Floating Badges",
      rules: "A large glowing or solid geometric circle off-center housing a detailed vector illustration, balanced by clean stacked typography on the opposite side and 1-2 floating pill tags. NO 2x2 rectangular grids."
    },
    {
      name: "Dark Mode Neon / High-Contrast Showcase",
      rules: "Rich dark background with glowing accent strokes, blueprint/technical line-art accents, bold high-contrast headline, and a sleek vector centerpiece."
    }
  ];

  const selectedPalette = palettes[Math.floor(Math.random() * palettes.length)];
  const selectedLayout = layoutBlueprints[Math.floor(Math.random() * layoutBlueprints.length)];

  const prompt = `You are an award-winning graphic designer creating a completely unique 1200x900 landscape vector poster SVG for "${bName}" (Business Category: ${bCat}).
Focus Topic: "${rawTopic}".
${festivalInstruction}

MANDATORY VISUAL DIRECTION (FOLLOW THIS EXACT STYLE):
- Composition Archetype: "${selectedLayout.name}"
- Layout Instructions: ${selectedLayout.rules}
- NEVER repeat a generic 2-column dashboard with 4 small service cards. NEVER use the generic phrase "Expert Local Business" as the main headline—instead invent a punchy, authentic 2 to 5 word headline tailored specifically to "${bCat}" and "${rawTopic}".

COLOR PALETTE:
- Theme: "${selectedPalette.name}"
- Canvas Background: ${selectedPalette.bg}
- Secondary Surface/Shape Fill: ${selectedPalette.surface}
- Primary Text Color: ${selectedPalette.text}
- Accent / Highlight Color: ${selectedPalette.accent}
- Muted / Subtitle Color: ${selectedPalette.muted}

CRITICAL TECHNICAL & TYPOGRAPHY RULES:
1. Return ONLY valid raw SVG code (<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">...</svg>) with ZERO markdown backticks, XML headers, or explanations.
2. Edge-to-edge background: Start with <rect width="1200" height="900" fill="${selectedPalette.bg}"/>.
3. Zero text clipping or overflow: Keep every <text> line short, well inside margins (x between 60 and 1140), and properly sized so no word is ever cut off at the edge of a box or canvas.
4. Spelling & XML safety: Double-check every word for flawless English spelling. Escape any "&" as "&amp;". Ensure every tag is properly closed and has zero duplicate attributes.
5. Restrictions: NO religious symbols or themes. NO fake customer reviews or star ratings. Keep messaging authentic ("Walk-Ins Welcome • Direct Service").`;

  const modelsToTry = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  let lastError = 'Unknown error';

  for (let k = 0; k < geminiKeys.length; k++) {
    const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });

    for (const model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await aiClient.models.generateContent({
          model: model,
          contents: prompt,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        let rawText = extractResponseText(response);
        rawText = rawText.replace(/```(?:xml|svg|html)?/gi, '').replace(/```/g, '').trim();

        const svgMatch = rawText.match(/<svg[\s\S]*?<\/svg>/i);

        if (svgMatch && svgMatch[0]) {
          let svg = svgMatch[0].trim();

          if (!/xmlns=/.test(svg)) {
            svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
          }

          svg = svg.replace(/class="([^"]*)"\s+class="[^"]*"/g, 'class="$1"');
          svg = svg.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');

          return svg;
        } else {
          lastError = `Model ${model} returned non-SVG output`;
          console.warn(`[Gemini AI - SVG] Key ${k + 1} (${model}) returned invalid SVG snippet: ${rawText.substring(0, 120)}`);
        }
      } catch (err) {
        lastError = err.message;
        console.warn(`[Gemini AI - SVG] Key ${k + 1} with model ${model} failed: ${err.message}. Trying next...`);
      }
    }
  }

  throw new Error(`AI Banner generation failed (${lastError}).`);
}

module.exports = {
  generate2LineAIReply,
  generateAutoPostText,
  generateAiPosterSvg
};
      
