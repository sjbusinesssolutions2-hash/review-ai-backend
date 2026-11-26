const { GoogleGenAI } = require('@google/genai');

const rawKeysInput = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const geminiKeys = rawKeysInput
  .split(',')
  .map(k => k.trim())
  .filter(k => k.startsWith('AQ.'));

const MODELS_TO_TRY = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-4-hydrogen'
];

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

// Helper that runs a Gemini call with retry + exponential backoff + jitter
async function callGeminiWithBackoff(aiClient, model, prompt, timeoutMs = 15000, maxRetries = 1) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await aiClient.models.generateContent({
        model: model,
        contents: prompt,
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

  for (let k = 0; k < geminiKeys.length; k++) {
    const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });

    for (const model of MODELS_TO_TRY) {
      try {
        const responseText = await callGeminiWithBackoff(aiClient, model, prompt, 10000, 1);

        if (responseText && responseText.trim().length > 0) {
          const cleanText = responseText.trim().replace(/^["']|["']$/g, '');
          const sentences = cleanText.match(/[^.!?]+[.!?]+/g);

          if (sentences && sentences.length >= 2) {
            return `${sentences[0].trim()} ${sentences[1].trim()}`;
          } else if (sentences && sentences.length === 1) {
            return `${sentences[0].trim()}`;
          }
          return cleanText;
        }
      } catch (err) {
        console.log(`[Gemini AI - Reply] Key ${k + 1} (${model}) skipped: ${err.message}`);
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

  let festivalContext = 'Disabled';
  if (enableFestivals) {
    festivalContext = `ENABLED for today (${currentDate}). If there is a major SECULAR or NATIONAL non-religious day today (like Republic Day, Independence Day, Earth Day, New Year), or a relevant local weather/seasonal vibe (like summer care, monsoon prep, winter comfort), weave it in naturally. Strictly EXCLUDE all religious festivals or symbols.`;
  }

  const copyAngles = [
    'Behind-the-scenes craftsmanship & attention to detail in our daily work',
    'Practical pro-tip or maintenance advice every customer should know',
    'Seasonal / weather readiness check for best performance',
    'Quick spotlight on one specific specialty service we take pride in',
    'Warm invitation to drop by the shop for an honest checkup or consultation',
    'Celebrating quality materials, precision tools, and lasting durability'
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

  let lastError = 'Unknown error';

  for (let k = 0; k < geminiKeys.length; k++) {
    const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });

    for (const model of MODELS_TO_TRY) {
      try {
        const responseText = await callGeminiWithBackoff(aiClient, model, prompt, 10000, 1);

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[Gemini AI - Post Text] Key ${k + 1} (${model}) skipped: ${err.message}`);
      }
    }
  }

  throw new Error(`AI Post text generation failed across all keys and models (${lastError}).`);
}

// Dynamic Realistic SVG Poster Generator (5-Part Visual Formula + Minimal Text)
async function generateAiPosterSvg(locationName, category, topics, enableFestivals) {
  if (!geminiKeys || geminiKeys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  const rawTopic = topics && topics.trim().length > 2 ? topics.trim() : bCat;

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const festivalContext = enableFestivals
    ? `Weave subtle seasonal/weather atmosphere or secular occasion mood for ${currentDate} into the lighting and environment (strictly NO religious symbols).`
    : 'Natural, timeless studio or workshop atmosphere.';

  // Varied camera/composition angles so no two days share the same framing
  const cameraCompositions = [
    'Cinematic close-up macro hero shot with shallow depth-of-field background layering and clean lower-third negative space for minimal title',
    'Dramatic three-quarter angled perspective across a workbench/environment with expansive atmospheric background and clean top-left sky/wall space',
    'Low-angle heroic silhouette and rim-lit centerpiece rising toward warm horizon light with clean bottom caption band',
    'Wide editorial environmental scene with foreground framing elements, mid-ground focal subject in action, and soft atmospheric depth',
    'Overhead flat-lay studio composition with soft directional side shadows, natural surfaces, and clean centered or edge-aligned typography',
    'Minimalist gallery-style centerpiece floating in rich gradient atmosphere with subtle architectural framing and generous breathing room'
  ];

  // Varied lighting & mood palettes
  const lightingMoods = [
    'Golden hour warm rim lighting, soft amber sunbeams, deep warm shadows, rich atmospheric depth',
    'Crisp morning daylight, cool sky highlights, soft diffused studio bounce light, clean natural contrast',
    'Moody dramatic workshop spotlight, warm tungsten key light against deep indigo/charcoal ambient shadows',
    'Soft overcast natural window light, gentle tonal gradations, muted earthy warmth, calm editorial clarity',
    'Vibrant late-afternoon sunlight casting long diagonal shadows, warm terracotta and cream highlights',
    'Twilight deep-blue ambient glow contrasted with warm golden edge highlights and subtle atmospheric mist'
  ];

  const chosenCamera = cameraCompositions[Math.floor(Math.random() * cameraCompositions.length)];
  const chosenLighting = lightingMoods[Math.floor(Math.random() * lightingMoods.length)];

  const prompt = `You are a master vector illustrator and art director creating a realistic, museum-grade 1200x900 SVG artwork for "${bName}" (Category: ${bCat}, Focus: "${rawTopic}").

Build the artwork using this exact 5-part Prompt Formula:
[Subject & Action] + [Realistic Shading & Lighting] + [Texture & Material Detail] + [Composition & Camera/Angle] + [SVG / Vector Specs]

Reference Example of the Visual Quality & Style Expected:
"Snow-capped mountain peak above a misty pine forest at golden hour, rich atmospheric depth, warm rim lighting, layered gradient shading, subtle grain texture, clean vector paths, sharp contours, scalable SVG graphic."

APPLY THE 5-PART FORMULA TO THIS SCENE:
1. [Subject & Action]: Depict a vivid, authentic subject or scene in action representing "${bName}" (${bCat} — ${rawTopic}). ${festivalContext}
2. [Realistic Shading & Lighting]: ${chosenLighting}. Use multi-stop <linearGradient> and <radialGradient> definitions, soft cast shadows, rim highlights, and layered atmospheric depth—NOT flat solid clipart.
3. [Texture & Material Detail]: Render realistic material surfaces (wood grain, brushed metal, woven fabric, leather, stone, mist, glass reflections, or natural foliage) using layered vector paths, fine contour lines, and subtle SVG <filter> noise/grain texture where appropriate.
4. [Composition & Camera/Angle]: ${chosenCamera}.
5. [SVG / Vector Specs]: Clean vector paths, sharp contours, layered depth groups (<g>), scalable 1200x900 SVG graphic.

STRICT MINIMAL-TEXT RULE (VERY IMPORTANT):
- Let the realistic illustration occupy 80%+ of the visual focus.
- Include AT MOST TWO tiny, ultra-clean text elements in the entire SVG:
  1) Business Name: "${bName}" (clean, crisp typography placed in a clear negative-space area)
  2) One short 2-to-4 word tagline or topic title (e.g. "${rawTopic.split(',')[0].trim().slice(0, 28)}")
- DO NOT include paragraphs, bullet points, 2x2 grids, feature boxes, phone numbers, badges, star ratings, or "Walk-Ins Welcome" clutter. Keep the artwork pure and uncluttered.

TECHNICAL & XML SAFETY RULES:
1. Return ONLY raw valid SVG code starting with <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"> and ending with </svg>. No markdown backticks, XML declarations, or commentary.
2. Edge-to-edge background: First element inside <svg> must be a full-canvas <rect width="1200" height="900" .../> so there are zero transparent gaps.
3. Zero text clipping: Keep text inside x=70..1130 and y=80..840 with well-proportioned font sizes so nothing is ever cut off.
4. XML validity: Escape any "&" as "&amp;", close all tags properly, and never duplicate attributes.`;

  let lastError = 'Unknown error';

  for (let k = 0; k < geminiKeys.length; k++) {
    const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });

    for (const model of MODELS_TO_TRY) {
      try {
        let rawText = await callGeminiWithBackoff(aiClient, model, prompt, 20000, 1);
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
          console.log(`[Gemini AI - SVG] Key ${k + 1} (${model}) returned non-SVG output, trying next...`);
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[Gemini AI - SVG] Key ${k + 1} (${model}) skipped: ${err.message}`);
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
