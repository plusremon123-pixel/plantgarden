// ============================================================
// js/weather.js
// 공통 날씨 + 역지오코딩 + 온도 위험 판정 헬퍼
// ============================================================

const _weatherCache = {}
const _hourlyCache  = {}
const _dailyCache   = {}
const _rainCache    = {}
const WEATHER_TTL = 10 * 60 * 1000   // 10분

function roundOrNull(v) {
  return v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v))
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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

async function loadKmaWeather(type, lat, lng) {
  if (!window._supabase?.functions?.invoke) return null
  try {
    const { data, error } = await window._supabase.functions.invoke('kma-weather', {
      body: { type, lat, lng },
    })
    if (error) throw error
    if (!data?.ok) throw new Error(data?.error || '기상청 날씨 응답 오류')
    return data.data ?? null
  } catch (e) {
    console.warn(`kma weather ${type} failed`, e)
    return null
  }
}

async function loadOpenMeteoAirQuality(lat, lng, days = 1) {
  try {
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}`
                + `&hourly=pm10,pm2_5&timezone=auto&forecast_days=${days}`
    const aqJson = await (await fetch(aqUrl)).json()
    return pickCurrentAirQuality(aqJson?.hourly)
  } catch (e) {
    console.warn('air quality load failed', e)
    return null
  }
}

/**
 * 좌표로 현재 날씨 조회 (Open-Meteo, 무료, API 키 불필요)
 * 10분 캐시 — 동일 좌표 재요청 방지
 * 실패 시 null 반환 (앱이 조용히 동작하도록)
 */
async function loadWeather(lat, lng) {
  if (lat == null || lng == null) return null
  const key = `${lat},${lng}`
  const now = Date.now()
  if (_weatherCache[key] && now - _weatherCache[key].ts < WEATHER_TTL) {
    return _weatherCache[key].data
  }
  const kma = await loadKmaWeather('current', lat, lng)
  if (kma) {
    if (kma.pm10 == null || kma.pm2_5 == null) {
      const aq = await loadOpenMeteoAirQuality(lat, lng, 1)
      if (aq) {
        kma.pm10 = aq.pm10
        kma.pm2_5 = aq.pm2_5
      }
    }
    _weatherCache[key] = { data: kma, ts: now }
    return kma
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
              + `&current=temperature_2m,relative_humidity_2m,weather_code,apparent_temperature,wind_speed_10m,precipitation&wind_speed_unit=ms&timezone=auto`
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

function compactAddressParts(address) {
  const a = address ?? {}
  const parts = [
    a.state || a.province || a.region,
    a.city_district || a.borough || a.county || a.city || a.town,
    a.suburb || a.neighbourhood || a.quarter || a.village || a.hamlet,
  ]

  return parts
    .filter(Boolean)
    .map(part => String(part).trim())
    .filter((part, idx, arr) => part && arr.indexOf(part) === idx)
}

/**
 * 좌표 → 한국어 행정주소 (Nominatim 역지오코딩)
 * 예: { lat:37.59, lng:127.09 } → "서울특별시 > 중랑구 > 망우동"
 */
async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return ''
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}`
              + `&format=json&accept-language=ko&zoom=14`
    const r = await (await fetch(url, { headers: { 'Accept': 'application/json' } })).json()
    const parts = compactAddressParts(r.address)
    if (parts.length) return parts.join(' > ')
    return (r.display_name ?? '').split(',').slice(0, 3).map(s => s.trim()).filter(Boolean).join(' > ')
  } catch (e) {
    console.warn('reverse geocode failed', e)
    return ''
  }
}

/**
 * 오늘~내일 시간별 날씨 조회 (2시간 간격 전처리 포함)
 * 반환: [{time, hour, temp, apparent, code, precipitation, pm10, pm2_5}, ...]
 */
