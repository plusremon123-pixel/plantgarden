// ============================================================
// supabase/functions/kma-weather/index.ts
//
// 기상청 단기예보 + 에어코리아 미세먼지 프록시
//
// 배포:
//   npx supabase secrets set KMA_SERVICE_KEY=your_data_go_kr_key
//   npx supabase secrets set AIRKOREA_SERVICE_KEY=your_data_go_kr_key
//   npx supabase functions deploy kma-weather --no-verify-jwt
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const KMA_BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
const AIR_BASE = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc"

type Dict = Record<string, string>

function pad2(n: number) {
  return String(n).padStart(2, "0")
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function formatKstDate(date: Date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`
}

function formatLocalDate(dateKey: string) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`
}

function latestUltraBase(now = kstNow()) {
  const d = new Date(now)
  if (d.getUTCMinutes() < 45) d.setUTCHours(d.getUTCHours() - 1)
  return { baseDate: formatKstDate(d), baseTime: `${pad2(d.getUTCHours())}00` }
}

function latestVillageBase(now = kstNow()) {
  const bases = [2, 5, 8, 11, 14, 17, 20, 23]
  const d = new Date(now)
  let hour = d.getUTCHours()
  let base = bases.filter((h) => h <= hour).at(-1)
  if (base == null || (hour === base && d.getUTCMinutes() < 10)) {
    d.setUTCDate(d.getUTCDate() - 1)
    base = 23
  }
  return { baseDate: formatKstDate(d), baseTime: `${pad2(base)}00` }
}

function localDateKey(date = kstNow()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function toKmaGrid(lat: number, lng: number) {
  const RE = 6371.00877
  const GRID = 5.0
  const SLAT1 = 30.0
  const SLAT2 = 60.0
  const OLON = 126.0
  const OLAT = 38.0
  const XO = 43
  const YO = 136
  const DEGRAD = Math.PI / 180.0
  const re = RE / GRID
  const slat1 = SLAT1 * DEGRAD
  const slat2 = SLAT2 * DEGRAD
  const olon = OLON * DEGRAD
  const olat = OLAT * DEGRAD
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5)
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn)
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5)
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5)
  ro = re * sf / Math.pow(ro, sn)
  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5)
  ra = re * sf / Math.pow(ra, sn)
  let theta = lng * DEGRAD - olon
  if (theta > Math.PI) theta -= 2.0 * Math.PI
  if (theta < -Math.PI) theta += 2.0 * Math.PI
  theta *= sn
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  }
}

function withRawServiceKey(base: string, path: string, params: Dict, key: string) {
  const query = new URLSearchParams({ ...params, dataType: "JSON" }).toString()
  return `${base}/${path}?${query}&serviceKey=${key}`
}

async function fetchDataGoKr(base: string, path: string, params: Dict, envName: string) {
  const key = Deno.env.get(envName)
  if (!key) throw new Error(`${envName} 환경변수 없음`)
  const url = withRawServiceKey(base, path, params, key)
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
  const json = await res.json()
  const header = json?.response?.header
  if (header && header.resultCode !== "00") throw new Error(`${path} ${header.resultMsg ?? header.resultCode}`)
  return json?.response?.body?.items?.item ?? []
}

