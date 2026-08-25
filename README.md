# BSKIT DealBook Backend v13.3

`dealbook_v13.3.html`의 AI 검색과 SGIS 직장인구 레이어를 위한 Vercel 서버리스 백엔드입니다.

- `api/ai-compare.js` — GPT · Gemini · Groq · 자비스 + 뉴스검색 + Google Drive 검색
- `api/workplace-population.js` — SGIS 전국사업체조사 종사자수 + 행정동 경계 병합, EPSG:5179 → WGS84 변환
- `api/health.js` — API 키/Drive/SGIS 설정 여부만 확인하는 진단 엔드포인트(비밀값은 반환하지 않음)

API 키와 인증정보는 **HTML에 넣지 말고 Vercel Environment Variables에만** 저장하세요.

---

## 1. 이번 v13.3에서 수정한 문제

### 뉴스 검색
기존 코드는 `gpt-4o-mini`에 `web_search.filters.allowed_domains`를 함께 전달해 계정/모델 조합에 따라
`Parameter 'filters' not supported ...` 오류가 발생했습니다.

v13.3은:
1. `gpt-5.4-mini` + 도메인 필터를 우선 시도
2. 필터/툴 호환 오류가 발생하면 `gpt-4o-mini` + 필터 없는 웹검색으로 자동 재시도
3. 최종 인용 링크는 `dealbook.co.kr`, `thebell.co.kr`만 후처리해 표시

### Google Drive 검색
기존 `GOOGLE_DRIVE_FOLDER_ID='.'` 같은 값은 Google Drive API에서 `File not found: .`를 발생시킵니다.
또한 자연어 질문 전체를 `fullText contains` 조건으로 넣으면 한글 질의에서 파일을 지나치게 많이 놓칠 수 있습니다.

v13.3은:
- `.`, `/`, `root`, 공백을 "폴더 제한 없음"으로 처리
- 폴더 URL을 넣어도 ID를 자동 추출
- 지정 폴더 아래 하위 폴더를 최대 3단계 재귀 검색
- 질문 + 선택한 매매사례/매물명/주소로 로컬 관련도 점수 계산
- 상위 문서 본문까지 읽은 뒤 다시 관련도 정렬
- OpenAI 키가 없어도 파일명/링크 검색 결과는 반환

### SGIS 직장인구
SGIS 경계 좌표는 EPSG:5179(UTM-K)인데 Kakao Map은 경위도(WGS84)를 사용합니다.
기존 버전은 SGIS 좌표를 그대로 `LatLng`에 넣어 실제 데이터가 있어도 폴리곤이 지도 밖에 그려질 수 있었습니다.

v13.3은 Vercel 서버에서 `proj4`로 **EPSG:5179 → EPSG:4326** 변환 후 GeoJSON을 반환합니다.
또한 `low_search=1`, API의 `errCd`, 빈 결과 캐시 방지, 2024 기본연도 및 1년 자동 fallback을 추가했습니다.

---

## 2. Vercel 환경변수

Vercel → Project → **Settings → Environment Variables**에서 등록합니다.

### AI

| 변수명 | 필수 | 설명 |
|---|---:|---|
| `OPENAI_API_KEY` | 뉴스/GPT 사용 시 | GPT 분석, 뉴스 검색, Drive 문서 요약 |
| `GEMINI_API_KEY` | 선택 | Gemini |
| `GROQ_API_KEY` | 선택 | Groq |
| `OPENAI_NEWS_MODEL` | 선택 | 기본 `gpt-5.4-mini` |
| `OPENAI_NEWS_FALLBACK_MODEL` | 선택 | 기본 `gpt-4o-mini` |
| `OPENAI_DRIVE_MODEL` | 선택 | 기본 `gpt-4o-mini` |

### Google Drive

| 변수명 | 필수 | 설명 |
|---|---:|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | 예 | 서비스 계정 JSON의 `client_email` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | 예 | JSON의 `private_key` 전체 |
| `GOOGLE_DRIVE_FOLDER_ID` | 선택 | 실제 폴더 ID 또는 Google Drive 폴더 URL. **`.` 입력 금지** |

