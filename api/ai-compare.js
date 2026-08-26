// api/ai-compare.js
// BSKIT DealBook의 "BSKIT AI Analyst"가 호출하는 백엔드.
// API 키(OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY)는 절대 대시보드
// HTML에 넣지 않고, 이 서버(Vercel 프로젝트)의 환경변수로만 보관합니다.
//
// 대시보드 CONFIG.AI_COMPARE_ENDPOINT 에는 이 함수가 배포된 주소를 넣습니다.
// 예) https://bskit-backend.vercel.app/api/ai-compare

module.exports = async function handler(req, res) {
  // 티스토리(외부 도메인)에서 오는 요청을 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST 요청만 허용됩니다.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { mode = 'openai', question = '', context = {}, synthesize = false } = body || {};

  if (!question.trim()) { res.status(400).json({ error: 'question(질문)이 비어 있습니다.' }); return; }

  // ★ 선택된 거래사례가 있으면, 질문 맨 앞에 "분석 대상"으로 못박아 모델이 다른
  // 거래사례로 새지 않도록 합니다. (예: 광화문G스퀘어를 물었는데 G1서울을 분석하는 문제 방지)
  var sel0 = context && context.selected_deal;
  var focusLine = '';
  if (sel0 && sel0.name) {
    focusLine =
      '★ 지금 분석 대상은 오직 "' + sel0.name + '"' + (sel0.address ? ' (' + sel0.address + ')' : '') +
      ' 한 건입니다. 질문이 이 거래사례를 가리키므로, 이 건물을 중심으로 답하세요. ' +
      '다른 거래사례(예: 목록 상위의 대형 거래)를 대신 분석하지 마세요. ' +
      '비교가 필요할 때만 다른 사례를 보조로 인용하고, 주어는 항상 "' + sel0.name + '"여야 합니다.\n\n';
  }

  // ★ 시스템 프롬프트뿐 아니라 사용자 질문 바로 앞에도 같은 지시를 한 번 더 붙입니다.
  // 모델이 대화의 뒷부분(최신 지시)을 더 강하게 따르는 경향이 있어, 이중 안전장치입니다.
  const askedQuestion =
    focusLine +
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
  var sel = ctxObj.selected_deal;
  var focusLine = (sel && sel.name)
    ? ('■ 현재 사용자가 대시보드에서 선택한 분석 대상은 "' + sel.name + '"' +
       (sel.address ? ' (' + sel.address + ')' : '') + ' 입니다. 질문에 특정 건물이 명시되지 ' +
       '않으면 이 거래사례를 대상으로 답하세요. 다른 건물을 주어로 삼지 마세요. ')
    : '';
  var ctx = JSON.stringify(ctxObj).slice(0, 9000);
  return (
    focusLine +
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
  try {
    var selected = context && context.selected_deal;
    var hint = selected && selected.name
      ? ('참고로 사용자가 대시보드에서 보고 있는 거래사례는 "' + selected.name + '"' +
         (selected.address ? ' (' + selected.address + ')' : '') + '입니다. 관련이 있다면 검색어에 참고하세요.\n\n')
      : '';
    var newsSys =
      '당신은 한국 상업용 부동산·M&A 전문 뉴스 리서치 어시스턴트입니다. ' +
      '반드시 검색 도구로 찾은 dealbook.co.kr, thebell.co.kr 두 사이트의 실제 기사 내용만 ' +
      '근거로 답하세요. 검색 결과에 없는 내용은 추측하지 말고 "관련 기사를 찾지 못했습니다"라고 ' +
      '답하세요. 답변 끝에는 참고한 기사 제목과 링크를 목록으로 정리하세요. 마크다운 표나 ' +
      'HTML 태그는 쓰지 말고 "- " 글머리 기호만 사용하세요.';

    var r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: [
          { role: 'system', content: newsSys },
          { role: 'user', content: hint + question }
        ],
        tools: [{ type: 'web_search', filters: { allowed_domains: NEWS_DOMAINS } }],
        tool_choice: 'required',
        max_output_tokens: 1500
      })
    });
    var j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));

    var text = j.output_text || '';
    var sources = [];
    var didSearch = false;
    (j.output || []).forEach(function (item) {
      if (item && (item.type === 'web_search_call' || item.type === 'web_search')) didSearch = true;
      (item && item.content || []).forEach(function (c) {
        if (c && c.text && !text) text += c.text;
        (c && c.annotations || []).forEach(function (a) {
          if (a && a.url) sources.push({ url: a.url, title: a.title || a.url });
        });
      });
    });
    if (!text) {
      text = didSearch
        ? '(딜북·더벨에서 검색은 했지만 관련 기사를 찾지 못했습니다.)'
        : '(웹 검색이 실행되지 않았습니다. OpenAI 계정에서 web_search 도구 사용이 제한되었을 수 있습니다.)';
    }
    if (sources.length) {
      var seen = {};
      var lines = sources.filter(function (s) { if (seen[s.url]) return false; seen[s.url] = 1; return true; })
        .slice(0, 6)
        .map(function (s) { return '- ' + s.title + ' — ' + s.url; });
      text += '\n\n[참고 기사]\n' + lines.join('\n');
    }
    return { ok: true, text: text, model: 'gpt-4o-mini + web_search' + (didSearch ? ' ✓검색함' : ' ✗검색안함') };
  } catch (e) {
    return { ok: false, error: e.message, model: 'news' };
  }
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

