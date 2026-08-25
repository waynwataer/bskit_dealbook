// api/ai-compare.js
// BSKIT DealBook의 "BSKIT AI Analyst"가 호출하는 백엔드.
// API 키(OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY)는 절대 대시보드
// HTML에 넣지 않고, 이 서버(Vercel 프로젝트)의 환경변수로만 보관합니다.
//
// 대시보드 CONFIG.AI_COMPARE_ENDPOINT 에는 이 함수가 배포된 주소를 넣습니다.
// 예) https://bskit-backend.vercel.app/api/ai-compare

module.exports = async function handler(req, res) {
  // 티스토리(외부 도메인)에서 오는 요청을 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, service: 'bskit-ai-compare', version: '13.4', methods: ['POST'] });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST 요청만 허용됩니다.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { mode = 'openai', question = '', context = {}, synthesize = false } = body || {};

  if (!question.trim()) { res.status(400).json({ error: 'question(질문)이 비어 있습니다.' }); return; }

  // ★ 시스템 프롬프트뿐 아니라 사용자 질문 바로 앞에도 같은 지시를 한 번 더 붙입니다.
  // 모델이 대화의 뒷부분(최신 지시)을 더 강하게 따르는 경향이 있어, 이중 안전장치입니다.
  const askedQuestion =
    '(반드시 시스템 컨텍스트에 있는 거래사례만 사용해 답하세요. 목록에 없는 건물명이나 ' +
    '당신이 알고 있는 실제 뉴스 속 매각 사례는 절대 언급하지 마세요.)\n\n' + question;

  // ★ v12.6 — 가벼운 요약 컨텍스트(sysLight, 클라이언트가 보낸 상위 12건)와,
  // 구글시트 원본 전체를 서버가 직접 조회해 만든 상세 컨텍스트(sysFull)를 분리합니다.
  // Groq는 무료 토큰 한도가 좁아 항상 sysLight만 쓰고, GPT·Gemini는 가능하면
  // sysFull(전체 시트 기반 상세분석)을 사용합니다.
  const sysLight = buildSystemPrompt(context);
  let sysFull = sysLight;
  if (context && context.apps_script_url) {
    try {
      const sheetDeals = await fetchSheetDeals(context.apps_script_url);
      if (sheetDeals && sheetDeals.length) {
        sysFull = buildSystemPrompt(Object.assign({}, context, {
          deals: sheetDeals,
          deals_source: '구글시트 원본 전체(' + sheetDeals.length + '건, 실시간 조회)'
        }));
      }
    } catch (e) {
      console.warn('[ai-compare] 구글시트 직접 조회 실패, 요약 컨텍스트로 대체:', e.message);
      // 실패해도 조용히 sysLight로 진행 — 자비스 자체가 멈추지 않도록
    }
  }

  try {
    if (mode === 'news') {
      // ★ 뉴스 검색은 "자비스"(폐쇄형 분석)와 완전히 다른 목적이라 sysLight/sysFull을
      // 쓰지 않고, 지정된 두 언론사 도메인 안에서만 실제로 검색하도록 별도 경로로 처리합니다.
      const result = await callOpenAINews(question, context);
      res.status(200).json({ mode: 'news', result });
      return;
    }
    if (mode === 'drive') {
      // ★ 구글드라이브도 "자비스"와 별개 경로. 서비스 계정으로 공유된 폴더/파일만
      // 조회하며, 그 안의 실제 파일 내용에서만 답을 찾습니다.
      const result = await callGoogleDrive(question, context);
      res.status(200).json({ mode: 'drive', result });
      return;
    }
    if (mode === 'compare') {
      const [openai, gemini, groq] = await Promise.all([callOpenAI(sysFull, askedQuestion), callGemini(sysFull, askedQuestion), callGroq(sysLight, askedQuestion)]);
      let consensus = { ok: false, error: '종합판정을 생성하지 못했습니다.' };
      if (synthesize && (openai.ok || gemini.ok || groq.ok)) {
        const summaryQ =
          '아래는 같은 부동산 자문 질문에 대한 3개 AI의 답변입니다. ' +
          '① 공통 결론 ② 의견이 갈리는 지점 ③ 최종 권고 순서로 한국어로 간결히 정리해줘.\n\n' +
          '[질문]\n' + question + '\n\n' +
          '[GPT]\n' + (openai.text || openai.error) + '\n\n' +
          '[Gemini]\n' + (gemini.text || gemini.error) + '\n\n' +
          '[Groq]\n' + (groq.text || groq.error);
        const c = await callOpenAI(sysFull, summaryQ, true);
        consensus = c.ok ? { ok: true, text: c.text } : { ok: false, error: c.error };
      }
      res.status(200).json({ mode: 'compare', results: { openai, gemini, groq }, consensus });
      return;
    }

    const fn = mode === 'gemini' ? callGemini : mode === 'groq' ? callGroq : callOpenAI;
    const sysForMode = mode === 'groq' ? sysLight : sysFull;
    const result = await fn(sysForMode, askedQuestion);
    res.status(200).json({ mode, result });
  } catch (e) {
    res.status(500).json({ error: e.message || '서버 오류가 발생했습니다.' });
  }
}

