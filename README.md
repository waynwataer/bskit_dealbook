# BSKIT DealBook 백엔드 (3AI 비교 + 직장인구 프록시)

BSKIT DealBook 대시보드의 두 기능을 실제로 동작시키기 위한 최소 백엔드입니다.

- `api/ai-compare.js` — GPT · Gemini · Claude 3AI 비교 분석
- `api/workplace-population.js` — 통계청 SGIS 직장인구(종사자수) 프록시

두 함수 모두 **API 키를 서버 환경변수로만 사용**하므로, 대시보드 HTML에는 어떤 키도
들어가지 않습니다.

---

## 1. 배포하기 (Vercel, 무료 플랜으로 충분)

### 방법 A — GitHub 연동 (권장)
1. 이 폴더(`bskit-backend`)를 본인 GitHub 저장소로 올립니다.
2. https://vercel.com 가입 → **Add New → Project** → 방금 만든 저장소 선택 → **Deploy**
   (Framework Preset은 "Other"로 두면 됩니다. 별도 빌드 설정이 필요 없습니다.)
3. 배포가 끝나면 `https://프로젝트이름.vercel.app` 형태의 주소가 발급됩니다.

### 방법 B — Vercel CLI로 바로 배포
```bash
npm i -g vercel
cd bskit-backend
vercel        # 최초 1회, 안내에 따라 로그인/프로젝트 생성
vercel --prod # 운영 배포
```

## 2. 환경변수 등록

Vercel 프로젝트 → **Settings → Environment Variables**에서 아래 값을 등록하세요.
(전부 채울 필요는 없습니다 — 없는 항목은 해당 AI만 "미설정"으로 표시되고, 나머지는 정상 동작합니다.)

| 변수명 | 용도 | 발급처 |
|---|---|---|
| `OPENAI_API_KEY` | GPT 비교 분석 | https://platform.openai.com/api-keys |
| `GEMINI_API_KEY` | Gemini 비교 분석 (무료 티어: gemini-3.6-flash) | https://aistudio.google.com/app/apikey |
| `GROQ_API_KEY` | Groq 비교 분석 (완전 무료, 카드 등록 불필요, gpt-oss-20b) | https://console.groq.com/keys |
| `SGIS_CONSUMER_KEY` | 직장인구(SGIS) 조회 | https://sgis.mods.go.kr (2025-10 국가데이터처로 이전) → 개발지원센터에서 발급 |
| `SGIS_CONSUMER_SECRET` | 직장인구(SGIS) 조회 | 위와 동일 발급 화면 |
| `SGIS_STATS_YEAR` (선택) | 전국사업체조사 기준년도 | 기본값 `2023`, SGIS 개발자센터에서 최신 연도 확인 |

> **참고 — 안전한 무료 조합**: `GEMINI_API_KEY`와 `GROQ_API_KEY`는 신용카드 등록 없이
> 발급됩니다. 예상치 못한 청구를 원천 차단하고 싶으시면 이 둘만 등록하고 `OPENAI_API_KEY`는
> 비워두셔도 됩니다 — GPT 항목만 "미설정"으로 표시되고 Gemini·Groq·3AI 비교(2개 기준)는
> 정상 동작합니다.

환경변수를 추가/수정한 뒤에는 **Redeploy**를 한 번 눌러야 반영됩니다.

## 3. 대시보드에 연결하기

`dealbook_*.html` 파일 상단 `CONFIG` 블록을 아래처럼 채우고 다시 저장/게시하세요.

```js
var CONFIG = {
  ...
  AI_COMPARE_ENDPOINT: 'https://프로젝트이름.vercel.app/api/ai-compare',
  WORKPLACE_POP_PROXY_ENDPOINT: 'https://프로젝트이름.vercel.app/api/workplace-population',
  ...
};
```

- `AI_COMPARE_ENDPOINT`를 넣으면 우측 하단 **BSKIT AI Analyst** 버튼과 지도 팝업의
  **🤖 AI 분석** 버튼이 바로 동작합니다.
- `WORKPLACE_POP_PROXY_ENDPOINT`를 넣으면 지도의 **직장인구** 체크박스가 SGIS 데이터를
  자동으로 불러옵니다. (이 값이 있으면 `SGIS_CONSUMER_KEY`를 대시보드 HTML에 직접
  넣을 필요가 없습니다 — 서버에만 있으면 됩니다.)

## 4. 동작 확인

배포 후 브라우저 주소창에 아래처럼 직접 접속해 응답이 오는지 먼저 확인하면 문제를
빨리 좁힐 수 있습니다.

```
GET  https://프로젝트이름.vercel.app/api/workplace-population
```
→ `{"type":"FeatureCollection","features":[...]}` 형태의 JSON이 보이면 정상입니다.

`ai-compare`는 POST 전용이라 브라우저 주소창으로는 테스트가 안 되며, 대시보드의
AI 패널에서 질문을 보내 확인하면 됩니다.

## 5. 비용/트래픽 참고

- Vercel 서버리스 함수는 무료 플랜(Hobby)으로 개인/소규모 사용에 충분합니다.
- `workplace-population`은 응답에 7일 캐시 헤더(`s-maxage`)를 붙여 두어, 같은 기간
  내 재요청은 SGIS를 다시 호출하지 않고 캐시된 결과를 돌려줍니다.
- `ai-compare`는 질문마다 실제 AI API를 호출하므로, 각 서비스(OpenAI/Google/Anthropic)의
  자체 사용 요금이 발생합니다. 필요한 AI만 키를 등록해 비용을 조절할 수 있습니다.

## 6. AI 모델명이 바뀌어 오류가 날 때

AI 제공사들은 모델을 자주 교체/종료합니다. "The model ... does not exist",
"no longer available to new users" 같은 오류가 뜨면 `api/ai-compare.js`의 모델명만
아래 위치에서 최신값으로 바꾸고 재배포하면 됩니다.

- OpenAI: `model: 'gpt-4o-mini'` → https://platform.openai.com/docs/models
- Gemini: URL 안의 `models/gemini-3.6-flash:generateContent` → https://ai.google.dev/gemini-api/docs/models
- Groq: `model: 'openai/gpt-oss-20b'` → https://console.groq.com/docs/models (종료 목록: /docs/deprecations)

## 7. "Incorrect API key" 오류

이건 코드가 아니라 **키 값 자체가 잘못 등록된 것**입니다.
- 해당 제공사 콘솔에서 키를 다시 복사 (앞뒤 공백/줄바꿈 없이 전체를)
- Vercel → Environment Variables에서 해당 키를 삭제 후 다시 추가
- **Redeploy** (재배포해야 반영됨)
- 키 이름(Key 칸)에 값이 들어가지 않았는지, 값(Value 칸)에 이름이 들어가지 않았는지 확인

## 8. 자비스(3AI 비교)의 구글시트 상세분석

`context.apps_script_url`이 전달되면(대시보드가 자동으로 보냄), 서버가 대시보드와
동일한 구글시트 데이터를 **직접 실시간 조회**해 GPT·Gemini에게는 거래금액 상위
60건 전체(주소·용도·평단가·공시지가 대비율·스토리 요약 포함)를 컨텍스트로 줍니다.
Groq는 무료 토큰 한도가 좁아 기존처럼 상위 12건 요약본만 사용합니다.

시트 조회에 실패해도(네트워크 오류 등) 자비스 자체는 멈추지 않고, 조용히 요약본
컨텍스트로 대체되어 답변합니다.