// 질문·거래사례에서 검색에 쓸 핵심 키워드를 뽑습니다. "분석","정리","의견" 같은
// 명령/불용어는 제거해, 파일 매칭을 방해하지 않도록 합니다.
var DRIVE_STOPWORDS = ['분석','정리','요약','해줘','해주세요','알려줘','관련','문서','자료','내용','최근','대해','대한','에서','전문가','의견','리포트','레포트','보고서','찾아','검색','있는','있나','대상','현재','선택','매매','사례','거래','매물','비교','포함','시장'];
function driveKeywords(question, context) {
  var terms = [];
  var sel = context && context.selected_deal;
  if (sel) {
    // 거래사례명(핵심 명사)·주소의 동/구를 우선 검색어로 사용
    if (sel.name) String(sel.name).split(/[\s()·,]+/).forEach(function (t) { if (t && t.length >= 2) terms.push(t); });
    if (sel.address) {
      var m = String(sel.address).match(/([가-힣]+동|[가-힣]+구|[가-힣0-9-]+가|[가-힣]+로)/g);
      if (m) m.forEach(function (t) { terms.push(t); });
    }
  }
  // 질문에서 불용어를 뺀 의미 있는 단어 보강
  String(question || '').split(/[\s,()·.]+/).forEach(function (t) {
    if (t && t.length >= 2 && DRIVE_STOPWORDS.indexOf(t) < 0 && terms.indexOf(t) < 0) terms.push(t);
  });
  // 중복 제거 + 상위 8개
  var seen = {}, out = [];
  terms.forEach(function (t) { var k = t.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(t); } });
  return out.slice(0, 8);
}

function driveListAll(token) {
  var folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  var q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  if (folderId) q += " and '" + folderId + "' in parents";
  var url = 'https://www.googleapis.com/drive/v3/files?' +
    'q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,mimeType,webViewLink,modifiedTime)') +
    '&pageSize=50&orderBy=modifiedTime desc';
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res2) {
      if (!res2.ok) throw new Error((res2.j && res2.j.error && res2.j.error.message) || 'Drive 목록 실패');
      return (res2.j && res2.j.files) || [];
    });
}

function driveSearchFiles(token, terms) {
  var folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  var use = (terms || []).slice(0, 6);
  var qParts = use.map(function (t) {
    var esc = t.replace(/'/g, "\\'");
    return "(name contains '" + esc + "' or fullText contains '" + esc + "')";
  });
  var q = qParts.length ? '(' + qParts.join(' or ') + ')' : "mimeType != 'application/vnd.google-apps.folder'";
  q += " and trashed = false";
  if (folderId) q += " and '" + folderId + "' in parents";
  var url = 'https://www.googleapis.com/drive/v3/files?' +
    'q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,mimeType,webViewLink,modifiedTime)') +
    '&pageSize=15&orderBy=modifiedTime desc';
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res2) {
      if (!res2.ok) throw new Error((res2.j && res2.j.error && res2.j.error.message) || 'Drive 검색 실패');
      return (res2.j && res2.j.files) || [];
    });
}

// 파일명이 검색어와 얼마나 겹치는지 점수화(정밀 매칭 우선순위 결정용)
function scoreByName(files, terms) {
  var lower = (terms || []).map(function (t) { return t.toLowerCase(); });
  files.forEach(function (f) {
    var nm = String(f.name || '').toLowerCase();
    f._score = lower.reduce(function (s, t) { return s + (nm.indexOf(t) >= 0 ? 1 : 0); }, 0);
  });
  files.sort(function (a, b) { return (b._score || 0) - (a._score || 0); });
  return files;
}

