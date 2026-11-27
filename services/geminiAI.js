const { GoogleGenAI } = require('@google/genai');

const rawKeysInput = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const geminiKeys = rawKeysInput
  .split(',')
  .map(k => k.trim())
  .filter(k => k.startsWith('AQ.'));

console.log(`[Gemini AI] Loaded ${geminiKeys.length} valid API key(s).`);

const MODELS_TO_TRY = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-4-hydrogen'
];

// Lightweight in-memory tracker (no history saved) to steer away from recent consecutive choices
const recentByBusiness = new Map();

function getRecentMemory(key) {
  return recentByBusiness.get(key) || { angles: [], layouts: [], lighting: [], mediums: [] };
}

function recordRecentMemory(key, entry) {
  const prev = getRecentMemory(key);
  const next = {
    angles: [entry.angle, ...prev.angles].filter(Boolean).slice(0, 4),
    layouts: [entry.layout, ...prev.layouts].filter(Boolean).slice(0, 4),
    lighting: [entry.lighting, ...prev.lighting].filter(Boolean).slice(0, 4),
    mediums: [entry.medium, ...prev.mediums].filter(Boolean).slice(0, 4)
  };
  recentByBusiness.set(key, next);
}

function pickUnseen(list, recentList) {
  const unused = list.filter(item => !recentList.includes(item));
  const pool = unused.length > 0 ? unused : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('resource_exhausted') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  );
}

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

async function callGeminiWithBackoff(aiClient, model, prompt, timeoutMs = 15000, maxRetries = 1, temperature = 1.0) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await aiClient.models.generateContent({
        model: model,
        contents: prompt,
        config: { temperature },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return extractResponseText(response);
    } catch (err) {
      clearTimeout(timeoutId);

      if (!isTransientError(err) || attempt >= maxRetries) {
        throw err;
      }

      attempt += 1;
      const baseDelay = Math.min(6000, 1200 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 500);
      const waitMs = baseDelay + jitter;

      console.log(
        `[Gemini AI] Busy on ${model} (retry ${attempt}/${maxRetries}), waiting ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }
}

async function runAcrossKeysAndModels(prompt, logTag, timeoutMs = 15000, temperature = 1.0, parser = null) {
  if (!geminiKeys || geminiKeys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  let lastError = 'Unknown error';

  for (const model of MODELS_TO_TRY) {
    for (let k = 0; k < geminiKeys.length; k++) {
      const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
      try {
        const rawText = await callGeminiWithBackoff(aiClient, model, prompt, timeoutMs, 1, temperature);
        if (rawText && rawText.trim().length > 0) {
          if (parser) {
            const parsed = parser(rawText);
            if (parsed) return parsed;
            lastError = `Model ${model} returned unparseable output`;
            console.log(`[${logTag}] Key ${k + 1}/${geminiKeys.length} (${model}) output format mismatch, trying next...`);
            continue;
          }
          return rawText.trim();
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[${logTag}] Key ${k + 1}/${geminiKeys.length} (${model}) skipped: ${err.message}`);
      }
    }
  }

  throw new Error(`${logTag} failed across all keys and models (${lastError}).`);
}

