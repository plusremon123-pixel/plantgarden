// ============================================================
// js/watering.js
// 물주기 상태 계산 헬퍼
// DB 기록(last_watered_at)은 사용자가 물준 날짜로 유지하고,
// 화면 판단에서는 충분한 비를 임시 기준일로 반영한다.
// ============================================================

;(function () {
  const FALLBACK_RANGE = {
    '높음': { min: 2, max: 3 },
    '보통': { min: 4, max: 5 },
    '낮음': { min: 7, max: 10 },
  }

  function parseLocalDate(value) {
    if (!value) return null
    const [datePart] = String(value).split('T')
    const [year, month, day] = datePart.split('-').map(Number)
    if (!year || !month || !day) return null
    return new Date(year, month - 1, day)
  }

  function todayLocal() {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }

  function daysSince(value) {
    const date = parseLocalDate(value)
    if (!date) return null
    return Math.max(0, Math.floor((todayLocal() - date) / 86400000))
  }

  function formatElapsed(prefix, days) {
    if (days == null) return `${prefix} 기록 없음`
    if (days === 0) return `${prefix} 오늘`
    return `${prefix} +${days}일`
  }

  function getWaterRange(plant, instance) {
    const fallback = FALLBACK_RANGE[plant?.water_need] ?? FALLBACK_RANGE['보통']
    let min = Number.isInteger(Number(plant?.watering_interval_min)) ? Number(plant.watering_interval_min) : fallback.min
    let max = Number.isInteger(Number(plant?.watering_interval_max)) ? Number(plant.watering_interval_max) : fallback.max

    const type = instance?.cultivation_type || '노지'
    if (['실외 화분', '실내 화분', '온실/하우스'].includes(type)) {
      min -= 1
      max -= 1
    }

    min = Math.max(1, min)
    max = Math.max(min, max)
    return { min, max, type }
  }

  function enoughRainThreshold(type) {
    if (type === '노지') return 5
    if (type === '실외 화분') return 10
    return null
  }

  function getRainBasis(rainSummary, type) {
    const threshold = enoughRainThreshold(type)
    if (!threshold || !rainSummary?.lastRainAt) return null
    if (Number(rainSummary.rainLast48h ?? 0) < threshold) return null
    return rainSummary.lastRainAt
  }

  function latestDate(a, b) {
    const da = parseLocalDate(a)
    const db = parseLocalDate(b)
    if (!da) return b || null
    if (!db) return a || null
    return db > da ? b : a
  }

  function getWaterStatus(instance, plant, rainSummary = null) {
    const range = getWaterRange(plant, instance)
    const rainBasis = getRainBasis(rainSummary, range.type)
    const effectiveDate = latestDate(instance?.last_watered_at, rainBasis)
    const source = rainBasis && effectiveDate === rainBasis ? '비 기준' : '물주기'
    const days = daysSince(effectiveDate)

    if (days == null) {
      return {
        status: 'none',
        tone: 'muted',
        label: '물주기 기록 없음',
        source,
        days,
        range,
        effectiveDate,
        rainBasis,
      }
    }

    let status = 'ok'
    let tone = 'ok'
    let label = formatElapsed(source, days)

    if (days >= range.min && days <= range.max) {
      status = 'check'
      tone = 'check'
      label = '흙마름 확인'
    } else if (days > range.max) {
      status = 'due'
      tone = 'danger'
      label = '물주기 필요'
    }

    return { status, tone, label, source, days, range, effectiveDate, rainBasis }
  }

  function formatRange(range) {
    if (!range) return ''
    return range.min === range.max ? `${range.min}일마다 확인` : `${range.min}~${range.max}일마다 확인`
  }

  window.wateringUtil = {
    daysSince,
    formatElapsed,
    getWaterRange,
    getWaterStatus,
    formatRange,
  }
})()