async function loadHourlyForecast(lat, lng) {
  if (lat == null || lng == null) return null
  const key = `h:${lat},${lng}`
  const now = Date.now()
  if (_hourlyCache[key] && now - _hourlyCache[key].ts < WEATHER_TTL) {
    return _hourlyCache[key].data
  }
  const kma = await loadKmaWeather('hourly', lat, lng)
  if (kma?.length) {
    _hourlyCache[key] = { data: kma, ts: now }
    return kma
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
              + `&hourly=temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m&wind_speed_unit=ms&timezone=auto&forecast_days=2`
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}`
                + `&hourly=pm10,pm2_5&timezone=auto&forecast_days=2`
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
      precipitation: Number.isFinite(Number(h.precipitation?.[i])) ? Number(h.precipitation[i]) : null,
      windSpeed: Number.isFinite(Number(h.wind_speed_10m?.[i])) ? Number(h.wind_speed_10m[i]) : null,
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

/**
 * 주간 날씨 요약 조회.
 * 반환: [{date, code, tempMax, tempMin, apparentMax, apparentMin, rain, rainProb, windMax, pm10, pm2_5}, ...]
 */
async function loadDailyForecast(lat, lng) {
  if (lat == null || lng == null) return null
  const key = `d:${lat},${lng}`
  const now = Date.now()
  if (_dailyCache[key] && now - _dailyCache[key].ts < WEATHER_TTL) {
    return _dailyCache[key].data
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
              + `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&wind_speed_unit=ms&timezone=auto&forecast_days=7`
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}`
                + `&hourly=pm10,pm2_5&timezone=auto&forecast_days=5`
    const [json, aqJson] = await Promise.all([
      (await fetch(url)).json(),
      (await fetch(aqUrl)).json().catch(() => null),
    ])
    const d = json.daily
    if (!d?.time?.length) return null

    const aqByDate = {}
    ;(aqJson?.hourly?.time ?? []).forEach((t, i) => {
      const date = t.slice(0, 10)
      aqByDate[date] = aqByDate[date] ?? { pm10: [], pm2_5: [] }
      const pm10 = Number(aqJson.hourly.pm10?.[i])
      const pm25 = Number(aqJson.hourly.pm2_5?.[i])
      if (Number.isFinite(pm10)) aqByDate[date].pm10.push(pm10)
      if (Number.isFinite(pm25)) aqByDate[date].pm2_5.push(pm25)
    })
    const avg = arr => arr?.length ? Math.round(arr.reduce((sum, v) => sum + v, 0) / arr.length) : null

    const data = d.time.map((date, i) => ({
      date,
      code: d.weather_code?.[i],
      tempMax: roundOrNull(d.temperature_2m_max?.[i]),
      tempMin: roundOrNull(d.temperature_2m_min?.[i]),
      apparentMax: roundOrNull(d.apparent_temperature_max?.[i]),
      apparentMin: roundOrNull(d.apparent_temperature_min?.[i]),
      rain: Number.isFinite(Number(d.precipitation_sum?.[i])) ? Math.round(Number(d.precipitation_sum[i]) * 10) / 10 : null,
      rainProb: roundOrNull(d.precipitation_probability_max?.[i]),
      windMax: roundOrNull(d.wind_speed_10m_max?.[i]),
      pm10: avg(aqByDate[date]?.pm10),
      pm2_5: avg(aqByDate[date]?.pm2_5),
    }))
    _dailyCache[key] = { data, ts: now }
    return data
  } catch (e) {
    console.warn('daily weather load failed', e)
    return null
  }
}

/**
 * 최근/예보 강수 요약.
 * DB에 저장하지 않고 물주기 판단용으로만 사용한다.
 */
async function loadRainSummary(lat, lng) {
  if (lat == null || lng == null) return null
  const key = `r:${lat},${lng}`
  const now = Date.now()
  if (_rainCache[key] && now - _rainCache[key].ts < WEATHER_TTL) {
    return _rainCache[key].data
  }
  const kma = await loadKmaWeather('rain', lat, lng)
  if (kma) {
    _rainCache[key] = { data: kma, ts: now }
    return kma
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
              + `&hourly=precipitation&timezone=auto&past_days=2&forecast_days=1`
    const json = await (await fetch(url)).json()
    const h = json.hourly
    if (!h?.time?.length) return null

    const nowMs = Date.now()
    let rainLast24h = 0
    let rainLast48h = 0
    let rainTodayForecast = 0
    let lastRainAt = null
    const todayKey = localDateKey()

    h.time.forEach((t, i) => {
      const amount = Number(h.precipitation?.[i] ?? 0)
      if (!Number.isFinite(amount) || amount <= 0) return
      const ts = new Date(t).getTime()
      const age = nowMs - ts
      if (age >= 0 && age <= 24 * 60 * 60 * 1000) rainLast24h += amount
      if (age >= 0 && age <= 48 * 60 * 60 * 1000) {
        rainLast48h += amount
        if (!lastRainAt || new Date(t) > new Date(lastRainAt)) lastRainAt = t
      }
      if (age < 0 && t.slice(0, 10) === todayKey) rainTodayForecast += amount
    })

    const data = {
      rainLast24h: Math.round(rainLast24h * 10) / 10,
      rainLast48h: Math.round(rainLast48h * 10) / 10,
      rainTodayForecast: Math.round(rainTodayForecast * 10) / 10,
      lastRainAt,
    }
    _rainCache[key] = { data, ts: now }
    return data
  } catch (e) {
    console.warn('rain summary load failed', e)
    return null
  }
}

window.weatherUtil = {
  loadWeather,
  loadHourlyForecast,
  loadDailyForecast,
  loadRainSummary,
  wmoToKr,
  tempAdviceText,
  plantTempRisk,
  reverseGeocode,
}