// 후보가 많고 파일명 점수로 확실히 못 고를 때, LLM에게 파일명 목록만 주고 고르게 함
async function drivePickFileByLLM(token, question, context, files) {
  var key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return 0;
  var sel = context && context.selected_deal;
  var ctxLine = sel
    ? ('선택된 거래사례: ' + (sel.name || '') + (sel.address ? ' / ' + sel.address : ''))
    : '선택된 거래사례 없음';

  // Google 문서·시트·txt는 본문 앞부분(스니펫)을 붙여 판단 정확도를 높입니다.
  // (PDF는 여기서 본문 추출이 비싸 파일명만 사용 — fullText 검색으로 이미 후보에 든 상태)
  var snippets = await Promise.all(files.map(function (f) {
    var canText = !!DRIVE_EXPORTABLE[f.mimeType] || f.mimeType === 'text/plain' || f.mimeType === 'text/csv';
    if (!canText) return Promise.resolve('');
    return driveFetchFileText(token, f).then(function (t) {
      return String(t || '').replace(/\s+/g, ' ').slice(0, 300);
    }).catch(function () { return ''; });
  }));

  var list = files.map(function (f, i) {
    return i + '. ' + f.name + (snippets[i] ? '\n   내용발췌: ' + snippets[i] : '');
  }).join('\n');

  try {
    var r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: '아래 파일 목록(파일명과 일부 내용발췌)에서 사용자의 질문·선택된 거래사례에 ' +
            '가장 관련 높은 파일 1개의 번호만 숫자로 답하세요. 파일명에 건물명이 없더라도 ' +
            '내용발췌에 관련 내용이 있으면 그 파일을 고르세요. 관련된 파일이 하나도 없으면 -1만 ' +
            '답하세요. 다른 말은 절대 하지 마세요.\n\n' +
            ctxLine + '\n\n[파일 목록]\n' + list
        }, { role: 'user', content: question }],
        temperature: 0, max_tokens: 5
      })
    });
    var j = await r.json();
    var raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '0';
    var idx = parseInt(String(raw).replace(/[^0-9-]/g, ''), 10);
    if (isNaN(idx)) return 0;
    return idx;
  } catch (e) { return 0; }
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

// 드라이브에서 파일 원본 바이트를 base64로 받아옵니다(PDF·이미지 등 Gemini 직접 전달용).
async function driveFetchFileBytes(token, fileId) {
  var r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) throw new Error('파일 다운로드 실패 (HTTP ' + r.status + ')');
  var buf = await r.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

// PDF/이미지 파일을 Gemini에 통째로 넘겨 분석(표·차트 포함 네이티브 이해).
async function analyzePdfWithGemini(question, file, base64Data, mimeType) {
  var key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'GEMINI_API_KEY가 없어 PDF 분석을 할 수 없습니다.', model: 'drive' };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + key;
  var sys =
    '당신은 상업용 부동산 리서치 어시스턴트입니다. 첨부한 문서("' + file.name + '")의 실제 내용만 ' +
    '근거로 한국어로 답하세요. 문서에 없는 내용은 추측하지 말고 "문서에서 확인되지 않습니다"라고 ' +
    '밝히세요. 표·수치는 문서의 값을 그대로 인용하세요. 마크다운 표나 HTML 태그는 쓰지 말고 ' +
    '"- " 글머리 기호만 사용하세요.';
  var r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: sys + '\n\n질문: ' + question },
          { inline_data: { mime_type: mimeType || 'application/pdf', data: base64Data } }
        ]
      }],
      generationConfig: { maxOutputTokens: 2000 }
    })
  });
  var j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Gemini HTTP ' + r.status));
  var cand = (j.candidates && j.candidates[0]) || {};
  var parts = (cand.content && cand.content.parts) || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) text = '(응답 없음' + (cand.finishReason ? ' · 종료사유: ' + cand.finishReason : '') + ')';
  return { ok: true, text: text, model: 'gemini-3.6-flash + PDF 직접분석' };
}