// 1. Review Replies (Model-outer, Key-inner rotation)
async function generate2LineAIReply(businessName, reviewerName, starRating, comment, supportEmail = '', supportPhone = '') {
  if (!geminiKeys || geminiKeys.length === 0) {
    console.error('[Gemini AI] No valid AQ. API keys found in environment variables.');
    return null;
  }

  const cleanComment = (comment && comment.trim() !== '') ? comment.trim() : 'Great service!';
  const cleanName = (reviewerName && reviewerName.trim() !== '') ? reviewerName.trim().split(' ')[0] : 'customer';

  let prompt = '';

  if (starRating <= 3) {
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

  try {
    const responseText = await runAcrossKeysAndModels(prompt, 'Gemini AI - Reply', 10000, 0.8);
    const cleanText = responseText.replace(/^["']|["']$/g, '');
    const sentences = cleanText.match(/[^.!?]+[.!?]+/g);

    if (sentences && sentences.length >= 2) {
      return `${sentences[0].trim()} ${sentences[1].trim()}`;
    } else if (sentences && sentences.length === 1) {
      return `${sentences[0].trim()}`;
    }
    return cleanText;
  } catch (err) {
    console.error('[Gemini AI - Reply] All keys and model fallbacks exhausted:', err.message);
    return null;
  }
}

// 2. Auto-Post Text (Dynamic Angle + Recent Memory Avoidance)
async function generateAutoPostText(locationName, category, topics, enableFestivals, enableReviewSpotlights) {
  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  const memKey = `${bName}::${bCat}`.toLowerCase();
  const memory = getRecentMemory(memKey);

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let festivalContext = 'Disabled';
  if (enableFestivals) {
    festivalContext = `ENABLED for today (${currentDate}). If there is a major SECULAR or NATIONAL non-religious day today (like Republic Day, Independence Day, Earth Day, New Year), or a relevant local weather/seasonal vibe (like summer care, monsoon prep, winter comfort), weave it in naturally. Strictly EXCLUDE all religious festivals or symbols.`;
  }

  const copyAngles = [
    'Behind-the-scenes expertise & attention to detail in our daily service',
    'Practical pro-tip or helpful advice every customer can benefit from',
    'Seasonal / weather readiness check tailored to our customers',
    'Quick spotlight on a signature offering or specialty we take pride in',
    'Warm invitation to visit us in person for honest guidance or service',
    'Celebrating quality standards, care, and lasting customer trust',
    'What customers often overlook until it matters most'
  ];
  const chosenAngle = pickUnseen(copyAngles, memory.angles);

  const avoidAnglesNote = memory.angles.length
    ? `Recent angles already used (do NOT repeat these framing styles): ${memory.angles.join(' | ')}.`
    : '';

  const prompt = `You are an expert social media copywriter for a business named "${bName}" (Category: ${bCat}).
Write an authentic, fresh Google Business Profile post tailored specifically to this business:
- Business Name: ${bName}
- Business Category: ${bCat}
- Today's Date: ${currentDate}
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Creative Angle for Today: ${chosenAngle}
- ${avoidAnglesNote}
- Seasonal & Event Context: ${festivalContext}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled (mention customer satisfaction subtly without quoting fake reviews)' : 'Disabled'}

Requirements:
1. Write 2 to 4 natural sentences as the real business owner.
2. Vary your opening line completely—do NOT start with "Nothing beats..." or "It's always a proud moment...".
3. Strictly NON-RELIGIOUS. Never mention religious festivals or rituals.
4. Include 1 clear call-to-action (walk-ins or phone calls only, NO online booking) and 2 relevant hashtags.
5. Output ONLY the final post text, no labels or quotes.`;

  const text = await runAcrossKeysAndModels(prompt, 'Gemini AI - Post Text', 10000, 1.0);
  recordRecentMemory(memKey, { angle: chosenAngle });
  return text.replace(/^["']|["']$/g, '');
}

// 3. Two-Step Art Director + SVG Illustrator (Orthogonal Matrix + Memory Avoidance)
async function generateAiPosterSvg(locationName, category, topics, enableFestivals) {
  if (!geminiKeys || geminiKeys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  const rawTopic = topics && topics.trim().length > 2 ? topics.trim() : bCat;
  const memKey = `${bName}::${bCat}`.toLowerCase();
  const memory = getRecentMemory(memKey);

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const layouts = [
    'Asymmetric split-screen: left 42% bold color panel with stacked minimal title, right 58% full-bleed scene',
    'Top-to-bottom magazine composition: clean editorial title bar across the top or bottom with an expansive wide scene filling the rest',
    'Left-column Swiss typographic poster: large clean headline on the left with layered scene/visuals occupying the right side',
    'Full-bleed atmospheric scene with a clean floating lower caption strip and open breathing space',
    'Diagonal two-zone composition splitting the canvas at an angle between scene and clean title space',
    'Asymmetric corner-anchored scene with generous open negative space framing minimal typography'
  ];

  const cameras = [
    'Wide environmental perspective showing context and depth',
    'Close-up angled view highlighting tactile materials and craft',
    'Elevated three-quarter angle across the workspace or setting',
    'Low-angle perspective looking upward toward warm light',
    'Over-the-shoulder action framing with foreground depth'
  ];

  const lightingOptions = [
    'Crisp morning daylight with soft natural shadows',
    'Warm golden-hour rim light and rich atmospheric depth',
    'Bright airy high-key natural light with clean contrast',
    'Soft overcast window light with gentle tonal gradients',
    'Warm afternoon light with distinct directional shadows'
  ];

  const mediums = [
    'Layered paper-cut / architectural depth vector illustration',
    'Mid-century editorial print style with clean vector contours',
    'Modern crisp vector illustration with multi-stop gradients',
    'Tactile textured vector artwork with subtle grain'
  ];

  const chosenLayout = pickUnseen(layouts, memory.layouts);
  const chosenCamera = cameras[Math.floor(Math.random() * cameras.length)];
  const chosenLighting = pickUnseen(lightingOptions, memory.lighting);
  const chosenMedium = pickUnseen(mediums, memory.mediums);

  const festivalContext = enableFestivals
    ? `Subtly reflect ${currentDate} season/weather or non-religious occasion in mood/colors (NO religious symbols).`
    : 'Timeless, business-appropriate mood.';

  const bannedRecentNote = [
    memory.layouts.length ? `Do NOT use these recent layouts: ${memory.layouts.join(' ; ')}.` : '',
    memory.lighting.length ? `Do NOT use these recent lighting setups: ${memory.lighting.join(' ; ')}.` : ''
  ].filter(Boolean).join(' ');

  // Step 1: Art Director creates a fresh, non-repetitive scene brief
  const artDirectorPrompt = `You are an Art Director creating a completely fresh 1200x900 visual brief for a business.
- Business Name: "${bName}"
- Business Category: "${bCat}"
- Focus Topic: "${rawTopic}"
- Seasonal Note: ${festivalContext}
- Assigned Layout: ${chosenLayout}
- Assigned Camera: ${chosenCamera}
- Assigned Lighting: ${chosenLighting}
- Assigned Medium: ${chosenMedium}
${bannedRecentNote}

STRICT RULES:
- Never put a lone centered badge, circular emblem, corner brackets, or dark spotlight icon unless specifically requested above.
- Keep text minimal: ONLY "${bName}" and one short 2-to-4 word title/tagline. No paragraphs, lists, grids, or star ratings.
- Output ONLY valid JSON (no markdown fences) with keys:
  "shortTitle" (string, 2-4 words),
  "subjectAndAction" (string, 1-2 sentences tailored to "${bName}" / "${bCat}" / "${rawTopic}"),
  "palette" (array of 4 hex color strings: [bg, secondary, accent, text])`;

  let brief = {
    shortTitle: rawTopic.split(',')[0].trim().slice(0, 26) || 'Craft & Care',
    subjectAndAction: `Authentic scene tailored to ${bName} (${bCat}) focusing on ${rawTopic}.`,
    palette: ['#f8f5ee', '#1e3a2f', '#d97706', '#1c1917']
  };

  try {
    const briefRaw = await runAcrossKeysAndModels(
      artDirectorPrompt,
      'Gemini AI - Art Director',
      12000,
      1.0,
      (raw) => {
        const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);
        if (parsed && parsed.subjectAndAction && Array.isArray(parsed.palette) && parsed.palette.length >= 4) {
          return parsed;
        }
        return null;
      }
    );
    brief = {
      shortTitle: String(briefRaw.shortTitle || brief.shortTitle).slice(0, 32),
      subjectAndAction: String(briefRaw.subjectAndAction),
      palette: briefRaw.palette.slice(0, 4)
    };
  } catch (err) {
    console.log(`[Gemini AI - Art Director] Using fallback brief: ${err.message}`);
  }

  const [bgCol, secCol, accCol, txtCol] = brief.palette;

  // Step 2: SVG Illustrator renders the brief using the 5-part formula
  const svgPrompt = `Generate a clean, realistic 1200x900 SVG poster using this 5-part formula:
[Subject & Action] + [Realistic Shading & Lighting] + [Texture & Material Detail] + [Composition & Camera/Angle] + [SVG / Vector Specs]

1. [Subject & Action]: ${brief.subjectAndAction}
2. [Realistic Shading & Lighting]: ${chosenLighting}. Use multi-stop <linearGradient> and <radialGradient> fills for depth.
3. [Texture & Material Detail]: ${chosenMedium}. Palette: background ${bgCol}, surface ${secCol}, accent ${accCol}, text ${txtCol}. Add subtle SVG <filter> grain/texture where fitting.
4. [Composition & Camera/Angle]: ${chosenCamera} with layout: ${chosenLayout}.
5. [SVG / Vector Specs]: Clean scalable vector paths, sharp contours, layered <g> groups, 1200x900 viewBox.

MINIMAL TEXT (ONLY THESE TWO):
- "${bName}"
- "${brief.shortTitle}"
No extra text blocks, badges, ratings, or religious symbols.

STRICT OUTPUT:
- Return ONLY raw <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">...</svg> with zero markdown fences or explanations.
- Start with <rect width="1200" height="900" fill="${bgCol}"/>, keep text inside x=70..1130 and y=80..840, and escape "&" as "&amp;".`;

  const svg = await runAcrossKeysAndModels(
    svgPrompt,
    'Gemini AI - SVG',
    20000,
    1.0,
    (raw) => {
      const cleaned = raw.replace(/```(?:xml|svg|html)?/gi, '').replace(/```/g, '').trim();
      const svgMatch = cleaned.match(/<svg[\s\S]*?<\/svg>/i);
      if (!svgMatch || !svgMatch[0]) return null;

      let out = svgMatch[0].trim();
      if (!/xmlns=/.test(out)) {
        out = out.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      out = out.replace(/class="([^"]*)"\s+class="[^"]*"/g, 'class="$1"');
      out = out.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
      return out;
    }
  );

  recordRecentMemory(memKey, {
    layout: chosenLayout,
    lighting: chosenLighting,
    medium: chosenMedium
  });

  return svg;
}

module.exports = {
  generate2LineAIReply,
  generateAutoPostText,
  generateAiPosterSvg
};