// ── 구글시트(Apps Script Web App) 원본을 서버가 직접 조회 ──
// 대시보드가 거래사례를 불러올 때 쓰는 것과 동일한 주소를 그대로 사용합니다.
// 응답 형식: { data: [[...header...], [no, name, addr1, addr2, lat, lng, uc, use,
//   zone, price, gfaP, gfaSqm, gU, gUm, lanP, lanSqm, lU, lUm, ratio, year, date,
//   fav, tags, story, storyEn, curatorUrl, nameEn, rooms], ...] }
var SHEET_COL = {
  name: 1, addr1: 2, use: 7, zone: 8, price: 9, gfaP: 10, gU: 12,
  lanP: 14, lU: 16, ratio: 18, year: 19, date: 20, tags: 22, story: 23
};
async function fetchSheetDeals(appsScriptUrl) {
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;
  try {
    var r = await fetch(appsScriptUrl, controller ? { signal: controller.signal } : undefined);
    if (!r.ok) throw new Error('시트 조회 HTTP ' + r.status);
    var j = await r.json();
    if (j && j.error) throw new Error(j.error);
    var rows = (j && j.data) || [];
    var dataStart = 0;
    for (var i = 0; i < rows.length; i++) {
      if (/^\d+$/.test(String((rows[i] || [])[0] || '').trim())) { dataStart = i; break; }
    }
    var dataRows = rows.slice(dataStart);
    var deals = dataRows.map(function (row) {
      function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[,\s]/g, '')); return isNaN(n) ? 0 : n; }
      var story = String(row[SHEET_COL.story] || '').replace(/<[^>]+>/g, '').trim();
      return {
        name: String(row[SHEET_COL.name] || ''),
        address: String(row[SHEET_COL.addr1] || ''),
        use: String(row[SHEET_COL.use] || ''),
        zone: String(row[SHEET_COL.zone] || ''),
        price_eok: num(row[SHEET_COL.price]),
        gfa_py: num(row[SHEET_COL.gfaP]),
        gfa_unit_price: num(row[SHEET_COL.gU]),
        land_py: num(row[SHEET_COL.lanP]),
        land_unit_price: num(row[SHEET_COL.lU]),
        assessed_value_ratio: num(row[SHEET_COL.ratio]),
        built_year: num(row[SHEET_COL.year]),
        close_date: String(row[SHEET_COL.date] || ''),
        tags: String(row[SHEET_COL.tags] || ''),
        story_summary: story.slice(0, 400)
      };
    }).filter(function (d) { return d.name; });
    // 전체를 다 보내면 토큰이 과도해질 수 있어, 거래금액 상위 60건으로 캡핑
    deals.sort(function (a, b) { return b.price_eok - a.price_eok; });
    return deals.slice(0, 60);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildSystemPrompt(context) {
  var ctxObj = Object.assign({}, context || {});
  var dealsArr = Array.isArray(ctxObj.deals) ? ctxObj.deals : [];
  var names = dealsArr.map(function (d) { return d && d.name; }).filter(Boolean);
  var listingsArr = Array.isArray(ctxObj.sale_listings) ? ctxObj.sale_listings : [];
  var listingNames = listingsArr.map(function (s) { return s && s.name; }).filter(Boolean);
  var allNames = names.concat(listingNames);
  var ctx = JSON.stringify(ctxObj).slice(0, 9000);
  return (
    '당신은 BSKIT DealBook 대시보드 전용 "폐쇄형(closed-book)" 분석 어시스턴트입니다. ' +
    '반드시 아래 JSON 컨텍스트 안의 데이터만 사용해 답하고, 당신이 사전에 학습한 실제 서울 ' +
    '부동산 시장 지식(뉴스로 알려진 매각 사례, 유명 빌딩 거래가 등)은 이 답변에 절대 끌어오지 ' +
    '마세요. 컨텍스트에 포함된 거래사례·매물은 총 ' + allNames.length + '건이며, ' +
    '당신이 답변에서 언급할 수 있는 건물명·매물명은 오직 다음 목록뿐입니다: [' +
    allNames.join(', ') + ']. 이 목록에 없는 건물명·회사명·금액·뉴스는 단 하나도 등장시키지 ' +
    '마세요. 목록 안에서 조건에 맞는 항목을 찾지 못하면 반드시 "제공된 데이터에는 해당 조건에 ' +
    '맞는 거래사례가 없습니다"라고 명확히 밝히되, 거기서 답을 끝내지 말고 가진 데이터 안에서 ' +
    '사용자에게 도움이 될 인접 정보를 이어서 제시하세요. 예를 들어 특정 용도(데이터센터 등) ' +
    '거래가 없으면, 데이터에 있는 용도 구성이 무엇인지·가장 가까운 성격의 거래사례가 무엇인지· ' +
    '전체 시장에서 어떤 특징이 관찰되는지를 구체적 수치와 함께 요약해 주세요. ' +
    '숫자를 인용할 때는 반드시 컨텍스트의 값을 그대로 사용하세요. ' +
    '사용자가 금액·면적 등 특정 조건(예: "500억 미만", "1000평 이상")으로 거래사례를 골라달라고 ' +
    '요청하면, 목록에 넣기 전에 각 항목의 해당 숫자 필드가 그 조건을 실제로 만족하는지 하나씩 ' +
    '반드시 검산하세요. 조건에 맞지 않는 항목은 절대 포함하지 말고, 목록 작성 후에도 한 번 더 ' +
    '전체 항목이 조건을 만족하는지 확인한 다음 답하세요. ' +
    '거래 배경·임대조건·공실률·매수/매도 주체의 의도 같은 정성적 서술은 반드시 각 거래사례의 ' +
    'story_summary 필드에 실제로 적힌 내용에서만 가져오세요. story_summary가 비어있거나 관련 ' +
    '언급이 없으면 그 부분은 지어내지 말고 "스토리 정보 없음"이라고 밝히세요. ' +
    '답변 품질: 뻔한 일반론(예: "시장 유동성을 높인다", "투자자 관심을 유도할 수 있다" 같은 ' +
    '근거 없는 상투어)으로 채우지 말고, 컨텍스트의 구체적 수치(거래금액, 평단가, 공시지가 ' +
    '대비율, 준공년도)를 직접 인용해 왜 그런 결론인지 논리를 보여주세요. 비교 가능한 다른 ' +
    '거래사례가 컨텍스트에 있다면 반드시 함께 인용해 비교하세요. ' +
    '답변 형식: 마크다운 표(|---|---|)나 HTML 태그(<br> 등)는 절대 쓰지 마세요. 이 화면은 ' +
    '일반 텍스트만 표시하므로, 목록은 "- " 글머리 기호와 줄바꿈만 사용해 간결하게 정리하고, ' +
    '강조하고 싶은 부분만 **굵게**로 표시하세요.\n\n' +
    '컨텍스트: ' + ctx
  );
}

