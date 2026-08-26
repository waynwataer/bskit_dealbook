module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET 요청만 허용됩니다.' }); return; }

  const hasOpenAI = !!(process.env.OPENAI_API_KEY || '').trim();
  const hasGemini = !!(process.env.GEMINI_API_KEY || '').trim();
  const hasGroq = !!(process.env.GROQ_API_KEY || '').trim();
  const hasDrive = !!((process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim() && (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim());
  const hasSgis = !!((process.env.SGIS_CONSUMER_KEY || '').trim() && (process.env.SGIS_CONSUMER_SECRET || '').trim());

  res.status(200).json({
    ok: true,
    service: 'bskit-dealbook',
    version: '13.7',
    aiConfigured: hasOpenAI || hasGemini || hasGroq,
    openaiConfigured: hasOpenAI,
    geminiConfigured: hasGemini,
    groqConfigured: hasGroq,
    driveConfigured: hasDrive,
    sgisConfigured: hasSgis,
    sgisYear: (process.env.SGIS_STATS_YEAR || '2024').trim(),
    workplaceOutputCrs: 'EPSG:4326'
  });
};
