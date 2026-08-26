# BSKIT DealBook Backend v13.8

## 핵심 수정

### 1) Gemini 안정화
- 기본 모델: `gemini-3.7-flash`
- 자동 fallback: `gemini-3.6-flash` -> `gemini-3.5-flash`
- 더 이상 종료된 `gemini-2.5-flash`를 사용하지 않습니다.
- 기본 추론 수준: `medium` (무료 티어 안정성과 분석 품질 균형)
- 실패 시 각 모델별 실제 오류를 모두 반환합니다.

선택 환경변수:
- `GEMINI_MODEL=gemini-3.7-flash`
- `GEMINI_THINKING_LEVEL=medium`

### 2) SGIS 직장인구
- `company.json`의 `tot_worker`와 행정동 경계를 `adm_cd`로 병합합니다.
- SGIS 경계 EPSG:5179를 서버에서 `proj4`로 EPSG:4326으로 변환합니다.
- `low_search=1`로 구별 하위 행정동을 조회합니다.
- 기본 기준연도 2024, 데이터가 비면 1년 전으로 fallback합니다.
- 응답 `meta.backend_version`은 `13.8`입니다.

필수 환경변수:
- `SGIS_CONSUMER_KEY`
- `SGIS_CONSUMER_SECRET`
- `SGIS_STATS_YEAR=2024` 권장

`package.json`의 `proj4` dependency를 반드시 함께 배포해야 합니다.

### 3) SGIS 이중 안전장치
`dealbook_v13.8.html`은 서버가 과거 캐시 때문에 EPSG:5179 원좌표를 반환하더라도 브라우저에서 한 번 더 WGS84로 자동 변환합니다. 또한 `?v=138` 쿼리를 붙여 과거 Vercel CDN 응답을 우회하고 브라우저 직장인구 캐시 키도 새 버전으로 분리합니다.

## 배포 후 확인
- `/api/health`
- `/api/workplace-population?year=2024&v=138`

정상적인 SGIS 응답에는 다음이 포함되어야 합니다.
- `type: "FeatureCollection"`
- `meta.output_crs: "EPSG:4326"`
- `meta.backend_version: "13.8"`
- `features` 배열에 실제 행정동 데이터