async function callOpenAI(sys, question, isSummary) {
  var key = (process.env.OPENAI_API_KEY||"").trim();
  if (!key) return { ok: false, error: 'OPENAI_API_KEY가 서버에 설정되지 않았습니다.', model: 'gpt' };
  try {
    var r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: isSummary ? '당신은 여러 AI 답변을 종합하는 편집자입니다.' : sys },
          { role: 'user', content: question }
        ],
        temperature: 0.3,
        max_tokens: 700
      })
    });
    var j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    var text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '(응답 없음)';
    return { ok: true, text: text, model: 'gpt-4o-mini' };
  } catch (e) {
    return { ok: false, error: e.message, model: 'gpt' };
  }
}

async function callGemini(sys, question) {
  var key = (process.env.GEMINI_API_KEY||"").trim();
  if (!key) return { ok: false, error: 'GEMINI_API_KEY가 서버에 설정되지 않았습니다.', model: 'gemini' };
  try {
    // 무료 티어에서 신규 사용자에게 열려 있는 최신 Flash 모델로 지정합니다.
    // (2.5-flash는 신규 사용자 제한 → 구글 안내에 따라 3.6-flash 사용)
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + key;
    // gemini-3.6-flash는 기본적으로 "내부 추론(thinking)"에 답변 토큰 예산을
    // 먼저 소모합니다. thinkingConfig(thinkingBudget:0) 옵션이 이 모델에서
    // "invalid argument"로 거부되어 아예 실패했던 적이 있어, 옵션은 빼고
    // 상한만 넉넉히(2000) 올려 추론 후에도 답변 쓸 공간을 확보합니다.
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: sys + '\n\n질문: ' + question }] }],
        generationConfig: { maxOutputTokens: 2000 }
      })
    });
    var j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    var cand = (j.candidates && j.candidates[0]) || {};
    var parts = (cand.content && cand.content.parts) || [];
    var text = parts.map(function (p) { return p.text || ''; }).join('');
    if (!text) text = '(응답 없음' + (cand.finishReason ? ' · 종료사유: ' + cand.finishReason : '') + ')';
    return { ok: true, text: text, model: 'gemini-3.6-flash' };
  } catch (e) {
    return { ok: false, error: e.message, model: 'gemini' };
  }
}

