// ============================================================
// js/weather.js
// 공통 날씨 + 역지오코딩 + 온도 위험 판정 헬퍼
// ============================================================

const _weatherCache = {}
const _hourlyCache  = {}
const WEATHER_TTL = 30 * 60 * 1000   // 30분

function roundOrNull(v) {
  return v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v))
}

function pickCurrentAirQuality(hourly) {
  if (!hourly?.time?.length) return null
  const now = new Date()
  const nowMs = now.getTime()
  let bestIdx = 0
  let bestDiff = Infinity
  hourly.time.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - nowMs)
    if (diff < bestDiff) {
      bestDiff = diff
      bestIdx = i
    }
  })
  return {
    pm10: roundOrNull(hourly.pm10?.[bestIdx]),
    pm2_5: roundOrNull(hourly.pm2_5?.[bestIdx]),
  }
}

/**
 * 좌표로 현재 날씨 조회 (Open-Meteo, 무료, API 키 불필요)
 * 30분 캐시 — 동일 좌표 재요청 방지
 * 실패 시 null 반환 (앱이 조용히 동작하도록)
 */
async function loadWeather(lat, lng) {
  if (lat == null || lng == null) return null
  const key = `${lat},${lng}`
  const now = Date.now()
  if (_weatherCache[key] && now - _weatherCache[key].ts < WEATHER_TTL) {
    return _weatherCache[key].data
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
              + `&current=temperature_2m,relative_humidity_2m,weather_code,apparent_temperature&timezone=auto`
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}`
                + `&hourly=pm10,pm2_5&timezone=auto&forecast_days=1`
    const [json, aqJson] = await Promise.all([
      (await fetch(url)).json(),
      (await fetch(aqUrl)).json().catch(() => null),
    ])
    const cur  = json.current
    if (!cur) return null
    const aq = pickCurrentAirQuality(aqJson?.hourly)
    if (aq) {
      cur.pm10 = aq.pm10
      cur.pm2_5 = aq.pm2_5
    }
    _weatherCache[key] = { data: cur, ts: now }
    return cur
  } catch (e) {
    console.warn('weather load failed', e)
    return null
  }
}

/** WMO 코드 → {icon, text} */
function wmoToKr(code) {
  if (code === 0)  return { icon: '☀️', text: '맑음' }
  if (code <= 3)   return { icon: '⛅', text: '구름' }
  if ([45,48].includes(code)) return { icon: '🌫️', text: '안개' }
  if (code <= 55)  return { icon: '🌦️', text: '이슬비' }
  if (code <= 65)  return { icon: '🌧️', text: '비' }
  if (code <= 77)  return { icon: '🌨️', text: '눈' }
  if (code <= 82)  return { icon: '🌦️', text: '소나기' }
  if (code === 95) return { icon: '⛈️', text: '뇌우' }
  return { icon: '🌡️', text: '—' }
}

/**
 * 절대 기온 기반 자연어 안내 (정원 단위)
 * 정상 범위 (10~25°C) → null
 */
function tempAdviceText(temp) {
  if (temp == null) return null
  if (temp < -10) return { icon:'❄️', text:'오늘은 강추위예요. 서리 피해에 꼭 주의하세요.', cold:true }
  if (temp < 0)   return { icon:'🥶', text:'오늘은 영하네요. 냉해에 조심하세요. 화분은 실내로!', cold:true }
  if (temp < 5)   return { icon:'🥶', text:'오늘은 많이 춥네요. 화분을 따뜻한 곳으로 옮겨주세요.', cold:true }
  if (temp < 10)  return { icon:'🌡️', text:'오늘은 쌀쌀해요. 찬 바람을 맞지 않게 해주세요.', cold:true }
  if (temp > 35)  return { icon:'🥵', text:'오늘은 폭염이에요. 마름에 조심하고 물을 자주 확인하세요.', hot:true }
  if (temp > 30)  return { icon:'☀️', text:'오늘은 무더워요. 직사광선을 피하고 충분히 물을 주세요.', hot:true }
  if (temp > 25)  return { icon:'🌡️', text:'오늘은 더워요. 수분이 부족하지 않은지 확인해주세요.', hot:true }
  return null
}

/**
 * 식물별 위험 판정 (개별 식물 단위)
 * min_temp / max_temp 둘 다 null → null (배지 미표시)
 */
function plantTempRisk(temp, plant) {
  if (temp == null || !plant) return null
  const min = plant.min_temp
  const max = plant.max_temp
  if (min == null && max == null) return null
  if (min != null && temp < min) return { type: 'cold', delta: min - temp }
  if (max != null && temp > max) return { type: 'hot',  delta: temp - max }
  return null
}

/**
 * 좌표 → 한국어 동네명 (Nominatim 역지오코딩)
 * 예: { lat:37.20, lng:126.83 } → "화성시 신외리"
 */
async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return ''
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}`
              + `&format=json&accept-language=ko&zoom=14`
    const r = await (await fetch(url, { headers: { 'Accept': 'application/json' } })).json()
    const a = r.address ?? {}
    const city = a.city || a.town || a.county || a.province || a.state || ''
    const dong = a.suburb || a.village || a.neighbourhood || a.quarter || a.hamlet || a.borough || ''
    const txt  = [city, dong].filter(Boolean).join(' ')
    return txt || (r.display_name ?? '').split(',').slice(0, 2).join(' ').trim()
  } catch (e) {
    console.warn('reverse geocode failed', e)
    return ''
  }
}

/**
 * 오늘 시간별 날씨 조회 (2시간 간격 전처리 포함)
 * 반환: [{time, hour, temp, apparent, code}, ...]
 */
async function loadHourlyForecast(lat, lng) {
  if (lat == null || lng == null) return null
  const key = `h:${lat},${lng}`
  const now = Date.now()
  if (_hourlyCache[key] && now - _hourlyCache[key].ts < WEATHER_TTL) {
    return _hourlyCache[key].data
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
              + `&hourly=temperature_2m,apparent_temperature,weather_code&timezone=auto&forecast_days=1`
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}`
                + `&hourly=pm10,pm2_5&timezone=auto&forecast_days=1`
    const [json, aqJson] = await Promise.all([
      (await fetch(url)).json(),
      (await fetch(aqUrl)).json().catch(() => null),
    ])
    const h = json.hourly
    if (!h) return null
    const aqByTime = {}
    ;(aqJson?.hourly?.time ?? []).forEach((t, i) => {
      aqByTime[t] = {
        pm10: roundOrNull(aqJson.hourly.pm10?.[i]),
        pm2_5: roundOrNull(aqJson.hourly.pm2_5?.[i]),
      }
    })
    const result = h.time.map((t, i) => ({
      time:     t,
      hour:     parseInt(t.split('T')[1]),
      temp:     Math.round(h.temperature_2m[i]),
      apparent: Math.round(h.apparent_temperature[i]),
      code:     h.weather_code[i],
      pm10:     aqByTime[t]?.pm10 ?? null,
      pm2_5:    aqByTime[t]?.pm2_5 ?? null,
    }))
    _hourlyCache[key] = { data: result, ts: now }
    return result
  } catch (e) {
    console.warn('hourly weather load failed', e)
    return null
  }
}

window.weatherUtil = {
  loadWeather,
  loadHourlyForecast,
  wmoToKr,
  tempAdviceText,
  plantTempRisk,
  reverseGeocode,
}