서비스 계정 이메일을 Google Drive의 검색 대상 폴더에 **뷰어**로 공유해야 합니다.
`GOOGLE_DRIVE_FOLDER_ID`를 비우면 서비스 계정에 공유되어 검색 가능한 파일을 대상으로 검색합니다.

지원 본문 추출:
- Google Docs → text/plain
- Google Sheets → CSV
- Google Slides → text/plain
- txt/csv → 직접 읽기
- PDF/Word/이미지 → 현재 버전에서는 파일명/링크만 사용

### SGIS 직장인구

| 변수명 | 필수 | SGIS 발급 화면의 명칭 |
|---|---:|---|
| `SGIS_CONSUMER_KEY` | 예 | **서비스 ID** |
| `SGIS_CONSUMER_SECRET` | 예 | **보안 Key** |
| `SGIS_STATS_YEAR` | 선택 | 기본 `2024` |

SGIS 인증정보는 대시보드 HTML에 넣지 않습니다. Vercel에만 보관합니다.

> 인증키/보안키가 스크린샷·채팅·공개 저장소에 노출된 적이 있다면 기존 값을 폐기 또는 재발급한 뒤 새 값을 Vercel에 등록하세요.

---

## 3. 배포

GitHub 저장소에서 다음 파일을 교체/추가합니다.

```text
api/ai-compare.js
api/workplace-population.js
api/health.js
package.json
vercel.json
```

`package.json`에 `proj4`가 추가되었으므로 **package.json도 반드시 같이 배포**해야 합니다.

그 후 Vercel에서 **Redeploy** 합니다.

대시보드 CONFIG는 다음 형태입니다.

```js
AI_COMPARE_ENDPOINT: 'https://dealbook-flame.vercel.app/api/ai-compare',
WORKPLACE_POP_PROXY_ENDPOINT: 'https://dealbook-flame.vercel.app/api/workplace-population',
SGIS_STATS_YEAR: '2024'
```

---

## 4. 배포 후 진단

### 전체 설정 진단
브라우저에서:

```text
https://YOUR-PROJECT.vercel.app/api/health
```

정상 예시:

```json
{
  "ok": true,
  "drive": {
    "service_account_email": true,
    "service_account_key": true,
    "invalid_dot_value_detected": false
  },
  "sgis": {
    "consumer_key": true,
    "consumer_secret": true,
    "year": "2024",
    "output_crs": "EPSG:4326"
  }
}
```

실제 키 값은 반환하지 않습니다.

### SGIS 직접 확인

```text
https://YOUR-PROJECT.vercel.app/api/workplace-population?year=2024
```

정상이면 `FeatureCollection`과 `meta`가 나오며:
- `meta.output_crs` = `EPSG:4326`
- `meta.feature_count` > 0

이어야 합니다.

### Drive가 여전히 안 될 때
1. `GOOGLE_DRIVE_FOLDER_ID`가 `.`인지 확인 → 삭제하거나 실제 ID/URL로 변경
2. 서비스 계정 이메일에 대상 폴더를 공유했는지 확인
3. Google Cloud 프로젝트에서 **Google Drive API**를 사용 설정했는지 확인
4. 환경변수 수정 후 Redeploy 했는지 확인
5. `/api/health`에서 Drive 항목이 모두 true인지 확인

### 뉴스가 여전히 안 될 때
- `OPENAI_API_KEY` 잔액/사용한도 확인
- `/api/health`에서 `ai.openai: true` 확인
- 오류 메시지에 모델/툴 권한 문제가 나오면 `OPENAI_NEWS_MODEL`을 현재 웹검색 지원 모델로 변경 후 Redeploy

---

## 5. 보안

- API 키, SGIS 보안 Key, Google 서비스 계정 private key는 HTML/티스토리/GitHub 공개 저장소에 넣지 않습니다.
- `api/health`는 값 자체가 아니라 설정 유무만 반환합니다.
- Google Drive 서비스 계정에는 필요한 폴더만 뷰어로 공유하는 것을 권장합니다.