async function callGroq(sys, question) {
  var key = (process.env.GROQ_API_KEY||"").trim();
  if (!key) return { ok: false, error: 'GROQ_API_KEY가 서버에 설정되지 않았습니다.', model: 'groq' };
  try {
    // Groq는 OpenAI 호환 엔드포인트를 제공하며, 완전 무료 티어(카드 등록 불필요)입니다.
    // 모델 목록: https://console.groq.com/docs/models  (지원 종료 확인: /docs/deprecations)
    // gpt-oss 계열은 "추론(reasoning) 모델"이라 max_tokens 예산을 추론에 먼저
    // 쓰고 나면 실제 답변이 비어버릴 수 있습니다. reasoning_effort를 낮추고
    // max_tokens을 넉넉히 줘서 답변까지 여유를 확보합니다.
    var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: question }
        ],
        temperature: 0.3,
        max_tokens: 900,
        reasoning_effort: 'low'
      })
    });
    var j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    var choice = (j.choices && j.choices[0]) || {};
    var text = (choice.message && choice.message.content) || '';
    if (!text) text = '(응답 없음' + (choice.finish_reason ? ' · 종료사유: ' + choice.finish_reason : '') + ')';
    return { ok: true, text: text, model: 'gpt-oss-20b (Groq)' };
  } catch (e) {
    return { ok: false, error: e.message, model: 'groq' };
  }
}

// ── 뉴스 검색: OpenAI Responses API의 내장 web_search 도구 +
//    allowed_domains 필터로 dealbook.co.kr · thebell.co.kr 두 곳만 검색합니다.
//    "자비스"(폐쇄형 분석)와 달리 이 모드는 일부러 외부 인터넷을 봅니다.
var NEWS_DOMAINS = ['dealbook.co.kr', 'thebell.co.kr'];
async function callOpenAINews(question, context) {
  var key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'OPENAI_API_KEY가 서버에 설정되지 않았습니다.', model: 'news' };

  var selected = context && context.selected_deal;
  var hint = selected && selected.name
    ? ('참고로 사용자가 대시보드에서 보고 있는 거래사례는 "' + selected.name + '"' +
       (selected.address ? ' (' + selected.address + ')' : '') + '입니다. 관련성이 있을 때 검색어에 포함하세요.\n\n')
    : '';
  var newsSys =
    '당신은 한국 상업용 부동산 전문 뉴스 리서치 어시스턴트입니다. ' +
    '검색 결과 중 dealbook.co.kr(딜북)과 thebell.co.kr(더벨) 기사만 최종 근거로 사용하세요. ' +
    '다른 도메인이 검색되더라도 답변 근거로 채택하지 마세요. 관련 기사가 없으면 솔직하게 없다고 말하세요. ' +
    '답변 끝에는 실제로 참고한 기사 제목과 링크를 - 글머리로 적으세요.';

  var preferredModel = (process.env.OPENAI_NEWS_MODEL || 'gpt-5.4-mini').trim();
  var fallbackModel = (process.env.OPENAI_NEWS_FALLBACK_MODEL || 'gpt-4o-mini').trim();

  try {
    return await runNewsResponse(preferredModel, true, key, newsSys, hint + question);
  } catch (e1) {
    var msg = String(e1 && e1.message || e1);
    var filterRelated = /filters|allowed_domains|web_search.*not supported|invalid.*tool/i.test(msg);
    if (!filterRelated) return { ok: false, error: msg, model: 'news' };
    try {
      return await runNewsResponse(fallbackModel, false, key, newsSys, hint + question);
    } catch (e2) {
      return { ok: false, error: String(e2 && e2.message || e2), model: 'news' };
    }
  }
}

