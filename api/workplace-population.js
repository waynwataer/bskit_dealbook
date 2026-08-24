// api/workplace-population.js
// 통계청 SGIS Open API(전국사업체조사)를 서버에서 대신 호출해,
// 서울 25개 구의 행정동 경계 + 종사자수(직장인구)를 병합한 GeoJSON을
// 돌려주는 프록시입니다. 서버-서버 호출이라 브라우저 CORS 제한이 없고,
// consumer_secret도 브라우저에 노출되지 않습니다.
//
// 대시보드 CONFIG.WORKPLACE_POP_PROXY_ENDPOINT 에 이 함수 배포 주소를 넣습니다.
// 예) https://bskit-backend.vercel.app/api/workplace-population
//
// Vercel 프로젝트 환경변수에 SGIS_CONSUMER_KEY / SGIS_CONSUMER_SECRET을
// 등록해야 합니다. (2025-10 통계청→국가데이터처 개편으로 사이트가
// https://sgis.mods.go.kr 로 이전되었습니다. 로그인 후 개발지원센터에서 발급)

var SEOUL_GU_CODES = {
  '종로구': '11010', '중구': '11020', '용산구': '11030', '성동구': '11040', '광진구': '11050',
  '동대문구': '11060', '중랑구': '11070', '성북구': '11080', '강북구': '11090', '도봉구': '11100',
  '노원구': '11110', '은평구': '11120', '서대문구': '11130', '마포구': '11140', '양천구': '11150',
  '강서구': '11160', '구로구': '11170', '금천구': '11180', '영등포구': '11190', '동작구': '11200',
  '관악구': '11210', '서초구': '11220', '강남구': '11230', '송파구': '11240', '강동구': '11250'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var KEY = (process.env.SGIS_CONSUMER_KEY || '').trim();
  var SECRET = (process.env.SGIS_CONSUMER_SECRET || '').trim();
  var YEAR = (process.env.SGIS_STATS_YEAR || '2023').trim();

  if (!KEY || !SECRET) {
    res.status(500).json({ error: '서버 환경변수 SGIS_CONSUMER_KEY / SGIS_CONSUMER_SECRET이 설정되지 않았습니다.' });
    return;
  }

  try {
    var token = await sgisAuth(KEY, SECRET);
    var names = Object.keys(SEOUL_GU_CODES);
    var allFeatures = [];
    var failedGu = [];
    // ★ 25개 구를 하나씩 순차 호출하면 Vercel 함수 실행 제한 시간을 넘겨
    //   타임아웃(500)이 나기 쉬워, 5개씩 묶어 병렬 처리로 속도를 크게 높입니다.
    var BATCH = 5;
    for (var i = 0; i < names.length; i += BATCH) {
      var chunk = names.slice(i, i + BATCH);
      var results = await Promise.all(chunk.map(function (nm) {
        var cd = SEOUL_GU_CODES[nm];
        return fetchGu(cd, token, YEAR)
          .then(function (feats) { return { nm: nm, feats: feats }; })
          .catch(function (guErr) { return { nm: nm, error: guErr.message }; });
      }));
      results.forEach(function (r) {
        if (r.feats) allFeatures = allFeatures.concat(r.feats);
        else failedGu.push(r.nm + '(' + r.error + ')');
      });
    }
    if (failedGu.length) console.warn('[workplace-population] 실패한 구:', failedGu.join(', '));
    // Vercel Edge/CDN 캐시: 7일간 재사용, 만료 후에도 갱신 중 이전 값 제공
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');
    res.status(200).json({ type: 'FeatureCollection', features: allFeatures });
  } catch (e) {
    res.status(500).json({ error: e.message || 'SGIS 연동 중 오류가 발생했습니다.' });
  }
}

async function sgisAuth(key, secret) {
  var url = 'https://sgisapi.mods.go.kr/OpenAPI3/auth/authentication.json?consumer_key=' + encodeURIComponent(key) + '&consumer_secret=' + encodeURIComponent(secret);
  var r = await fetch(url);
  var j = await r.json();
  if (!j || !j.result || !j.result.accessToken) throw new Error((j && j.errMsg) || 'SGIS 인증 실패');
  return j.result.accessToken;
}

async function fetchGu(admCd, token, year) {
  var bUrl = 'https://sgisapi.mods.go.kr/OpenAPI3/boundary/hadmarea.geojson?accessToken=' + encodeURIComponent(token) + '&year=' + encodeURIComponent(year) + '&adm_cd=' + admCd;
  var cUrl = 'https://sgisapi.mods.go.kr/OpenAPI3/stats/company.json?accessToken=' + encodeURIComponent(token) + '&year=' + encodeURIComponent(year) + '&adm_cd=' + admCd;

  var results = await Promise.all([
    fetch(bUrl).then(function (r) { if (!r.ok) throw new Error('경계 HTTP ' + r.status); return r.json(); }),
    fetch(cUrl).then(function (r) { if (!r.ok) throw new Error('종사자수 HTTP ' + r.status); return r.json(); })
  ]);
  var geo = results[0], stat = results[1];

  var workerMap = {};
  ((stat && stat.result) || []).forEach(function (row) {
    workerMap[String(row.adm_cd)] = parseInt(row.tot_worker, 10) || 0;
  });

  var feats = (geo && geo.features) || [];
  feats.forEach(function (f) {
    var props = f.properties || (f.properties = {});
    var cd = String(props.adm_cd || props.ADM_CD || '');
    props.workplace_population = (workerMap[cd] !== undefined) ? workerMap[cd] : null;
    props.adm_nm = props.adm_nm || props.ADM_NM || '';
  });
  return feats.filter(function (f) { return f.properties.workplace_population !== null; });
}
