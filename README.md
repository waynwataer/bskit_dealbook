# BSKIT DealBook Backend v13.4

Production URL: `https://bskit-dealbook.vercel.app`

## Deployment

1. 이 폴더의 `api/`, `package.json`, `vercel.json`을 GitHub 저장소 루트에 업로드합니다.
2. Vercel의 `bskit-dealbook` 프로젝트에서 최신 commit을 Production으로 Redeploy 합니다.
3. `/api/health`와 `/api/ai-compare`를 브라우저에서 확인합니다.

## Environment Variables

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_KEY`
- `GOOGLE_DRIVE_FOLDER_ID` (선택)
- `SGIS_CONSUMER_KEY`
- `SGIS_CONSUMER_SECRET`
- `SGIS_STATS_YEAR` (기본 2024)

API 키는 HTML에 넣지 않습니다.
