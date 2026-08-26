# BSKIT DealBook Backend v13.6

AI/뉴스/Google Drive 기능은 v13.5 동작을 유지하고, SGIS 직장인구 레이어를 정상화한 버전입니다.

## SGIS 직장인구 핵심
SGIS 행정동 경계는 EPSG:5179 좌표를 반환할 수 있으므로 서버에서 `proj4`를 사용해 EPSG:4326으로 변환한 뒤 대시보드에 전달합니다. `company.json`의 `tot_worker`와 행정동 경계를 `adm_cd`로 병합합니다.

환경변수:
- `SGIS_CONSUMER_KEY`
- `SGIS_CONSUMER_SECRET`
- `SGIS_STATS_YEAR` = `2024` 권장

`package.json`의 `proj4` dependency가 반드시 함께 배포되어야 합니다.

배포 후 `/api/workplace-population?year=2024`에서 `meta.output_crs`가 `EPSG:4326`인지 확인하세요.