async function runNewsResponse(model, useFilters, key, systemText, userText) {
  var tool = { type: 'web_search' };
  if (useFilters) tool.filters = { allowed_domains: NEWS_DOMAINS };
  var r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: model,
      input: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText }
      ],
      tools: [tool],
      tool_choice: 'auto',
      max_output_tokens: 1400
    })
  });
  var j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));

  var textParts = [];
  var sources = [];
  var didSearch = false;
  (j.output || []).forEach(function (item) {
    if (item && (item.type === 'web_search_call' || item.type === 'web_search')) didSearch = true;
    (item && item.content || []).forEach(function (c) {
      if (c && c.text) textParts.push(c.text);
      (c && c.annotations || []).forEach(function (a) {
        if (a && a.url) sources.push({ url: a.url, title: a.title || a.url });
      });
    });
  });
  var text = String(j.output_text || textParts.join('\n') || '').trim();
  if (!text) text = didSearch ? '딜북·더벨에서 검색했지만 관련 기사를 찾지 못했습니다.' : '웹 검색이 실행되지 않았습니다.';

  var seen = {};
  var allowed = sources.filter(function (s) {
    try {
      var host = new URL(s.url).hostname.toLowerCase().replace(/^www\./, '');
      if (NEWS_DOMAINS.indexOf(host) < 0) return false;
      if (seen[s.url]) return false;
      seen[s.url] = 1;
      return true;
    } catch (e) { return false; }
  }).slice(0, 6);
  if (allowed.length) {
    text += '\n\n[참고 기사]\n' + allowed.map(function (s) { return '- ' + s.title + ' — ' + s.url; }).join('\n');
  } else if (didSearch) {
    text += '\n\n[참고 기사]\n- 딜북·더벨 도메인에서 인용 가능한 링크를 확인하지 못했습니다.';
  }
  return { ok: true, text: text, model: model + ' + web_search' + (useFilters ? ' (도메인필터)' : ' (후처리필터)') };
}

// ══════════════════════════════════════════════════════════
// 구글 드라이브 연동 — 서비스 계정(Service Account) 방식
// 사용자가 매번 로그인/동의하는 OAuth 대신, "이 서비스 계정 이메일에게
// 폴더를 공유"만 해두면 서버가 조용히 접근합니다(1회 설정).
// 필요한 환경변수:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   서비스 계정 이메일 (xxx@xxx.iam.gserviceaccount.com)
//   GOOGLE_SERVICE_ACCOUNT_KEY     서비스 계정 비공개 키(PEM, JSON 키 파일의 private_key 값)
//   GOOGLE_DRIVE_FOLDER_ID         (선택) 검색을 제한할 폴더 ID. 비우면 공유된 전체 파일 검색
// ══════════════════════════════════════════════════════════
var _driveToken = null, _driveTokenExp = 0;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function driveAuth() {
  var email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  // Vercel 환경변수에 여러 줄 PEM 키를 붙여넣으면 개행이 리터럴 "\n" 문자열로
  // 저장되는 경우가 많아, 실제 개행 문자로 되돌려줍니다.
  var pkey = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim().replace(/\\n/g, '\n');
  if (!email || !pkey) return Promise.reject(new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_KEY가 서버에 설정되지 않았습니다.'));
  if (_driveToken && Date.now() < _driveTokenExp) return Promise.resolve(_driveToken);

  var crypto = require('crypto');
  var now = Math.floor(Date.now() / 1000);
  var header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  var unsigned = header + '.' + claim;
  var signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  var signature;
  try {
    signature = signer.sign(pkey, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) {
    return Promise.reject(new Error('서비스 계정 비공개 키 형식이 올바르지 않습니다: ' + e.message));
  }
  var jwt = unsigned + '.' + signature;

  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res2) {
      if (!res2.ok || !res2.j.access_token) throw new Error((res2.j && res2.j.error_description) || (res2.j && res2.j.error) || 'Drive 인증 실패');
      _driveToken = res2.j.access_token;
      _driveTokenExp = Date.now() + (Number(res2.j.expires_in || 3500) - 60) * 1000;
      return _driveToken;
    });
}

