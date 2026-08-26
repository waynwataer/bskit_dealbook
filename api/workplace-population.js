// BSKIT DealBook v13.6 — SGIS workplace population proxy
// - SGIS administrative-dong boundaries (EPSG:5179) -> WGS84(EPSG:4326)
// - company.json total workers joined by adm_cd
// - low_search=1 to fetch sub-districts
// - 2024 default, one-year fallback if empty
// - Seoul-wide ranking / percentile / summary stats added for better interpretation

var proj4 = require('proj4');

proj4.defs('EPSG:5179', '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs');

var SGIS_BASES = ['https://sgisapi.mods.go.kr', 'https://sgisapi.kostat.go.kr'];
var SEOUL_GU_CODES = {
  '종로구':'11010','중구':'11020','용산구':'11030','성동구':'11040','광진구':'11050',
  '동대문구':'11060','중랑구':'11070','성북구':'11080','강북구':'11090','도봉구':'11100',
  '노원구':'11110','은평구':'11120','서대문구':'11130','마포구':'11140','양천구':'11150',
  '강서구':'11160','구로구':'11170','금천구':'11180','영등포구':'11190','동작구':'11200',
  '관악구':'11210','서초구':'11220','강남구':'11230','송파구':'11240','강동구':'11250'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({error:'GET 요청만 허용됩니다.'}); return; }

  var KEY = String(process.env.SGIS_CONSUMER_KEY || '').trim();
  var SECRET = String(process.env.SGIS_CONSUMER_SECRET || '').trim();
  var requestedYear = String((req.query && req.query.year) || process.env.SGIS_STATS_YEAR || '2024').trim();

  if (!KEY || !SECRET) {
    res.status(500).json({error:'Vercel 환경변수 SGIS_CONSUMER_KEY / SGIS_CONSUMER_SECRET이 설정되지 않았습니다.'});
    return;
  }

  try {
    var auth = await sgisAuth(KEY, SECRET);
    var result = await loadSeoul(auth.base, auth.token, requestedYear);
    if (!result.features.length) {
      var y = parseInt(requestedYear, 10);
      if (isFinite(y) && y > 2000) result = await loadSeoul(auth.base, auth.token, String(y - 1));
    }
    if (!result.features.length) {
      throw new Error('SGIS에서 표시 가능한 행정동 직장인구를 받지 못했습니다. ' + result.failedGu.slice(0,5).join(', '));
    }

    enrichSeoulStats(result.features);
    var values = result.features.map(function(f){return Number(f.properties.workplace_population)||0;}).filter(function(v){return v>=0;});
    var summary = summarize(values);

    // The source data is annual; CDN caching is safe and reduces SGIS traffic.
    res.setHeader('Cache-Control','s-maxage=604800, stale-while-revalidate=86400');
    res.status(200).json({
      type:'FeatureCollection',
      features:result.features,
      meta:{
        source:'통계청 SGIS 전국사업체조사',
        year:result.year,
        source_crs:'EPSG:5179',
        output_crs:'EPSG:4326',
        feature_count:result.features.length,
        total_workers:summary.sum,
        average_workers:summary.avg,
        median_workers:summary.median,
        q1:summary.q1,
        q3:summary.q3,
        failed_gu_count:result.failedGu.length,
        failed_gu:result.failedGu.slice(0,25),
        api_host:auth.base
      }
    });
  } catch (e) {
    res.status(500).json({error:e && e.message ? e.message : 'SGIS 연동 중 오류가 발생했습니다.'});
  }
};

async function sgisAuth(key, secret) {
  var errors=[];
  for (var i=0;i<SGIS_BASES.length;i++) {
    var base=SGIS_BASES[i];
    try {
      var url=base+'/OpenAPI3/auth/authentication.json?consumer_key='+encodeURIComponent(key)+'&consumer_secret='+encodeURIComponent(secret);
      var r=await fetchWithTimeout(url,12000);
      var j=await safeJson(r,'SGIS 인증');
      if (!r.ok) throw new Error('HTTP '+r.status+' '+sgisMessage(j));
      if (!j || Number(j.errCd)!==0 || !j.result || !j.result.accessToken) throw new Error(sgisMessage(j));
      return {base:base,token:j.result.accessToken};
    } catch(e) { errors.push(base+': '+e.message); }
  }
  throw new Error('SGIS 인증 실패 — '+errors.join(' | '));
}

async function loadSeoul(base, token, year) {
  var names=Object.keys(SEOUL_GU_CODES), allFeatures=[], failedGu=[], BATCH=5;
  for (var i=0;i<names.length;i+=BATCH) {
    var chunk=names.slice(i,i+BATCH);
    var results=await Promise.all(chunk.map(async function(nm){
      try { return {nm:nm,feats:await fetchGu(base,SEOUL_GU_CODES[nm],token,year)}; }
      catch(err) { return {nm:nm,error:err.message}; }
    }));
    results.forEach(function(r){
      if (r.feats && r.feats.length) allFeatures=allFeatures.concat(r.feats);
      else failedGu.push(r.nm+'('+(r.error||'0개')+')');
    });
  }
  return {year:year,features:allFeatures,failedGu:failedGu};
}

