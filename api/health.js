// api/health.js — BSKIT 백엔드 설정 진단(비밀값은 절대 반환하지 않음)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET 요청만 허용됩니다.' }); return; }

  var folder = String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  var folderNormalized = !folder || folder === '.' || folder === '/' || folder.toLowerCase() === 'root'
    ? '' : folder;

  res.status(200).json({
    ok: true,
    version: '13.3',
    ai: {
      openai: !!String(process.env.OPENAI_API_KEY || '').trim(),
      gemini: !!String(process.env.GEMINI_API_KEY || '').trim(),
      groq: !!String(process.env.GROQ_API_KEY || '').trim(),
      news_model: String(process.env.OPENAI_NEWS_MODEL || 'gpt-5.4-mini'),
      drive_model: String(process.env.OPENAI_DRIVE_MODEL || 'gpt-4o-mini')
    },
    drive: {
      service_account_email: !!String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
      service_account_key: !!String(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim(),
      folder_scope: folderNormalized ? 'configured' : 'all-shared-files',
      invalid_dot_value_detected: folder === '.'
    },
    sgis: {
      consumer_key: !!String(process.env.SGIS_CONSUMER_KEY || '').trim(),
      consumer_secret: !!String(process.env.SGIS_CONSUMER_SECRET || '').trim(),
      year: String(process.env.SGIS_STATS_YEAR || '2024'),
      output_crs: 'EPSG:4326'
    }
  });
};