function numberOrNull(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function roundOrNull(value: unknown) {
  const n = numberOrNull(value)
  return n == null ? null : Math.round(n)
}

function precipValue(value: unknown) {
  if (value == null) return 0
  const text = String(value).trim()
  if (!text || text === "강수없음" || text === "0") return 0
  if (text.includes("1mm 미만")) return 0.5
  const match = text.match(/([\d.]+)/)
  return match ? Number(match[1]) : 0
}

function kmaCode(sky: unknown, pty: unknown) {
  const p = Number(pty ?? 0)
  if ([1, 5].includes(p)) return 61
  if ([2, 6].includes(p)) return 71
  if ([3, 7].includes(p)) return 73
  if (p === 4) return 80
  const s = Number(sky ?? 1)
  if (s === 1) return 0
  if (s === 3) return 2
  if (s === 4) return 3
  return 0
}

function apparentTemperature(temp: number | null, humidity: number | null, wind: number | null) {
  if (temp == null) return null
  const h = humidity ?? 50
  const w = wind ?? 1
  const e = (h / 100) * 6.105 * Math.exp((17.27 * temp) / (237.7 + temp))
  return Math.round((temp + 0.33 * e - 0.7 * w - 4) * 10) / 10
}

function groupByDateTime(items: any[]) {
  const out: Record<string, Record<string, string>> = {}
  for (const item of items) {
    const date = item.fcstDate
    const time = item.fcstTime
    if (!date || !time || !item.category) continue
    const key = `${date}${time}`
    out[key] = out[key] ?? { fcstDate: date, fcstTime: time }
    out[key][item.category] = item.fcstValue
  }
  return out
}

function itemMap(items: any[]) {
  return items.reduce((acc: Record<string, string>, item) => {
    if (item.category) acc[item.category] = item.obsrValue
    return acc
  }, {})
}

async function inferSidoName(lat: number, lng: number) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ko&zoom=10`
    const json = await (await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8_000) })).json()
    const text = [json?.address?.state, json?.address?.province, json?.address?.city].filter(Boolean).join(" ")
    if (text.includes("서울")) return "서울"
    if (text.includes("부산")) return "부산"
    if (text.includes("대구")) return "대구"
    if (text.includes("인천")) return "인천"
    if (text.includes("광주")) return "광주"
    if (text.includes("대전")) return "대전"
    if (text.includes("울산")) return "울산"
    if (text.includes("세종")) return "세종"
    if (text.includes("경기")) return "경기"
    if (text.includes("강원")) return "강원"
    if (text.includes("충북")) return "충북"
    if (text.includes("충남")) return "충남"
    if (text.includes("전북")) return "전북"
    if (text.includes("전남")) return "전남"
    if (text.includes("경북")) return "경북"
    if (text.includes("경남")) return "경남"
    if (text.includes("제주")) return "제주"
  } catch {
    // 미세먼지는 보조 정보라 주소 추론 실패를 무시한다.
  }
  return null
}

async function loadAirQuality(lat: number, lng: number) {
  try {
    const sidoName = await inferSidoName(lat, lng)
    if (!sidoName) return null
    const items = await fetchDataGoKr(AIR_BASE, "getCtprvnRltmMesureDnsty", {
      returnType: "json",
      numOfRows: "100",
      pageNo: "1",
      sidoName,
      ver: "1.3",
    }, "AIRKOREA_SERVICE_KEY")
    const nums = (key: string) => items
      .map((it: any) => Number(it[key]))
      .filter((n: number) => Number.isFinite(n) && n >= 0)
    const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((sum, n) => sum + n, 0) / arr.length) : null
    return { pm10: avg(nums("pm10Value")), pm2_5: avg(nums("pm25Value")), sidoName }
  } catch (err) {
    console.warn("air quality load failed", err)
    return null
  }
}

async function currentWeather(lat: number, lng: number) {
  const { nx, ny } = toKmaGrid(lat, lng)
  const ultra = latestUltraBase()
  const [ncst, fcst, aq] = await Promise.all([
    fetchDataGoKr(KMA_BASE, "getUltraSrtNcst", {
      numOfRows: "60",
      pageNo: "1",
      base_date: ultra.baseDate,
      base_time: ultra.baseTime,
      nx: String(nx),
      ny: String(ny),
    }, "KMA_SERVICE_KEY"),
    fetchDataGoKr(KMA_BASE, "getUltraSrtFcst", {
      numOfRows: "100",
      pageNo: "1",
      base_date: ultra.baseDate,
      base_time: ultra.baseTime,
      nx: String(nx),
      ny: String(ny),
    }, "KMA_SERVICE_KEY").catch(() => []),
    loadAirQuality(lat, lng),
  ])
  const obs = itemMap(ncst)
  const firstFcst = Object.values(groupByDateTime(fcst)).sort((a: any, b: any) => `${a.fcstDate}${a.fcstTime}`.localeCompare(`${b.fcstDate}${b.fcstTime}`))[0] as any
  const temp = roundOrNull(obs.T1H)
  const humidity = roundOrNull(obs.REH)
  const wind = numberOrNull(obs.WSD)
  return {
    temperature_2m: temp,
    relative_humidity_2m: humidity,
    weather_code: kmaCode(firstFcst?.SKY, obs.PTY ?? firstFcst?.PTY),
    apparent_temperature: apparentTemperature(temp, humidity, wind),
    wind_speed_10m: wind,
    precipitation: numberOrNull(obs.RN1) ?? 0,
    pm10: aq?.pm10 ?? null,
    pm2_5: aq?.pm2_5 ?? null,
    source: "kma",
  }
}

async function hourlyForecast(lat: number, lng: number) {
  const { nx, ny } = toKmaGrid(lat, lng)
  const base = latestVillageBase()
  const [items, aq] = await Promise.all([
    fetchDataGoKr(KMA_BASE, "getVilageFcst", {
      numOfRows: "900",
      pageNo: "1",
      base_date: base.baseDate,
      base_time: base.baseTime,
      nx: String(nx),
      ny: String(ny),
    }, "KMA_SERVICE_KEY"),
    loadAirQuality(lat, lng),
  ])
  const now = kstNow()
  const nowKey = `${formatKstDate(now)}${pad2(now.getUTCHours())}00`
  return Object.values(groupByDateTime(items))
    .filter((row: any) => `${row.fcstDate}${row.fcstTime}` >= nowKey)
    .sort((a: any, b: any) => `${a.fcstDate}${a.fcstTime}`.localeCompare(`${b.fcstDate}${b.fcstTime}`))
    .slice(0, 48)
    .map((row: any) => {
      const temp = roundOrNull(row.TMP ?? row.T1H)
      const humidity = roundOrNull(row.REH)
      const wind = numberOrNull(row.WSD)
      return {
        time: `${formatLocalDate(row.fcstDate)}T${row.fcstTime.slice(0, 2)}:00`,
        hour: Number(row.fcstTime.slice(0, 2)),
        temp,
        apparent: roundOrNull(apparentTemperature(temp, humidity, wind)),
        code: kmaCode(row.SKY, row.PTY),
        precipitation: precipValue(row.PCP ?? row.RN1),
        windSpeed: wind,
        pm10: aq?.pm10 ?? null,
        pm2_5: aq?.pm2_5 ?? null,
      }
    })
}

async function dailyForecast(lat: number, lng: number) {
  const hourly = await hourlyForecast(lat, lng)
  const byDate: Record<string, any[]> = {}
  for (const row of hourly) {
    const date = row.time.slice(0, 10)
    byDate[date] = byDate[date] ?? []
    byDate[date].push(row)
  }
  return Object.entries(byDate).slice(0, 3).map(([date, rows]) => {
    const temps = rows.map((r) => r.temp).filter((v) => v != null)
    const apps = rows.map((r) => r.apparent).filter((v) => v != null)
    const rain = rows.reduce((sum, r) => sum + (Number(r.precipitation) || 0), 0)
    const wet = rows.filter((r) => Number(r.precipitation) > 0).length
    return {
      date,
      code: rows.find((r) => Number(r.precipitation) > 0)?.code ?? rows[Math.floor(rows.length / 2)]?.code ?? 0,
      tempMax: temps.length ? Math.max(...temps) : null,
      tempMin: temps.length ? Math.min(...temps) : null,
      apparentMax: apps.length ? Math.max(...apps) : null,
      apparentMin: apps.length ? Math.min(...apps) : null,
      rain: Math.round(rain * 10) / 10,
      rainProb: rows.length ? Math.round((wet / rows.length) * 100) : null,
      windMax: rows
        .map((r) => Number(r.windSpeed))
        .filter((v) => Number.isFinite(v))
        .reduce((max, v) => Math.max(max, v), 0) || null,
      pm10: rows[0]?.pm10 ?? null,
      pm2_5: rows[0]?.pm2_5 ?? null,
    }
  })
}

async function rainSummary(lat: number, lng: number) {
  const cur = await currentWeather(lat, lng)
  const hourly = await hourlyForecast(lat, lng)
  const today = localDateKey()
  const rainTodayForecast = hourly
    .filter((row) => row.time.slice(0, 10) === today)
    .reduce((sum, row) => sum + (Number(row.precipitation) || 0), 0)
  return {
    rainLast24h: Math.round((Number(cur.precipitation) || 0) * 10) / 10,
    rainLast48h: Math.round((Number(cur.precipitation) || 0) * 10) / 10,
    rainTodayForecast: Math.round(rainTodayForecast * 10) / 10,
    lastRainAt: Number(cur.precipitation) > 0 ? new Date().toISOString() : null,
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const { type, lat, lng } = await req.json()
    const latitude = Number(lat)
    const longitude = Number(lng)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("lat/lng 필요")

    let data
    if (type === "current") data = await currentWeather(latitude, longitude)
    else if (type === "hourly") data = await hourlyForecast(latitude, longitude)
    else if (type === "daily") data = await dailyForecast(latitude, longitude)
    else if (type === "rain") data = await rainSummary(latitude, longitude)
    else throw new Error("지원하지 않는 type")

    return new Response(JSON.stringify({ ok: true, source: "kma-airkorea", data }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }
})
