// api/workplace-population.js
// SGIS 전국사업체조사 종사자수(직장인구)를 서울 행정동 경계와 병합해
// Kakao Maps에서 바로 표시 가능한 WGS84(EPSG:4326) GeoJSON으로 반환합니다.
//
// 핵심 수정(v13.3)
// 1) SGIS 원본 경계는 UTM-K / EPSG:5179이므로 서버에서 EPSG:4326으로 변환합니다.
// 2) low_search=1을 명시해 5자리 시군구 코드 아래 행정동을 확실히 조회합니다.
// 3) HTTP 200이어도 errCd가 오류인 SGIS 응답을 검증합니다.
// 4) 2024년을 기본값으로 사용하고, 결과가 전부 비면 직전 연도로 1회 자동 재시도합니다.
// 5) 일부 구 실패/조회 연도/좌표계 정보를 meta에 함께 반환합니다.

var proj4 = require('proj4');

// SGIS 공식 좌표계: UTM-K (GRS80) EPSG:5179
proj4.defs('EPSG:5179', '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs');

var SGIS_BASE = 'https://sgisapi.mods.go.kr';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET 요청만 허용됩니다.' }); return; }

  var KEY = (process.env.SGIS_CONSUMER_KEY || '').trim();
  var SECRET = (process.env.SGIS_CONSUMER_SECRET || '').trim();
  var requestedYear = String((req.query && req.query.year) || process.env.SGIS_STATS_YEAR || '2024').trim();

  if (!KEY || !SECRET) {
    res.status(500).json({
      error: 'Vercel 환경변수 SGIS_CONSUMER_KEY / SGIS_CONSUMER_SECRET이 설정되지 않았습니다. SGIS의 서비스 ID를 KEY, 보안 Key를 SECRET에 넣고 Redeploy 해주세요.'
    });
    return;
  }

  try {
    var token = await sgisAuth(KEY, SECRET);
    var first = await loadSeoul(token, requestedYear);
    var result = first;

    // 연도 미제공/코드개편 등으로 전부 빈 경우에만 직전 연도로 1회 재시도
    if (!result.features.length) {
      var y = parseInt(requestedYear, 10);
      if (isFinite(y) && y > 2000) result = await loadSeoul(token, String(y - 1));
    }

    if (!result.features.length) {
      var detail = result.failedGu.slice(0, 5).join(', ');
      throw new Error('SGIS에서 표시 가능한 행정동 직장인구를 받지 못했습니다.' + (detail ? ' 실패 예: ' + detail : ''));
    }

    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');
    res.status(200).json({
      type: 'FeatureCollection',
      features: result.features,
      meta: {
        source: 'SGIS 전국사업체조사',
        year: result.year,
        source_crs: 'EPSG:5179',
        output_crs: 'EPSG:4326',
        feature_count: result.features.length,
        failed_gu_count: result.failedGu.length,
        failed_gu: result.failedGu.slice(0, 25)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'SGIS 연동 중 오류가 발생했습니다.' });
  }
};

async function sgisAuth(key, secret) {
  var url = SGIS_BASE + '/OpenAPI3/auth/authentication.json?consumer_key=' + encodeURIComponent(key) + '&consumer_secret=' + encodeURIComponent(secret);
  var r = await fetchWithTimeout(url, 12000);
  var j = await safeJson(r, 'SGIS 인증');
  if (!r.ok) throw new Error('SGIS 인증 HTTP ' + r.status + ': ' + sgisMessage(j));
  if (!j || Number(j.errCd) !== 0 || !j.result || !j.result.accessToken) {
    throw new Error('SGIS 인증 실패: ' + sgisMessage(j));
  }
  return j.result.accessToken;
}

async function loadSeoul(token, year) {
  var names = Object.keys(SEOUL_GU_CODES);
  var allFeatures = [];
  var failedGu = [];
  var BATCH = 5;

  for (var i = 0; i < names.length; i += BATCH) {
    var chunk = names.slice(i, i + BATCH);
    var results = await Promise.all(chunk.map(async function (nm) {
      try {
        var feats = await fetchGu(SEOUL_GU_CODES[nm], token, year);
        return { nm: nm, feats: feats };
      } catch (err) {
        return { nm: nm, error: err.message };
      }
    }));
    results.forEach(function (r) {
      if (r.feats && r.feats.length) allFeatures = allFeatures.concat(r.feats);
      else failedGu.push(r.nm + '(' + (r.error || '0개') + ')');
    });
  }

  return { year: year, features: allFeatures, failedGu: failedGu };
}