async function fetchGu(base, admCd, token, year) {
  var common='accessToken='+encodeURIComponent(token)+'&year='+encodeURIComponent(year)+'&adm_cd='+encodeURIComponent(admCd)+'&low_search=1';
  var bUrl=base+'/OpenAPI3/boundary/hadmarea.geojson?'+common;
  var cUrl=base+'/OpenAPI3/stats/company.json?'+common;
  var rs=await Promise.all([fetchWithTimeout(bUrl,15000),fetchWithTimeout(cUrl,15000)]);
  var geo=await safeJson(rs[0],'경계'), stat=await safeJson(rs[1],'종사자수');
  if (!rs[0].ok) throw new Error('경계 HTTP '+rs[0].status+': '+sgisMessage(geo));
  if (!rs[1].ok) throw new Error('종사자수 HTTP '+rs[1].status+': '+sgisMessage(stat));
  if (geo && geo.errCd!==undefined && Number(geo.errCd)!==0) throw new Error('경계: '+sgisMessage(geo));
  if (!stat || Number(stat.errCd)!==0) throw new Error('종사자수: '+sgisMessage(stat));

  var workerMap={};
  ((stat&&stat.result)||[]).forEach(function(row){
    var cd=String(row.adm_cd||'');
    var n=parseInt(String(row.tot_worker==null?'':row.tot_worker).replace(/,/g,''),10);
    workerMap[cd]=isFinite(n)?n:null;
  });

  var out=[];
  ((geo&&geo.features)||[]).forEach(function(f){
    var props=f.properties||(f.properties={});
    var cd=String(props.adm_cd||props.ADM_CD||props.cd||'');
    var workers=Object.prototype.hasOwnProperty.call(workerMap,cd)?workerMap[cd]:null;
    if (workers===null || workers===undefined) return;
    var geom=transformGeometry5179To4326(f.geometry);
    if (!geom || !geometryLooksKorean(geom)) return;
    props.workplace_population=workers;
    props.adm_nm=props.adm_nm||props.ADM_NM||props.name||'';
    props.adm_cd=cd;
    props.sgis_year=year;
    props.sgis_crs='EPSG:4326';
    out.push({type:'Feature',properties:props,geometry:geom});
  });
  return out;
}

function enrichSeoulStats(features) {
  var arr=features.map(function(f){return Number(f.properties.workplace_population)||0;});
  var sorted=arr.slice().sort(function(a,b){return b-a;});
  var sum=arr.reduce(function(a,b){return a+b;},0);
  var avg=arr.length?sum/arr.length:0;
  var asc=arr.slice().sort(function(a,b){return a-b;});
  features.forEach(function(f){
    var p=f.properties, v=Number(p.workplace_population)||0;
    var rank=sorted.indexOf(v)+1;
    var lower=0; for(var i=0;i<asc.length;i++){if(asc[i]<=v)lower++;}
    var percentile=asc.length?Math.round(lower/asc.length*100):0;
    p.seoul_rank=rank;
    p.seoul_total_dongs=features.length;
    p.seoul_percentile=percentile;
    p.seoul_top_percent=Math.max(1,100-percentile+1);
    p.seoul_average_workers=Math.round(avg);
    p.vs_seoul_average=avg?Number((v/avg).toFixed(2)):null;
  });
}

function summarize(values){
  var a=values.slice().sort(function(x,y){return x-y;});
  var n=a.length, sum=a.reduce(function(s,v){return s+v;},0);
  function q(p){if(!n)return 0;var idx=(n-1)*p,lo=Math.floor(idx),hi=Math.ceil(idx);return lo===hi?a[lo]:Math.round(a[lo]+(a[hi]-a[lo])*(idx-lo));}
  return {sum:sum,avg:n?Math.round(sum/n):0,median:q(.5),q1:q(.25),q3:q(.75)};
}

function transformGeometry5179To4326(geometry){
  if(!geometry||!geometry.coordinates)return null;
  return {type:geometry.type,coordinates:transformCoords(geometry.coordinates)};
}
function transformCoords(node){
  if(!Array.isArray(node))return node;
  if(node.length>=2&&typeof node[0]==='number'&&typeof node[1]==='number'){
    var x=Number(node[0]),y=Number(node[1]);
    if(Math.abs(x)<=180&&Math.abs(y)<=90)return [x,y];
    var p=proj4('EPSG:5179','EPSG:4326',[x,y]);
    return [Number(p[0].toFixed(7)),Number(p[1].toFixed(7))];
  }
  return node.map(transformCoords);
}
function geometryLooksKorean(geom){
  var sample=findFirstCoord(geom&&geom.coordinates);
  if(!sample)return false;
  return sample[0]>=124&&sample[0]<=132&&sample[1]>=32&&sample[1]<=40;
}
function findFirstCoord(node){
  if(!Array.isArray(node))return null;
  if(node.length>=2&&typeof node[0]==='number'&&typeof node[1]==='number')return node;
  for(var i=0;i<node.length;i++){var x=findFirstCoord(node[i]);if(x)return x;}
  return null;
}
function sgisMessage(j){
  if(!j)return '응답 없음';
  var p=[];if(j.errMsg)p.push(j.errMsg);if(j.errCd!==undefined)p.push('errCd='+j.errCd);return p.join(' / ')||'알 수 없는 SGIS 오류';
}
async function safeJson(r,label){
  var text=await r.text();
  try{return JSON.parse(text);}catch(e){throw new Error(label+' 응답이 JSON이 아닙니다: '+text.slice(0,160));}
}
function fetchWithTimeout(url,ms){
  var c=new AbortController(),timer=setTimeout(function(){c.abort();},ms||12000);
  return fetch(url,{signal:c.signal}).finally(function(){clearTimeout(timer);});
}