async function callGoogleDrive(question, context) {
  try {
    var token = await driveAuth();

    // 검색어를 "선택한 거래사례 + 질문 핵심어"에서 추출(명령어·불용어 제거)
    var terms = driveKeywords(question, context);

    // 1단계: 정밀 검색 — 파일명 OR 본문(fullText)에 건물명 키워드가 든 파일.
    // Drive의 fullText는 PDF 내용까지 색인하므로, 파일명에 건물명이 없어도
    // 본문에 건물명이 있으면 여기서 잡힙니다.
    var files = terms.length ? await driveSearchFiles(token, terms) : [];
    files = scoreByName(files, terms);

    var picked = null;
    if (files.length === 1) {
      picked = files[0];
    } else if (files.length > 1 && files[0]._score > 0 && files[0]._score > (files[1]._score || 0)) {
      // 파일명 매칭이 명확히 1등이면 그대로 사용
      picked = files[0];
    } else if (files.length > 1) {
      // 파일명만으로 못 고르면(본문으로만 매칭된 경우 포함) 스니펫 보고 LLM이 선택
      var idxA = await drivePickFileByLLM(token, question, context, files.slice(0, 12));
      picked = (idxA >= 0) ? files[idxA] : files[0];
    }

    if (!picked) {
      // 2단계: 검색으로 아무것도 못 찾으면 폴더 전체를 훑어 LLM이 관련 파일을 고름
      var all = await driveListAll(token);
      if (!all.length) {
        return { ok: true, text: '연결된 구글드라이브 폴더에 분석할 파일이 없습니다. 폴더 공유와 GOOGLE_DRIVE_FOLDER_ID 설정을 확인해 주세요.', model: 'Google Drive' };
      }
      var candidates = all.slice(0, 25);
      var idx = await drivePickFileByLLM(token, question, context, candidates);
      if (idx < 0) {
        var listLines = candidates.slice(0, 10).map(function (f) { return '- ' + f.name + ' — ' + (f.webViewLink || ''); });
        return {
          ok: true, model: 'Google Drive',
          text: '질문·선택한 거래사례와 뚜렷하게 관련된 문서를 폴더에서 찾지 못했습니다. ' +
            '폴더에 있는 문서 목록은 아래와 같습니다. 분석하고 싶은 문서명을 질문에 포함해 다시 요청해 주세요.\n\n' +
            listLines.join('\n')
        };
      }
      picked = candidates[idx] || candidates[0];
      files = candidates;
    }

    var file = picked;
    var isGoogleDoc = !!DRIVE_EXPORTABLE[file.mimeType];
    var isPlainText = (file.mimeType === 'text/plain' || file.mimeType === 'text/csv');
    var isPdfOrImage = (file.mimeType === 'application/pdf' || /^image\//.test(file.mimeType || ''));

    var result;
    if (isPdfOrImage) {
      // PDF·이미지 → Gemini에 통째로 전달 (표·레이아웃까지 이해)
      var b64 = await driveFetchFileBytes(token, file.id);
      // Gemini inline_data는 요청 20MB 제한. base64는 원본의 약 1.33배이므로
      // 대략 원본 14MB(=base64 약 19MB) 초과 시 안내로 대체합니다.
      if (b64.length > 19000000) {
        result = { ok: true, model: 'Google Drive',
          text: '이 PDF("' + file.name + '")는 용량이 커서 자동 분석 한도(약 14MB)를 초과했습니다. ' +
                '아래 링크로 직접 열어 확인해 주세요. 필요하시면 문서를 나눠서 올려주시면 분석할 수 있습니다.' };
      } else {
        result = await analyzePdfWithGemini(question, file, b64, file.mimeType);
      }
    } else if (isGoogleDoc || isPlainText) {
      // Google 문서·시트·텍스트 → 텍스트 추출 후 GPT로 분석
      var text = await driveFetchFileText(token, file);
      var sys =
        '당신은 BSKIT DealBook의 구글드라이브 문서 분석 어시스턴트입니다. 아래 [문서]("' + file.name +
        '") 내용에서 확인되는 사실만 근거로 한국어로 답하고, 없는 내용은 추측하지 말고 "문서에서 ' +
        '확인되지 않습니다"라고 밝히세요. 마크다운 표나 HTML 태그는 쓰지 말고 "- " 글머리 기호만 ' +
        '사용하세요.\n\n[문서]\n' + String(text || '').slice(0, 8000);
      var key = (process.env.OPENAI_API_KEY || '').trim();
      if (!key) return { ok: false, error: 'OPENAI_API_KEY가 서버에 설정되지 않았습니다.', model: 'drive' };
      var r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: question }],
          temperature: 0.2, max_tokens: 1200
        })
      });
      var j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
      var ans = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '(응답 없음)';
      result = { ok: true, text: ans, model: 'gpt-4o-mini + Google 문서' };
    } else {
      // 워드(docx) 등 이 서버가 직접 못 읽는 형식
      result = { ok: true, text: '이 파일 형식(' + (file.mimeType || '알수없음') + ')은 아직 자동 분석을 지원하지 않습니다. 아래 링크로 직접 확인해 주세요.\nPDF·이미지·Google 문서·스프레드시트는 분석 가능합니다.', model: 'Google Drive' };
    }

    // 분석한 파일을 맨 위(★)에, 그 외 후보를 이어서 표시
    var others = files.filter(function (f) { return f.id !== file.id; }).slice(0, 4);
    var refLines = ['- ★ ' + file.name + ' — ' + (file.webViewLink || '')]
      .concat(others.map(function (f) { return '- ' + f.name + ' — ' + (f.webViewLink || ''); }));
    result.text = (result.text || '') + '\n\n[분석한 파일 ★ / 그 외 후보]\n' + refLines.join('\n');
    return result;
  } catch (e) {
    return { ok: false, error: e.message, model: 'drive' };
  }
}