async function fetchGu(admCd, token, year) {
  var common = 'accessToken=' + encodeURIComponent(token) + '&year=' + encodeURIComponent(year) + '&adm_cd=' + encodeURIComponent(admCd) + '&low_search=1';
  var bUrl = SGIS_BASE + '/OpenAPI3/boundary/hadmarea.geojson?' + common;
  var cUrl = SGIS_BASE + '/OpenAPI3/stats/company.json?' + common;

  var results = await Promise.all([
    fetchWithTimeout(bUrl, 15000),
    fetchWithTimeout(cUrl, 15000)
  ]);
  var geo = await safeJson(results[0], '경계');
  var stat = await safeJson(results[1], '종사자수');

  if (!results[0].ok) throw new Error('경계 HTTP ' + results[0].status + ': ' + sgisMessage(geo));
  if (!results[1].ok) throw new Error('종사자수 HTTP ' + results[1].status + ': ' + sgisMessage(stat));

  // GeoJSON 경계 응답은 일반 GeoJSON이라 errCd가 없을 수도 있음
  if (geo && geo.errCd !== undefined && Number(geo.errCd) !== 0) throw new Error('경계: ' + sgisMessage(geo));
  if (!stat || Number(stat.errCd) !== 0) throw new Error('종사자수: ' + sgisMessage(stat));

  var workerMap = {};
  ((stat && stat.result) || []).forEach(function (row) {
    var cd = String(row.adm_cd || '');
    var raw = row.tot_worker;
    var n = parseInt(String(raw == null ? '' : raw).replace(/,/g, ''), 10);
    // 비밀보호 N/A 등은 null로 처리
    workerMap[cd] = isFinite(n) ? n : null;
  });

  var feats = (geo && geo.features) || [];
  var out = [];
  feats.forEach(function (f) {
    var props = f.properties || (f.properties = {});
    var cd = String(props.adm_cd || props.ADM_CD || props.cd || '');
    var workers = Object.prototype.hasOwnProperty.call(workerMap, cd) ? workerMap[cd] : null;
    if (workers === null || workers === undefined) return;

    var geom4326 = transformGeometry5179To4326(f.geometry);
    if (!geom4326) return;

    props.workplace_population = workers;
    props.adm_nm = props.adm_nm || props.ADM_NM || props.name || '';
    props.sgis_year = year;
    props.sgis_crs = 'EPSG:4326';
    out.push({ type: 'Feature', properties: props, geometry: geom4326 });
  });
  return out;
}

function transformGeometry5179To4326(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  return {
    type: geometry.type,
    coordinates: transformCoords(geometry.coordinates)
  };
}

function transformCoords(node) {
  if (!Array.isArray(node)) return node;
  if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
    var x = Number(node[0]), y = Number(node[1]);
    // 이미 경위도이면 그대로 둠(수동/향후 API 변경에 대한 안전장치)
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return [x, y];
    var p = proj4('EPSG:5179', 'EPSG:4326', [x, y]);
    return [Number(p[0].toFixed(7)), Number(p[1].toFixed(7))];
  }
  return node.map(transformCoords);
}

function sgisMessage(j) {
  if (!j) return '응답 없음';
  var parts = [];
  if (j.errMsg) parts.push(j.errMsg);
  if (j.errCd !== undefined) parts.push('errCd=' + j.errCd);
  return parts.join(' / ') || '알 수 없는 SGIS 오류';
}

async function safeJson(r, label) {
  var text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(label + ' 응답이 JSON이 아닙니다: ' + text.slice(0, 160)); }
}

function fetchWithTimeout(url, ms) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, ms || 12000);
  return fetch(url, { signal: controller.signal }).finally(function () { clearTimeout(timer); });
}