function normalizeDriveFolderId(raw) {
  var v = String(raw || '').trim();
  if (!v || v === '.' || v === '/' || v.toLowerCase() === 'root') return '';
  var m = v.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  var m2 = v.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];
  return v;
}

function driveListRequest(token, q, pageSize) {
  var url = 'https://www.googleapis.com/drive/v3/files?' +
    'q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,mimeType,webViewLink,modifiedTime,parents),nextPageToken') +
    '&pageSize=' + (pageSize || 100) +
    '&orderBy=modifiedTime desc&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true';
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res2) {
      if (!res2.ok) throw new Error((res2.j && res2.j.error && res2.j.error.message) || 'Drive 목록 조회 실패');
      return (res2.j && res2.j.files) || [];
    });
}

async function driveListTree(token, folderId, maxDepth, maxFiles) {
  var files = [], queue = [{ id: folderId, depth: 0 }], seenFolders = {};
  maxDepth = maxDepth == null ? 3 : maxDepth;
  maxFiles = maxFiles || 160;
  while (queue.length && files.length < maxFiles) {
    var cur = queue.shift();
    if (seenFolders[cur.id]) continue;
    seenFolders[cur.id] = 1;
    var children = await driveListRequest(token, "'" + cur.id.replace(/'/g, "\\'") + "' in parents and trashed = false", 100);
    children.forEach(function (f) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (cur.depth < maxDepth) queue.push({ id: f.id, depth: cur.depth + 1 });
      } else if (files.length < maxFiles) files.push(f);
    });
  }
  return files;
}

function driveTerms(query, context) {
  var extra = [];
  var sd = context && context.selected_deal;
  var sl = context && context.selected_listing;
  if (sd) extra.push(sd.name, sd.address);
  if (sl) extra.push(sl.name, sl.address);
  var raw = [query].concat(extra).filter(Boolean).join(' ');
  var stop = { '현재':1,'선택한':1,'거래사례':1,'매매사례':1,'매물':1,'관련':1,'문서':1,'자료':1,'분석':1,'해주세요':1,'찾아줘':1,'찾아':1,'대해':1 };
  var toks = raw.replace(/[()\[\]{},.:;!?/\\]/g, ' ').split(/\s+/).map(function (t) { return t.trim(); })
    .filter(function (t) { return t.length >= 2 && !stop[t]; });
  var seen = {};
  return toks.filter(function (t) { var k=t.toLowerCase(); if(seen[k])return false; seen[k]=1; return true; }).slice(0, 10);
}

function scoreTextByTerms(text, terms) {
  var s = String(text || '').toLowerCase(), score = 0;
  terms.forEach(function (t) {
    var q = String(t).toLowerCase();
    if (!q) return;
    if (s.indexOf(q) >= 0) score += q.length >= 5 ? 5 : 3;
  });
  return score;
}

async function driveSearchFiles(token, query, context) {
  var folderId = normalizeDriveFolderId(process.env.GOOGLE_DRIVE_FOLDER_ID || '');
  var all;
  if (folderId) all = await driveListTree(token, folderId, 3, 160);
  else all = await driveListRequest(token, "trashed = false and mimeType != 'application/vnd.google-apps.folder'", 100);
  var terms = driveTerms(query, context);
  all.forEach(function (f) { f._nameScore = scoreTextByTerms(f.name, terms) * 3; });
  all.sort(function (a, b) {
    if (b._nameScore !== a._nameScore) return b._nameScore - a._nameScore;
    return String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''));
  });
  return all.slice(0, 16);
}

