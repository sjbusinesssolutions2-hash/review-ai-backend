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

  for (const model of MODELS_TO_TRY) {
    for (let k = 0; k < geminiKeys.length; k++) {
      const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
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
        console.log(`[Gemini AI - Reply] Key ${k + 1}/${geminiKeys.length} (${model}) skipped: ${err.message}`);
      }
    }
  }

  console.error('[Gemini AI - Reply] All keys and model fallbacks exhausted.');
  return null;
}

// 2. Auto-Post Text (100% Dynamic to Business Name, Category & Topics)
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
    'Behind-the-scenes expertise & attention to detail in our daily service',
    'Practical pro-tip or helpful advice every customer can benefit from',
    'Seasonal / weather readiness check tailored to our customers',
    'Quick spotlight on a signature offering or specialty we take pride in',
    'Warm invitation to visit us in person for honest guidance or service',
    'Celebrating quality standards, care, and lasting customer trust'
  ];
  const chosenAngle = copyAngles[Math.floor(Math.random() * copyAngles.length)];

  const prompt = `You are an expert social media copywriter for a business named "${locationName || 'Our Business'}" (Category: ${category || 'Local Business'}).
Write an authentic, fresh Google Business Profile post tailored specifically to this business:
- Business Name: ${locationName || 'Our Business'}
- Business Category: ${category || 'Local Business'}
- Today's Date: ${currentDate}
- Topics/Focus: ${topics || 'General business highlights and customer service'}
- Creative Angle for Today: ${chosenAngle}
- Seasonal & Event Context: ${festivalContext}
- Review Spotlight: ${enableReviewSpotlights ? 'Enabled (mention customer satisfaction subtly without quoting fake reviews)' : 'Disabled'}

Requirements:
1. Write 2 to 4 natural sentences as the real business owner.
2. Vary your opening line completely—do NOT start with "Nothing beats..." or "It's always a proud moment...".
3. Strictly NON-RELIGIOUS. Never mention religious festivals or rituals.
4. Include 1 clear call-to-action (walk-ins or phone calls only, NO online booking) and 2 relevant hashtags.
5. Output ONLY the final post text, no labels or quotes.`;

  let lastError = 'Unknown error';

  for (const model of MODELS_TO_TRY) {
    for (let k = 0; k < geminiKeys.length; k++) {
      const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
      try {
        const responseText = await callGeminiWithBackoff(aiClient, model, prompt, 10000, 1);

        if (responseText && responseText.trim().length > 0) {
          return responseText.trim().replace(/^["']|["']$/g, '');
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[Gemini AI - Post Text] Key ${k + 1}/${geminiKeys.length} (${model}) skipped: ${err.message}`);
      }
    }
  }

  throw new Error(`AI Post text generation failed across all keys and models (${lastError}).`);
}

// 3. Dynamic Realistic SVG Poster Generator — 100% Universal Across Any Business
async function generateAiPosterSvg(locationName, category, topics, enableFestivals) {
  if (!geminiKeys || geminiKeys.length === 0) {
    throw new Error('No valid Gemini API keys configured.');
  }

  const bName = locationName || 'Our Business';
  const bCat = category || 'Local Business';
  const rawTopic = topics && topics.trim().length > 2 ? topics.trim() : bCat;
  const randomSeed = Math.floor(100000 + Math.random() * 900000);

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const festivalContext = enableFestivals
    ? `Subtly reflect ${currentDate} weather/season or secular national spirit in the palette/mood (strictly NO religious symbols).`
    : 'Timeless visual mood.';

  const artStyles = [
    {
      name: 'Bright Daylight Editorial Poster',
      bgPalette: 'Crisp sunlit ivory (#fdfbf7), warm sage green (#2d6a4f), and terracotta coral (#e76f51)',
      subjectDirective: 'An expansive, sunlit outdoor or open-air environmental scene tailored to the business industry, with crisp natural shadows and open sky/wall space for minimal typography',
      lighting: 'Bright natural morning sunlight, crisp cast shadows, airy depth, clean layered gradients'
    },
    {
      name: 'Retro Vintage Screenprint Poster',
      bgPalette: 'Warm cream paper (#f4ebd9), deep navy (#1d3557), burnt sienna (#c84b31), and mustard ochre (#e9c46a)',
      subjectDirective: 'A bold vintage print poster featuring stylized geometric sunbeams, classic framing lines, and an iconic visual motif representing the business craft or service',
      lighting: 'Warm screen-printed ink layers, subtle halftone/grain texture, bold contrast bands'
    },
    {
      name: 'Minimalist Modernist Geometry',
      bgPalette: 'Soft alabaster (#fafafa), cobalt blue (#2563eb), and warm sand (#f5e6cc)',
      subjectDirective: 'Architectural circles, bold overlapping geometric shapes, and a clean central vector symbol tailored to the business industry with generous negative space',
      lighting: 'Soft diffused studio light, subtle elevation gradients, razor-sharp edges'
    },
    {
      name: 'Golden Hour Scenic & Atmospheric Art',
      bgPalette: 'Warm honey gold (#fef3c7), deep slate (#1e293b), and sunset amber (#f59e0b)',
      subjectDirective: 'A dramatic golden-hour silhouette or scenic horizon composition inspired by the business domain, with rich atmospheric depth',
      lighting: 'Golden hour warm rim lighting, layered atmospheric depth, soft mist gradients'
    },
    {
      name: 'Fresh Mint & Tactile Studio Craft',
      bgPalette: 'Soft mint cream (#f0fdf4), deep emerald (#065f46), and warm copper (#c2410c)',
      subjectDirective: 'An overhead flat-lay or three-quarter studio composition showcasing authentic tools, textures, and materials of the business with clean breathing room',
      lighting: 'Soft directional daylight, gentle tonal shading, tactile material detail'
    },
    {
      name: 'Bold Editorial Typography & Emblem',
      bgPalette: 'Warm terracotta clay (#fdf4f0), deep burgundy (#4a0e17), and bright gold (#eab308)',
      subjectDirective: 'An editorial poster composition where refined display typography and a bespoke central vector emblem anchor the canvas',
      lighting: 'Balanced studio key light, rich warm gradients, clean vector linework'
    },
    {
      name: 'Nocturnal Spotlight & Rich Contrast',
      bgPalette: 'Deep charcoal (#111827), warm amber glow (#f59e0b), and soft cream (#f9fafb)',
      subjectDirective: 'A dramatic close-up hero subject from the business domain illuminated by a warm directional spotlight against deep ambient shadow',
      lighting: 'Warm tungsten key light, soft rim highlights, subtle vignette depth'
    }
  ];

  const chosenStyle = artStyles[Math.floor(Math.random() * artStyles.length)];

  const prompt = `Create a completely fresh, distinct 1200x900 SVG poster (Seed #${randomSeed}) tailored specifically to the business below:
- Business Name: "${bName}"
- Business Category: "${bCat}"
- Focus Topic: "${rawTopic}"
- Style Direction: "${chosenStyle.name}"
- Seasonal Context: ${festivalContext}

Infer the exact industry, setting, tools, products, or atmosphere from "${bName}", "${bCat}", and "${rawTopic}" so the illustration feels genuinely custom-made for this specific business. Vary your visual concept every time so consecutive posts never look alike.

5-PART PROMPT FORMULA:
[Subject & Action]: ${chosenStyle.subjectDirective}, customized authentically for "${bName}" (${bCat} — ${rawTopic}).
[Realistic Shading & Lighting]: ${chosenStyle.lighting}. Use multi-stop <linearGradient>/<radialGradient> and layered depth.
[Texture & Material Detail]: ${chosenStyle.bgPalette}. Add realistic surface/material detail and subtle SVG filter grain where fitting.
[Composition & Camera/Angle]: Distinct composition for Seed #${randomSeed}—vary framing, focal placement, and visual rhythm.
[SVG / Vector Specs]: Clean scalable vector paths, sharp contours, organized <g> layers, 1200x900 viewBox.

MINIMAL TEXT RULE:
- Keep text minimal and clean—ONLY:
  1) Business Name: "${bName}"
  2) Short 2-to-4 word title/phrase (${rawTopic.split(',')[0].trim().slice(0, 26)})
- No paragraphs, no bullet lists, no 2x2 grids, no star ratings, no religious symbols.

OUTPUT RULES:
- Return ONLY raw <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">...</svg> with no markdown fences or extra text.
- Start with a full-bleed 1200x900 background <rect>, keep all text inside x=70..1130 and y=80..840, and escape "&" as "&amp;".`;

  let lastError = 'Unknown error';

  for (const model of MODELS_TO_TRY) {
    for (let k = 0; k < geminiKeys.length; k++) {
      const aiClient = new GoogleGenAI({ apiKey: geminiKeys[k] });
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
          console.log(`[Gemini AI - SVG] Key ${k + 1}/${geminiKeys.length} (${model}) returned non-SVG output, trying next...`);
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[Gemini AI - SVG] Key ${k + 1}/${geminiKeys.length} (${model}) skipped: ${err.message}`);
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