var DRIVE_EXPORTABLE = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain'
};
function driveFetchFileText(token, file) {
  var exportMime = DRIVE_EXPORTABLE[file.mimeType];
  var url = exportMime
    ? 'https://www.googleapis.com/drive/v3/files/' + file.id + '/export?mimeType=' + encodeURIComponent(exportMime)
    : (file.mimeType === 'text/plain' || file.mimeType === 'text/csv')
      ? 'https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media'
      : null;
  if (!url) {
    // PDF·이미지·워드 등은 이 경량 서버에서 텍스트 추출이 어려워, 파일명/링크만 제공합니다.
    return Promise.resolve('(이 파일 형식은 내용 미리보기를 지원하지 않습니다 — 링크로 직접 확인해 주세요)');
  }
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.ok ? r.text() : Promise.resolve(''); })
    .catch(function () { return ''; });
}

async function callGoogleDrive(question, context) {
  try {
    var token = await driveAuth();
    var candidates = await driveSearchFiles(token, question, context);
    if (!candidates.length) {
      var folderId = normalizeDriveFolderId(process.env.GOOGLE_DRIVE_FOLDER_ID || '');
      return { ok: true, text: folderId
        ? '연결된 구글드라이브 폴더에서 파일을 찾지 못했습니다. 서비스 계정에 해당 폴더가 뷰어 이상으로 공유되어 있는지 확인해 주세요.'
        : '서비스 계정이 읽을 수 있는 구글드라이브 파일을 찾지 못했습니다. 검색할 폴더를 서비스 계정 이메일에 공유해 주세요.', model: 'Google Drive' };
    }

    var inspect = candidates.slice(0, 10);
    var texts = await Promise.all(inspect.map(function (f) { return driveFetchFileText(token, f); }));
    var terms = driveTerms(question, context);
    var ranked = inspect.map(function (f, i) {
      return { file: f, text: String(texts[i] || ''), score: (f._nameScore || 0) + scoreTextByTerms(texts[i], terms) };
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.file.modifiedTime || '').localeCompare(String(a.file.modifiedTime || ''));
    });
    var top = ranked.slice(0, 5);

    var docsBlock = top.map(function (x) {
      return '[파일: ' + x.file.name + ']\n' + (x.text || '(본문 미리보기 미지원)');
    }).join('\n\n---\n\n').slice(0, 14000);

    var sys =
      '당신은 BSKIT DealBook의 구글드라이브 문서 검색 어시스턴트입니다. ' +
      '아래 [문서]에서 확인되는 사실만 근거로 한국어로 답하고, 문서에 없는 내용은 추측하지 마세요. ' +
      '질문과 직접 관련도가 낮은 파일은 배제하세요. 표 대신 - 글머리 기호를 사용하세요.\n\n[문서]\n' + docsBlock;

    var key = (process.env.OPENAI_API_KEY || '').trim();
    if (!key) {
      var rawLines = top.map(function (x) { return '- ' + x.file.name + ' — ' + (x.file.webViewLink || ''); });
      return { ok: true, text: '구글드라이브에서 관련 가능성이 높은 파일을 찾았습니다. AI 요약은 OPENAI_API_KEY가 없어 생략합니다.\n\n' + rawLines.join('\n'), model: 'Google Drive 검색' };
    }

    var driveModel = (process.env.OPENAI_DRIVE_MODEL || 'gpt-4o-mini').trim();
    var r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: driveModel,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: question }],
        temperature: 0.2,
        max_tokens: 900
      })
    });
    var j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    var text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '(응답 없음)';
    var linkLines = top.map(function (x) { return '- ' + x.file.name + ' — ' + (x.file.webViewLink || ''); });
    text += '\n\n[참고 파일]\n' + linkLines.join('\n');
    return { ok: true, text: text, model: 'Google Drive + ' + driveModel + ' (' + top.length + '개 후보)' };
  } catch (e) {
    var msg = String(e && e.message || e);
    if (/File not found:\s*\./i.test(msg)) msg = 'GOOGLE_DRIVE_FOLDER_ID 값이 잘못되었습니다. 점(.) 대신 실제 폴더 ID/폴더 URL을 넣거나 환경변수를 비워 주세요.';
    return { ok: false, error: msg, model: 'drive' };
  }
}

