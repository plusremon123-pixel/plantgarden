// ============================================================
// js/butler.js
// 정원집사: 서버에 저장하지 않는 클라이언트 캐시형 정원 도우미
// ============================================================

;(function () {
  const CACHE_KEY = 'plantGarden.butler.cache.v1'
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
  const MAX_CACHED_MESSAGES = 40

  const QUICK_QUESTIONS = [
    { label: '물 줘도 돼?', question: '오늘 물 줘도 돼?' },
    { label: '오늘 할 일', question: '오늘 할일 알려줘' },
    { label: '무얼 심어?', question: '정원에 무얼 심을까?' },
    { label: '어디 심어?', question: '어디에 심어야 해?' },
    { label: '내 식물 찾기', question: '내 식물 찾아줘' },
    { label: '도감 찾기', question: '도감에서 찾아줘' },
  ]

  const state = {
    open: false,
    listening: false,
    messages: [],
    recognition: null,
    loading: false,
    draft: '',
    cacheLoaded: false,
    recommendFlow: null,
    plantingFlow: null,
  }

  function getStorage() {
    try {
      const testKey = `${CACHE_KEY}.test`
      window.localStorage.setItem(testKey, '1')
      window.localStorage.removeItem(testKey)
      return window.localStorage
    } catch (_) {
      return null
    }
  }

  function safeMessage(message) {
    if (!message || !['user', 'bot'].includes(message.role)) return null
    const html = String(message.html ?? '').slice(0, 8000)
    const actions = Array.isArray(message.actions)
      ? message.actions.slice(0, 4).map(action => ({
          label: String(action.label ?? '').slice(0, 40),
          href: action.href ? String(action.href).slice(0, 300) : undefined,
          question: action.question ? String(action.question).slice(0, 120) : undefined,
          mode: action.mode ? String(action.mode).slice(0, 40) : undefined,
          value: action.value ? String(action.value).slice(0, 80) : undefined,
          selected: Boolean(action.selected),
        })).filter(action => action.label && (action.href || action.question))
      : []
    return actions.length ? { role: message.role, html, actions } : { role: message.role, html }
  }

  function loadCache() {
    if (state.cacheLoaded) return
    state.cacheLoaded = true
    const storage = getStorage()
    if (!storage) return
    try {
      const raw = storage.getItem(CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      const updatedAt = Number(parsed.updatedAt ?? 0)
      if (!updatedAt || Date.now() - updatedAt > CACHE_TTL_MS) {
        storage.removeItem(CACHE_KEY)
        return
      }
      if (Array.isArray(parsed.messages)) {
        state.messages = parsed.messages
          .map(safeMessage)
          .filter(Boolean)
          .slice(-MAX_CACHED_MESSAGES)
      }
      state.draft = String(parsed.draft ?? '').slice(0, 200)
    } catch (_) {
      storage.removeItem(CACHE_KEY)
    }
  }

  function saveCache(draftValue) {
    const storage = getStorage()
    if (!storage) return
    const input = document.getElementById('butler-input')
    state.draft = String(draftValue ?? input?.value ?? state.draft ?? '').slice(0, 200)
    try {
      storage.setItem(CACHE_KEY, JSON.stringify({
        updatedAt: Date.now(),
        draft: state.draft,
        messages: state.messages.map(safeMessage).filter(Boolean).slice(-MAX_CACHED_MESSAGES),
      }))
    } catch (_) {}
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]))
  }

  function hasBatchim(value) {
    const chars = [...String(value ?? '').trim()]
    const ch = chars[chars.length - 1]
    if (!ch) return false
    const code = ch.charCodeAt(0) - 0xac00
    return code >= 0 && code <= 11171 && code % 28 !== 0
  }

  function topicLabel(value) {
    const text = String(value ?? '').trim()
    return `${text}${hasBatchim(text) ? '은' : '는'}`
  }

  function todayStr() {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  function addDaysKey(dateKey, days) {
    const base = dateKey ? new Date(`${dateKey}T00:00:00`) : new Date()
    base.setDate(base.getDate() + days)
    return base.toISOString().slice(0, 10)
  }

  function locLabel(loc, allLocs) {
    if (!loc) return '위치 없음'
    if (!loc.parent_id) return loc.name
    const parent = allLocs.find(row => row.id === loc.parent_id)
    return parent ? `${parent.name}/${loc.name}` : loc.name
  }

  function instanceUnit(inst) {
    const text = `${inst?.plants?.name ?? ''} ${inst?.plants?.category ?? ''} ${(inst?.plants?.plant_types ?? []).join(' ')}`
    return /유실수|과수|블루베리|나무|관목|장미/.test(text) ? '주' : '개'
  }

  function existingPlantSummary(instances = [], limit = 5) {
    if (!instances.length) return ''
    const groups = new Map()
    instances.forEach(inst => {
      const name = inst?.plants?.name || inst?.plant_name || '식물'
      const item = groups.get(name) || { name, quantity: 0, unit: instanceUnit(inst) }
      item.quantity += Number(inst?.quantity) || 1
      groups.set(name, item)
    })
    const rows = [...groups.values()]
    const shown = rows.slice(0, limit).map(item => `${item.name} ${item.quantity}${item.unit}`).join(', ')
    return rows.length > limit ? `${shown} 외 ${rows.length - limit}종` : shown
  }

  function compatibilityContextText(instances = [], pressure = {}) {
    if (!instances.length) return '아직 심어진 식물이 적어 햇빛과 흙 조건에 맞는 첫 조합으로 추천했어요.'
    if (pressure.airflowRisk) return '이미 키가 있거나 밀도가 있는 편이라 통풍을 막지 않는 식물과 낮은 보완 식재를 우선했어요.'
    if (pressure.rootCompetition) return '목본류가 있어 뿌리 경쟁을 키우지 않는 낮은 초화류와 가장자리 식재를 우선했어요.'
    if (pressure.highDensity) return '식재량이 있는 구역이라 큰 식물보다 빈틈을 채우는 보완 식물을 우선했어요.'
    const categories = summarizeCategories(instances.map(inst => inst?.plants?.category).filter(Boolean))
    return categories
      ? `${categories} 구성이어서 햇빛, 흙, 물주기 리듬이 크게 어긋나지 않는 식물로 골랐어요.`
      : '현재 심어진 식물과 간격, 통풍, 관리 리듬을 함께 보고 골랐어요.'
  }

  function locationForInstance(inst, allLocs) {
    return allLocs.find(loc => loc.id === inst.location_id) ?? null
  }

  function weatherLocationFor(loc, allLocs) {
    if (!loc) return null
    if (loc.level === 2 && loc.parent_id) return allLocs.find(row => row.id === loc.parent_id) ?? loc
    return loc
  }

  async function loadBaseData() {
    const [locations, instances] = await Promise.all([
      window.locationsApi?.getAll ? window.locationsApi.getAll() : Promise.resolve([]),
      window.gardenApi?.listAll ? window.gardenApi.listAll() : Promise.resolve([]),
    ])
    return { locations, instances }
  }

  async function loadRainByLocation(instances, locations) {
    if (!window.weatherUtil?.loadRainSummary) return {}
    const weatherLocs = new Map()
    instances.forEach(inst => {
      const loc = locationForInstance(inst, locations)
      const weatherLoc = weatherLocationFor(loc, locations)
      if (weatherLoc?.lat && weatherLoc?.lng) weatherLocs.set(weatherLoc.id, weatherLoc)
    })

    const entries = await Promise.all([...weatherLocs.values()].map(async loc => {
      try {
        return [loc.id, await window.weatherUtil.loadRainSummary(loc.lat, loc.lng)]
      } catch (_) {
        return [loc.id, null]
      }
    }))
    return Object.fromEntries(entries)
  }

  function findScopeText(text, locations, instances) {
    const q = text.replace(/\s+/g, '')
    const normalizeScope = value => String(value ?? '')
      .replace(/\s+/g, '')
      .replace(/(화단|정원|구역|자리|쪽|편)$/g, '')
      .replace(/중앙/g, '가운데')
    const loc = locations
      .map(row => {
        const name = String(row.name ?? '').replace(/\s+/g, '')
        const shortName = normalizeScope(row.name)
        const normalizedName = normalizeScope(name)
        const query = normalizeScope(q)
        const score = name && q.includes(name) ? 3 : shortName && query.includes(shortName) ? 2 : normalizedName && query.includes(normalizedName) ? 2 : 0
        return { row, score }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || String(b.row.name ?? '').length - String(a.row.name ?? '').length)[0]?.row
    const plantName = instances
      .map(inst => inst.plants?.name)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .find(name => q.includes(String(name).replace(/\s+/g, '')))
    return { loc, plantName }
  }

  function filterInstancesByScope(instances, locations, scope) {
    let rows = [...instances]
    if (scope.loc) {
      const childIds = new Set(locations.filter(loc => loc.parent_id === scope.loc.id).map(loc => loc.id))
      childIds.add(scope.loc.id)
      rows = rows.filter(inst => childIds.has(inst.location_id))
    }
    if (scope.plantName) {
      rows = rows.filter(inst => inst.plants?.name === scope.plantName)
    }
    return rows
  }

  function groupWaterStatuses(rows, locations, rainByLocation) {
    const grouped = { due: [], check: [], ok: [], none: [] }
    rows.forEach(inst => {
      const loc = locationForInstance(inst, locations)
      const weatherLoc = weatherLocationFor(loc, locations)
      const sunlight = window.locationUtil?.getEffectiveSunlight
        ? window.locationUtil.getEffectiveSunlight(inst.location_id, locations).value
        : null
      const rain = weatherLoc ? rainByLocation[weatherLoc.id] : null
      const status = window.wateringUtil.getWaterStatus(inst, inst.plants, rain, { sunlight })
      const item = { inst, status, location: locLabel(loc, locations) }
      ;(grouped[status.status] ?? grouped.ok).push(item)
    })
    return grouped
  }

  function rainDecision(rainByLocation) {
    const summaries = Object.values(rainByLocation ?? {}).filter(Boolean)
    const rainNow = summaries.some(rain => Number(rain.rainLast24h ?? 0) > 0)
    const rainSoon = summaries.some(rain => Number(rain.rainTodayForecast ?? 0) > 0)
    const enough = summaries.some(rain => Number(rain.rainLast48h ?? 0) >= 5)
    if (rainNow || enough) {
      return {
        level: 'pause',
        title: '오늘은 물주기 쉬세요',
        text: '비가 이미 왔거나 충분히 왔을 가능성이 있어요. 흙이 젖어 있으면 물을 주지 마세요.',
      }
    }
    if (rainSoon) {
      return {
        level: 'wait',
        title: '비 먼저 확인해 주세요',
        text: '오늘 비 예보가 있어요. 급하지 않다면 비가 지난 뒤 흙 상태를 보고 주세요.',
      }
    }
    return null
  }

  function itemList(items, max = 5) {
    if (!items.length) return ''
    const shown = items.slice(0, max).map(item => {
      const name = item.inst?.plants?.name ?? item.name ?? '식물'
      const loc = item.location ? ` · ${item.location}` : ''
      return `<li>${escapeHtml(name)}${escapeHtml(loc)}</li>`
    }).join('')
    const more = items.length > max ? `<li>외 ${items.length - max}개 더 있어요.</li>` : ''
    return `<ul class="butler-list">${shown}${more}</ul>`
  }

  const RECOMMEND_STEPS = [
    {
      key: 'locationId',
      title: '어느 정원에 심을까요?',
      note: '꾸미고 싶은 정원이나 구역을 골라주세요.',
      dynamic: 'locations',
    },
    {
      key: 'gardenStyle',
      title: '어떤 느낌으로 보완할까요?',
      note: '이 구역 환경에 맞는 큰 방향만 골라주세요.',
      options: ['꽃 위주', '허브', '꽃+허브', '나무·관목', '채소·먹거리', '알아서'],
    },
    {
      key: 'plantingType',
      title: '어떻게 추가할까요?',
      note: '현재 구역 상태에 맞춰 추가 식재 방식을 골라주세요.',
      options: answers => plantingTypeOptionsForAnswers(answers),
    },
    {
      key: 'potCount',
      title: '화분은 몇 개인가요?',
      note: '화분 개수에 맞춰 추천 수량을 잡을게요.',
      when: answers => isPotPlanting(answers.plantingType),
      options: ['1개', '2~3개', '4~5개', '6개 이상'],
    },
    {
      key: 'potSize',
      title: '화분 크기는 어느 정도인가요?',
      note: '작은 화분에는 뿌리 부담이 적은 식물을 우선 추천해요.',
      when: answers => isPotPlanting(answers.plantingType),
      options: ['작은 화분', '보통 화분', '큰 화분', '긴 화분·플랜터'],
    },
    {
      key: 'groundSize',
      title: '심을 공간은 어느 정도인가요?',
      note: '숫자보다 눈대중으로 고를 수 있게 준비했어요.',
      when: answers => !isPotPlanting(answers.plantingType),
      options: ['한 뼘 자리', '두 손 너비', '한두 걸음 자리', '작은 돗자리 정도', '큰 돗자리 이상', '잘 모르겠어요'],
    },
    {
      key: 'tags',
      title: '원하는 느낌을 골라주세요',
      note: '최대 3개까지 고르면 그 느낌을 우선해서 조합할게요.',
      multi: true,
      options: ['꽃 오래 피는 것', '월동 잘되는 것', '관리 쉬운 것', '향기 좋은 것', '벌·나비 오는 것', '봄에 화사하게', '여름까지 오래', '흰색 중심', '노랑 중심', '분홍 중심', '보라 중심', '앞쪽 낮게', '포인트 식물'],
    },
  ]

  const SCALE_META = {
    '화분 1개': { sqm: 0.25, kinds: 1, label: '화분 1개', maxTotal: 2 },
    '화분 2~3개': { sqm: 0.6, kinds: 3, label: '화분 2~3개', maxTotal: 7 },
    '화분 4~5개': { sqm: 1, kinds: 4, label: '화분 4~5개', maxTotal: 12 },
    '화분 6개 이상': { sqm: 1.4, kinds: 5, label: '화분 6개 이상', maxTotal: 18 },
    '한 뼘 자리': { sqm: 0.25, kinds: 2, label: '한 뼘 자리', maxTotal: 5 },
    '두 손 너비': { sqm: 0.6, kinds: 2, label: '두 손 너비', maxTotal: 9 },
    '한두 걸음 자리': { sqm: 1.5, kinds: 3, label: '한두 걸음 자리', maxTotal: 18 },
    '작은 돗자리 정도': { sqm: 3, kinds: 4, label: '작은 돗자리 정도', maxTotal: 32 },
    '큰 돗자리 이상': { sqm: 5.5, kinds: 5, label: '큰 돗자리 이상', maxTotal: 55 },
    '잘 모르겠어요': { sqm: 1.5, kinds: 3, label: '작은 구역 기준', maxTotal: 18 },
  }

  const STYLE_CATEGORY_MAP = {
    '꽃 위주': ['꽃', '장미', '구근'],
    허브: ['허브'],
    '꽃+허브': ['꽃', '장미', '구근', '허브'],
    '나무·관목': ['나무', '장미'],
    '채소·먹거리': ['채소'],
  }

  function isPotPlanting(type) {
    return /화분/.test(String(type ?? ''))
  }

  function normalizeCultivationType(value) {
    const text = String(value ?? '')
    if (/실내|베란다/.test(text)) return '실내 화분'
    if (/화분/.test(text)) return text.includes('실내') ? '실내 화분' : '실외 화분'
    if (/하우스|온실/.test(text)) return '온실/하우스'
    return text || '노지'
  }

  function plantingTypeOptionsForAnswers(answers = {}) {
    const type = normalizeCultivationType(answers.locationCultivationType)
    if (type === '노지') return ['노지에 추가 식재', '화분을 새로 놓기', '잘 모르겠어요']
    if (type === '실외 화분') return ['기존 화분에 더 심기', '새 화분을 놓기', '잘 모르겠어요']
    if (type === '실내 화분') return ['실내 화분으로 키우기', '새 화분을 놓기', '잘 모르겠어요']
    if (type === '온실/하우스') return ['하우스 안 노지', '하우스 안 화분', '잘 모르겠어요']
    return ['노지에 추가 식재', '화분을 새로 놓기', '잘 모르겠어요']
  }

  async function recommendationLocationOptions() {
    const { locations, instances } = await loadBaseData()
    const hasChildren = new Set(locations.map(loc => loc.parent_id).filter(Boolean))
    const rows = locations.filter(loc => loc.level === 2 || !hasChildren.has(loc.id))
    return Promise.all(rows.map(async loc => ({
      label: locLabel(loc, locations),
      value: loc.id,
      meta: await recommendationLocationMeta(loc, locations, instances),
    })))
  }

  async function recommendationLocationMeta(loc, locations, instances) {
    const sun = window.locationUtil?.getEffectiveSunlight
      ? window.locationUtil.getEffectiveSunlight(loc.id, locations)
      : { value: loc.sunlight_type }
    const soil = loc.soil_type || ''
    const locInstances = instances.filter(inst => inst.location_id === loc.id)
    const plantNames = locInstances.map(inst => inst.plants?.name).filter(Boolean)
    const categories = locInstances.map(inst => inst.plants?.category).filter(Boolean)
    const pressure = analyzeLocationPressure(loc, locInstances)
    const fallbackFeel = inferGardenFeel(locInstances)
    const ai = await analyzeGardenStyleWithAi(loc, locInstances, {
      sunText: sun.value ? window.locationUtil?.formatSunlightContext?.(sun) || sun.value : '',
      soilText: soil,
      fallbackFeel,
    })
    return {
      count: locInstances.length,
      plantNames,
      cultivationType: normalizeCultivationType(loc.cultivation_type),
      pressure,
      gardenFeel: ai.gardenType || fallbackFeel,
      gardenSummary: ai.summary || '',
      styleTags: ai.styleTags || [],
      sunText: sun.value ? window.locationUtil?.formatSunlightContext?.(sun) || sun.value : '',
      soilText: soil,
      categoryText: summarizeCategories(categories),
    }
  }

  function analyzeLocationPressure(loc, instances = []) {
    const totalQuantity = instances.reduce((sum, inst) => sum + (Number(inst.quantity) || 1), 0)
    const woody = instances.filter(inst => /장미|나무|관목|수국|블루베리|철쭉/.test(`${inst.plants?.category ?? ''} ${inst.plants?.name ?? ''}`))
    const tall = instances.filter(inst => {
      const height = parseCm(inst.plants?.height)
      return height != null && height >= 80
    })
    const roseLike = instances.filter(inst => /장미/.test(`${inst.plants?.category ?? ''} ${inst.plants?.name ?? ''}`))
    const highDensity = totalQuantity >= 12 || instances.length >= 7 || (woody.length >= 3 && totalQuantity >= 6)
    const rootCompetition = woody.length >= 2 || roseLike.length >= 2
    const airflowRisk = tall.length >= 3 || (highDensity && woody.length >= 2)
    const preferredTags = []
    const warnings = []
    if (highDensity) {
      preferredTags.push('앞쪽 낮게', '관리 쉬운 것')
      warnings.push('식물이 많아 큰 식물은 피하는 편이 좋아요.')
    }
    if (rootCompetition) {
      preferredTags.push('앞쪽 낮게')
      warnings.push('뿌리 경쟁이 생길 수 있어 낮은 초화류가 좋아요.')
    }
    if (airflowRisk) {
      preferredTags.push('관리 쉬운 것')
      warnings.push('통풍을 막지 않는 식물을 우선 추천해요.')
    }
    return {
      totalQuantity,
      plantKinds: instances.length,
      woodyCount: woody.length,
      tallCount: tall.length,
      roseCount: roseLike.length,
      highDensity,
      rootCompetition,
      airflowRisk,
      preferredTags: [...new Set(preferredTags)],
      warnings,
      summary: warnings[0] || (instances.length ? '기존 식물과 어울리는 보완 식재를 추천해요.' : '환경에 맞는 첫 식재 코스를 추천해요.'),
    }
  }

  function gardenAnalysisCacheKey(loc, instances = []) {
    const signature = instances
      .map(inst => `${inst.plants?.id || inst.plants?.name || ''}:${inst.quantity || 1}`)
      .sort()
      .join('|')
    return `plantGarden.butler.gardenStyle.v1.${loc?.id || 'none'}.${signature}`
  }

  function readGardenAnalysisCache(key) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (Date.now() - Number(parsed.updatedAt || 0) > 7 * 24 * 60 * 60 * 1000) return null
      return parsed.data || null
    } catch (_) {
      return null
    }
  }

  function writeGardenAnalysisCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ updatedAt: Date.now(), data }))
    } catch (_) {}
  }

  async function analyzeGardenStyleWithAi(loc, instances = [], context = {}) {
    if (!instances.length || !window._supabase?.functions?.invoke) return {}
    const key = gardenAnalysisCacheKey(loc, instances)
    const cached = readGardenAnalysisCache(key)
    if (cached) return cached
    const plants = instances.slice(0, 18).map(inst => ({
      name: inst.plants?.name,
      category: inst.plants?.category,
      quantity: inst.quantity || 1,
      sun: inst.plants?.sun,
      height: inst.plants?.height,
      bloom: inst.plants?.bloom,
      feature: inst.plants?.feature,
    }))
    const prompt = `아래 정원 구역에 이미 심어진 식물들을 보고 정원 형태를 분석하세요.
50대 이상 사용자가 이해하기 쉬운 짧은 한국어 JSON만 반환하세요.
JSON 형식: {"garden_type":"10자 내외","summary":"한 문장","style_tags":["태그1","태그2","태그3"]}
규칙:
- garden_type은 예: 장미 정원, 허브 정원, 야생화 정원, 화단형 꽃밭, 관목 정원, 텃밭, 혼합 정원
- 식물명과 수량을 근거로 판단하세요.
- 모르면 무리하게 단정하지 말고 "혼합 정원"이라고 하세요.
구역명: ${loc?.name ?? ''}
환경: ${context.sunText || ''} ${context.soilText || ''}
기존 규칙 추정: ${context.fallbackFeel || ''}
식물 목록: ${JSON.stringify(plants)}`
    try {
      const { data, error } = await window._supabase.functions.invoke('groq-chat', {
        body: { prompt, maxTokens: 420 },
      })
      if (error || !data?.ok) return {}
      const result = {
        gardenType: String(data.data?.garden_type || '').slice(0, 20),
        summary: String(data.data?.summary || '').slice(0, 90),
        styleTags: Array.isArray(data.data?.style_tags) ? data.data.style_tags.slice(0, 3).map(String) : [],
      }
      writeGardenAnalysisCache(key, result)
      return result
    } catch (_) {
      return {}
    }
  }

  function summarizeCategories(categories = []) {
    if (!categories.length) return ''
    const counts = categories.reduce((acc, category) => {
      acc[category] = (acc[category] ?? 0) + 1
      return acc
    }, {})
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([name, count]) => `${name} ${count}`)
      .join(' · ')
  }

  function inferGardenFeel(instances = []) {
    if (!instances.length) return '비어 있는 구역'
    const text = instances.map(inst => `${inst.plants?.name ?? ''} ${inst.plants?.category ?? ''}`).join(' ')
    if (/장미/.test(text)) return '장미 중심 정원'
    if (/허브|라벤더|로즈마리|민트|세이지/.test(text)) return '허브 향기 정원'
    if (/채소|상추|토마토|고추|오이|시금치/.test(text)) return '먹거리 텃밭'
    if (/나무|수국|블루베리|철쭉|관목/.test(text)) return '관목 중심 정원'
    return '꽃 중심 정원'
  }

  async function startRecommendationFlow(seed = {}) {
    const locationOptions = seed.locationOptions || await recommendationLocationOptions()
    const seedLocation = locationOptions.find(item => item.value === seed.locationId)
    const autoAnswers = buildAutoRecommendationAnswers(seedLocation, seed)
    state.recommendFlow = {
      step: seed.locationId ? (shouldAutoRecommendLocation(seedLocation) ? 0 : 1) : 0,
      answers: {
        locationId: seed.locationId || '',
        locationLabel: seed.locationLabel || '',
        locationCultivationType: seedLocation?.meta?.cultivationType || '',
        gardenStyle: seed.gardenStyle || autoAnswers.gardenStyle || '',
        plantingType: seed.plantingType || autoAnswers.plantingType || '',
        potCount: seed.potCount || autoAnswers.potCount || '',
        potSize: seed.potSize || autoAnswers.potSize || '',
        groundSize: seed.groundSize || autoAnswers.groundSize || '',
        tags: Array.isArray(seed.tags) ? seed.tags : autoAnswers.tags,
        autoRecommended: Boolean(autoAnswers.autoRecommended),
      },
      locationOptions,
    }
    if (seed.locationId && (seed.autoAnswer || shouldAutoRecommendLocation(seedLocation))) {
      const answer = await answerGardenRecommendation(state.recommendFlow.answers)
      state.recommendFlow = null
      return answer
    }
    normalizeRecommendationStep(state.recommendFlow)
    return renderRecommendationQuestion()
  }

  async function startRecommendationFromText(text = '') {
    const { locations, instances } = await loadBaseData()
    const scope = findScopeText(text, locations, instances)
    if (!scope.loc) return startRecommendationFlow()

    const locationOptions = await recommendationLocationOptions()
    const matched = locationOptions.find(item => item.value === scope.loc.id)
      || locationOptions.find(item => item.label.replace(/\s+/g, '').includes(scope.loc.name.replace(/\s+/g, '')))

    return startRecommendationFlow({
      locationId: matched?.value || scope.loc.id,
      locationLabel: matched?.label || locLabel(scope.loc, locations),
      locationOptions,
      autoAnswer: true,
    })
  }

  function shouldAutoRecommendLocation(option) {
    const meta = option?.meta
    if (!meta) return false
    return meta.count >= 5 || meta.pressure?.highDensity || meta.pressure?.rootCompetition
  }

  function gardenStyleFromMeta(meta = {}) {
    const feel = `${meta.gardenFeel ?? ''} ${meta.categoryText ?? ''}`
    if (/허브/.test(feel)) return '허브'
    if (/텃밭|채소|먹거리/.test(feel)) return '채소·먹거리'
    if (/관목|나무/.test(feel)) return '나무·관목'
    if (/장미|꽃|화단/.test(feel)) return '꽃 위주'
    return '알아서'
  }

  function defaultPlantingTypeForMeta(meta = {}) {
    const type = normalizeCultivationType(meta.cultivationType)
    if (type === '노지') return '노지에 추가 식재'
    if (type === '온실/하우스') return '하우스 안 노지'
    if (type === '실내 화분') return '실내 화분으로 키우기'
    return '기존 화분에 더 심기'
  }

  function buildAutoRecommendationAnswers(option, seed = {}) {
    const meta = option?.meta
    const pressure = meta?.pressure
    if (!meta) return { tags: Array.isArray(seed.tags) ? seed.tags : [] }
    const tags = [
      ...(pressure?.preferredTags ?? []),
      ...(meta.styleTags ?? []),
      pressure?.highDensity ? '앞쪽 낮게' : '',
      pressure?.airflowRisk ? '관리 쉬운 것' : '',
      '꽃 오래 피는 것',
    ].filter(Boolean)
    return {
      autoRecommended: shouldAutoRecommendLocation(option),
      gardenStyle: gardenStyleFromMeta(meta),
      plantingType: defaultPlantingTypeForMeta(meta),
      potCount: '2~3개',
      potSize: /실내|화분/.test(meta.cultivationType || '') ? '보통 화분' : '',
      groundSize: pressure?.highDensity ? '한 뼘 자리' : '두 손 너비',
      tags: [...new Set(tags)].slice(0, 3),
    }
  }

  function selectedRecommendationContextHtml(flow) {
    const selected = flow?.locationOptions?.find(item => item.value === flow.answers.locationId)
    if (!selected) return ''
    const meta = selected.meta ?? {}
    const plants = (meta.plantNames ?? []).slice(0, 4).join(', ')
    const more = (meta.plantNames?.length ?? 0) > 4 ? ` 외 ${meta.plantNames.length - 4}종` : ''
    const env = [meta.sunText, meta.cultivationType, meta.soilText ? `흙 ${meta.soilText}` : ''].filter(Boolean).join(' · ')
    return `<div class="butler-selected-location">
      <strong>${escapeHtml(selected.label)}</strong>
      <span>${escapeHtml(meta.gardenFeel || '정원 구역')}</span>
      ${env ? `<p>${escapeHtml(env)}</p>` : ''}
      ${meta.gardenSummary ? `<p>${escapeHtml(meta.gardenSummary)}</p>` : ''}
      ${meta.pressure?.warnings?.length ? `<p>${escapeHtml(meta.pressure.warnings[0])}</p>` : ''}
      <p>${escapeHtml(plants ? `심어진 식물: ${plants}${more}` : '아직 심어진 식물이 적어 새 조합을 만들기 좋아요.')}</p>
    </div>`
  }

  function activeRecommendationSteps(answers = {}) {
    return RECOMMEND_STEPS.filter(step => !step.when || step.when(answers))
  }

  function normalizeRecommendationStep(flow) {
    const steps = activeRecommendationSteps(flow.answers)
    if (flow.step >= steps.length) flow.step = steps.length - 1
    if (flow.step < 0) flow.step = 0
  }

  function renderRecommendationQuestion() {
    const flow = state.recommendFlow
    const steps = activeRecommendationSteps(flow?.answers ?? {})
    const step = steps[flow?.step ?? 0]
    if (!flow || !step) return null
    const stepOptions = typeof step.options === 'function' ? step.options(flow.answers) : step.options
    const options = step.dynamic === 'locations'
      ? flow.locationOptions.map(item => ({ label: item.label, value: item.value }))
      : stepOptions.map(option => ({ label: option, value: option }))
    if (!options.length) {
      state.recommendFlow = null
      return { html: '추천할 정원이 아직 없어요. 먼저 정원을 만들어 주세요.', actions: [{ label: '정원으로 이동', href: 'garden.html' }] }
    }
    const selectedTags = Array.isArray(flow.answers.tags) ? flow.answers.tags : []
    const choices = options.map(option => ({
      label: option.label,
      question: option.label,
      mode: 'recommend-choice',
      value: option.value,
      selected: step.multi && selectedTags.includes(option.value),
    }))
    if (step.multi) {
      choices.push({
        label: selectedTags.length ? '이 느낌으로 추천' : '느낌 없이 추천',
        question: '추천해줘',
        mode: 'recommend-choice',
        value: '__done__',
      })
    }
    const selectedHtml = step.multi && selectedTags.length
      ? `<p class="butler-note">선택한 느낌: ${selectedTags.map(tag => `<b>${escapeHtml(tag)}</b>`).join(' · ')}</p>`
      : ''
    const locationInfoHtml = step.dynamic === 'locations'
      ? `<div class="butler-location-options">${flow.locationOptions.map(item => `
          <button class="butler-location-option ${flow.answers.locationId === item.value ? 'selected' : ''}" type="button"
            data-butler-question="${escapeHtml(item.label)}"
            data-butler-mode="recommend-choice"
            data-butler-value="${escapeHtml(item.value)}">
            <strong>${escapeHtml(item.label)}${flow.answers.locationId === item.value ? '<em>현재 구역</em>' : ''}</strong>
            <span>${escapeHtml([
              item.meta?.sunText,
              item.meta?.cultivationType,
              item.meta?.soilText ? `흙 ${item.meta.soilText}` : '',
              `${item.meta?.count ?? 0}종 심어짐`,
            ].filter(Boolean).join(' · '))}</span>
          </button>`).join('')}</div>`
      : ''
    const contextHtml = step.dynamic === 'locations' ? '' : selectedRecommendationContextHtml(flow)
    return {
      html: `${contextHtml}<p><b>${escapeHtml(step.title)}</b></p><p class="butler-note">${escapeHtml(step.note || '제가 정원 조건을 보고 제안할게요.')}</p>${selectedHtml}${locationInfoHtml}`,
      actions: step.dynamic === 'locations' ? [] : choices,
    }
  }

  function selectedRecommendationLocation(flow, locations) {
    const id = flow?.answers?.locationId
    if (!id) return null
    return locations.find(loc => loc.id === id) ?? null
  }

  function recommendationScaleKey(answers = {}) {
    if (answers.plantingType === '화분 몇 개') return `화분 ${answers.potCount || '2~3개'}`
    return answers.groundSize || '잘 모르겠어요'
  }

  function recommendationScale(answers = {}) {
    return SCALE_META[recommendationScaleKey(answers)] ?? SCALE_META['잘 모르겠어요']
  }

  function scoreByNeed(plant, need) {
    if (!need) return 0
    const roles = plant.design_roles ?? []
    const style = String(plant.grouping_style ?? '')
    const height = parseCm(plant.height)
    if (need.includes('앞쪽')) return roles.includes('앞쪽') || (height != null && height <= 45) ? 2.5 : -0.5
    if (need.includes('중간')) return roles.includes('중간') || (height != null && height > 45 && height < 120) ? 2.2 : 0
    if (need.includes('뒤쪽') || need.includes('키 큰')) return roles.includes('뒤쪽') || roles.includes('배경') || (height != null && height >= 100) ? 2.8 : -1
    if (need.includes('포인트')) return roles.includes('포인트') || /포인트|단독/.test(style) ? 2.5 : 0
    if (need.includes('비어')) return /군락|라인/.test(style) || Number(plant.plants_per_sqm) >= 4 ? 2 : 0.5
    return 0
  }

  function scoreByColor(plant, color) {
    if (!color) return 0
    const colors = plant.flower_colors ?? []
    const text = `${plant.name ?? ''} ${plant.feature ?? ''} ${plant.recommendation_note ?? ''}`
    return colors.includes(color) || text.includes(color) ? 2 : 0
  }

  function isFruitOrCropPlant(plant) {
    const text = `${plant.name ?? ''} ${plant.category ?? ''} ${(plant.plant_types ?? []).join(' ')} ${plant.feature ?? ''} ${plant.recommendation_note ?? ''}`
    return /블루베리|딸기|라즈베리|포도|사과|배|복숭아|자두|감귤|무화과|과수|베리|열매|수확|식용|채소/.test(text)
  }

  function recommendationAnswerLabel(flow, key, value) {
    if (key === 'locationId') {
      const found = flow.locationOptions?.find(item => item.value === value)
      return found?.label || value
    }
    return value
  }

  function parseNumber(value) {
    const num = Number(String(value ?? '').match(/\d+(?:\.\d+)?/)?.[0])
    return Number.isFinite(num) ? num : null
  }

  function plantText(plant) {
    return `${plant.name ?? ''} ${plant.category ?? ''} ${(plant.plant_types ?? []).join(' ')} ${(plant.flower_colors ?? []).join(' ')} ${(plant.bloom_seasons ?? []).join(' ')} ${(plant.start_methods ?? []).join(' ')} ${(plant.design_roles ?? []).join(' ')} ${(plant.companion_tags ?? []).join(' ')} ${(plant.avoid_tags ?? []).join(' ')} ${plant.grouping_style ?? ''} ${plant.feature ?? ''} ${plant.design_note ?? ''} ${plant.recommendation_note ?? ''}`
  }

  function matchesGardenStyle(plant, style) {
    if (!style || style === '알아서') return true
    const category = String(plant.category ?? '').trim()
    const tags = plant.plant_types ?? []
    if (style === '채소·먹거리') return category === '채소' || isFruitOrCropPlant(plant)
    const categories = STYLE_CATEGORY_MAP[style] ?? []
    const matched = categories.includes(category) || categories.some(item => tags.includes(item))
    if (['꽃 위주', '꽃+허브'].includes(style) && isFruitOrCropPlant(plant)) return false
    return matched
  }

  function scoreByStyle(plant, style) {
    if (!style || style === '알아서') return 1
    return matchesGardenStyle(plant, style) ? 3 : -6
  }

  function colorTags(tags = []) {
    return tags.map(tag => String(tag).match(/^(흰색|노랑|분홍|보라)/)?.[1]).filter(Boolean)
  }

  function scoreByTags(plant, tags = []) {
    if (!tags.length) return 0
    const text = plantText(plant)
    const seasons = plant.bloom_seasons ?? []
    let score = 0
    tags.forEach(tag => {
      if (tag === '꽃 오래 피는 것') score += /오래|장기|계속|여름.*가을|봄.*가을/.test(text) ? 1.8 : 0
      else if (tag === '월동 잘되는 것') score += /월동|내한|추위|다년|숙근/.test(text) ? 1.8 : 0
      else if (tag === '관리 쉬운 것') score += plant.care_difficulty === '쉬움' || /관리\s*쉬|강건|튼튼|초보/.test(text) ? 1.8 : 0
      else if (tag === '향기 좋은 것') score += /향기|향이|향긋|허브/.test(text) ? 1.6 : 0
      else if (tag === '벌·나비 오는 것') score += /벌|나비|밀원|수분/.test(text) ? 1.6 : 0
      else if (tag === '봄에 화사하게') score += seasons.includes('봄') || /봄|4월|5월/.test(text) ? 1.5 : 0
      else if (tag === '여름까지 오래') score += seasons.includes('여름') || /여름|6월|7월|8월/.test(text) ? 1.5 : 0
      else if (tag === '앞쪽 낮게') score += scoreByNeed(plant, '앞쪽 낮은 식물')
      else if (tag === '포인트 식물') score += scoreByNeed(plant, '포인트 식물')
      else score += scoreByColor(plant, tag.replace(' 중심', ''))
    })
    return score
  }

  function passesRecommendationFilters(plant, answers, relaxed = false) {
    if (!relaxed && !matchesGardenStyle(plant, answers.gardenStyle)) return false
    if (relaxed && ['꽃 위주', '꽃+허브'].includes(answers.gardenStyle) && isFruitOrCropPlant(plant)) return false
    const colors = colorTags(answers.tags)
    if (!relaxed && colors.length && !colors.some(color => scoreByColor(plant, color) > 0)) return false
    if (!relaxed && (answers.tags ?? []).includes('앞쪽 낮게') && scoreByNeed(plant, '앞쪽 낮은 식물') < 0) return false
    if (isPotPlanting(answers.plantingType)) {
      const height = parseCm(plant.height)
      const style = String(plant.grouping_style ?? '')
      if (answers.potSize === '작은 화분' && height != null && height > 55) return false
      if (answers.potSize === '긴 화분·플랜터' && /단독|대형/.test(style)) return false
    }
    return true
  }

  function pressureScore(plant, pressure = {}) {
    if (!pressure) return { score: 0, note: '' }
    const height = parseCm(plant.height)
    const text = plantText(plant)
    const category = String(plant.category ?? '')
    let score = 0
    const notes = []
    const isWoody = /장미|나무|관목|수국|블루베리/.test(`${category} ${plant.name ?? ''} ${text}`)
    if (pressure.highDensity) {
      if (height != null && height <= 45) {
        score += 2.2
        notes.push('낮게 보완')
      }
      if (height != null && height >= 90) score -= 2.5
      if (isWoody) score -= 2
    }
    if (pressure.rootCompetition) {
      if (isWoody) score -= 2.2
      if (/초화|낮|앞쪽|가장자리|포복|지피/.test(text)) score += 1.4
    }
    if (pressure.airflowRisk) {
      if (/통풍|성긴|가벼운|직립|초화/.test(text)) score += 1
      if (/빽빽|조밀|대형|관목/.test(text) || isWoody) score -= 1.2
    }
    return { score, note: notes[0] || '' }
  }

  function neighborText(neighbors = []) {
    return neighbors.map(inst => {
      const p = inst.plants ?? {}
      return `${p.name ?? ''} ${p.category ?? ''} ${p.sun ?? ''} ${p.soil ?? ''} ${p.height ?? ''} ${p.feature ?? ''}`
    }).join(' ')
  }

  function companionScore(plant, neighbors = []) {
    if (!neighbors.length) {
      return { score: 0.4, text: '비어 있는 구역이라 새 조합을 만들기 좋아요.', level: 'empty' }
    }
    const text = neighborText(neighbors)
    const companionTags = plant.companion_tags ?? []
    const avoidTags = plant.avoid_tags ?? []
    const companionMatches = companionTags.filter(tag => tag && text.includes(tag))
    const avoidMatches = avoidTags.filter(tag => tag && text.includes(tag))
    if (avoidMatches.length) {
      return {
        score: -4,
        text: `${avoidMatches[0]} 계열과는 간격을 넉넉히 확인해 주세요.`,
        level: 'warn',
      }
    }
    if (companionMatches.length) {
      return {
        score: 2.2,
        text: `${companionMatches[0]} 근처와 잘 어울릴 가능성이 있어요.`,
        level: 'good',
      }
    }
    const sameCategory = neighbors.find(inst => inst.plants?.category && inst.plants.category === plant.category)
    if (sameCategory) {
      return {
        score: 0.9,
        text: `${sameCategory.plants.name}와 관리 조건이 비슷할 수 있어요.`,
        level: 'similar',
      }
    }
    return {
      score: -0.1,
      text: '기존 식물과 간격, 통풍을 확인해 주세요.',
      level: 'check',
    }
  }

  function countForPlant(plant, answers) {
    const meta = recommendationScale(answers)
    const category = String(plant.category ?? '')
    const height = parseCm(plant.height)
    const style = String(plant.grouping_style ?? '')
    const isWoodyOrSpecimen = ['장미', '나무'].includes(category) || /관목|묘목|단독|포인트/.test(style) || (height != null && height >= 90)
    if (isWoodyOrSpecimen) {
      if (answers.plantingType === '화분 몇 개') return Math.min(Number(plant.recommended_count_max) || 1, answers.potCount === '1개' ? 1 : 2)
      if (['한 뼘 자리', '두 손 너비', '잘 모르겠어요'].includes(recommendationScaleKey(answers))) return 1
      if (recommendationScaleKey(answers) === '한두 걸음 자리') return Math.min(Number(plant.recommended_count_max) || 2, 2)
      return Math.min(Number(plant.recommended_count_max) || 3, 3)
    }
    const perSqm = parseNumber(plant.plants_per_sqm)
    if (perSqm) {
      const count = Math.max(1, Math.round(perSqm * meta.sqm))
      return Math.min(count, meta.maxTotal, Number(plant.recommended_count_max) || count)
    }
    const spacing = parseNumber(plant.spacing_cm_max) || parseNumber(plant.spacing_cm_min)
    if (spacing && meta.sqm) {
      const perPlantSqm = Math.max(0.04, (spacing / 100) * (spacing / 100))
      const count = Math.max(1, Math.floor(meta.sqm / perPlantSqm))
      return Math.min(count, meta.maxTotal, Number(plant.recommended_count_max) || count)
    }
    const min = Number(plant.recommended_count_min) || (meta.sqm <= 1 ? 3 : 5)
    const max = Number(plant.recommended_count_max) || (meta.sqm <= 1 ? 5 : 9)
    return Math.max(1, Math.min(max, meta.maxTotal, min))
  }

  function formatRecommendationReason(plant, loc, locations, answers) {
    const sun = window.locationUtil?.getEffectiveSunlight ? window.locationUtil.getEffectiveSunlight(loc.id, locations).value : loc.sunlight_type
    const sunText = sunlightScore(plant.sun, sun).score > 0 ? '햇빛이 잘 맞아요' : '햇빛은 한번 확인해 주세요'
    const soilText = soilScore(plant.soil, loc).score > 0 ? '흙 조건도 괜찮아요' : '흙 상태는 보완이 필요할 수 있어요'
    const style = plant.grouping_style || (countForPlant(plant, answers) >= 5 ? '군락형' : '포인트형')
    return { sunText, soilText, style }
  }

  async function loadRecommendationPlants() {
    if (!window._supabase) return []
    const { data, error } = await window._supabase
      .from('plants_with_recommendation')
      .select('id, name, category, sun, soil, height, width, bloom, sowing, cutting_note, feature, plant_types, flower_colors, bloom_seasons, start_methods, design_roles, grouping_style, spacing_cm_min, spacing_cm_max, plants_per_sqm, recommended_count_min, recommended_count_max, spread_type, care_difficulty, companion_tags, avoid_tags, design_note, recommendation_note, confidence')
      .limit(300)
    if (error) throw error
    return data ?? []
  }

  async function loadPlantImageMap(ids = []) {
    const cleanIds = [...new Set(ids.filter(Boolean))]
    if (!window._supabase || !cleanIds.length) return {}
    const { data, error } = await window._supabase
      .from('plant_images')
      .select('plant_id, image_url, sort_order, is_main')
      .in('plant_id', cleanIds)
      .order('is_main', { ascending: false })
      .order('sort_order', { ascending: true })
    if (error) return {}
    const map = {}
    ;(data ?? []).forEach(row => {
      if (!map[row.plant_id] && row.image_url) map[row.plant_id] = row.image_url
    })
    return map
  }

  function startMethodsForPlant(plant) {
    const methods = new Set(Array.isArray(plant.start_methods) ? plant.start_methods : [])
    const category = String(plant.category ?? '')
    const text = plantText(plant)
    if (/파종|씨앗|발아/.test(text)) methods.add('파종')
    if (/삽목|삽수|발근/.test(text)) methods.add('삽목')
    if (category === '나무') methods.add('묘목 구매')
    else if (category === '구근') methods.add('구근 구매')
    else methods.add('모종 구매')
    return [...methods].filter(Boolean).slice(0, 3)
  }

  function methodSearchKeyword(plant, method) {
    const name = plant.name ?? '식물'
    if (/묘목/.test(method)) return `${name} 묘목`
    if (/구근/.test(method)) return `${name} 구근`
    if (/파종|씨앗/.test(method)) return `${name} 씨앗`
    if (/삽목|삽수/.test(method)) return `${name} 삽수`
    return `${name} 모종`
  }

  function naverShoppingUrl(keyword) {
    return `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`
  }

  function roleForPlant(plant) {
    return plant.design_roles?.[0] || heightPosition(parseCm(plant.height))
  }

  function comboTitle(tag, index) {
    if (!tag) return index === 0 ? '기본 추천' : '다른 느낌'
    return tag.replace(' 것', '').replace(' 중심', '') + ' 조합'
  }

  function recommendationComboThemes(answers = {}) {
    const picked = Array.isArray(answers.tags) ? answers.tags.slice(0, 3) : []
    const defaults = ['관리 쉬운 것', '꽃 오래 피는 것', '월동 잘되는 것', '포인트 식물']
      .filter(tag => !picked.includes(tag))
    return [...picked, ...defaults].slice(0, 3).map((tag, index) => ({
      tag,
      title: comboTitle(tag, index),
    }))
  }

  function pickComboItems(scored, answers, theme) {
    const limit = recommendationScale(answers).kinds
    const seen = new Set()
    return [...scored]
      .map(item => ({
        ...item,
        comboScore: item.score + scoreByTags(item.plant, theme?.tag ? [theme.tag] : []) + (item.plant.design_roles?.length ? 0.25 : 0),
      }))
      .sort((a, b) => b.comboScore - a.comboScore)
      .filter(item => {
        if (seen.has(item.plant.id)) return false
        seen.add(item.plant.id)
        return true
      })
      .slice(0, limit)
  }

  async function aiRecommendationSummary({ answers, scale, items }) {
    if (!window._supabase?.functions?.invoke || !items.length) return ''
    const prompt = `정원 식물 추천 결과를 50대 이상 사용자가 이해하기 쉽게 JSON으로 요약하세요.
JSON만 반환하세요: {"summary":"두 문장 이내","layout_tip":"한 문장"}
입력 조건: ${JSON.stringify(answers)}
면적 기준: ${scale.label}
추천 식물: ${JSON.stringify(items.map(item => ({
  name: item.plant.name,
  location: item.location,
  count: item.count,
  style: item.style,
  role: item.role,
})))}`
    try {
      const { data, error } = await window._supabase.functions.invoke('groq-chat', {
        body: { prompt, maxTokens: 500 },
      })
      if (!error && data?.ok) {
        const summary = data.data?.summary || ''
        const layoutTip = data.data?.layout_tip || ''
        return [summary, layoutTip].filter(Boolean).join(' ')
      }
    } catch (_) {}
    return ''
  }

  async function answerGardenRecommendationChoice(value) {
    const flow = state.recommendFlow
    if (!flow) return startRecommendationFlow()
    const steps = activeRecommendationSteps(flow.answers)
    const step = steps[flow.step]
    if (step.key === 'locationId') {
      const matched = flow.locationOptions?.find(item => item.value === value || item.label === value)
      if (matched) value = matched.value
    }
    if (step.multi) {
      flow.answers[step.key] = Array.isArray(flow.answers[step.key]) ? flow.answers[step.key] : []
      if (value !== '__done__') {
        const picked = flow.answers[step.key]
        const next = picked.includes(value)
          ? picked.filter(item => item !== value)
          : picked.length >= 3
            ? picked
            : [...picked, value]
        flow.answers[step.key] = next
        return renderRecommendationQuestion()
      }
    } else {
      flow.answers[step.key] = value
    }
    if (step.key === 'locationId') {
      flow.answers.locationLabel = recommendationAnswerLabel(flow, step.key, value)
      const selected = flow.locationOptions?.find(item => item.value === value)
      flow.answers.locationCultivationType = selected?.meta?.cultivationType || ''
      if (shouldAutoRecommendLocation(selected)) {
        flow.answers = { ...flow.answers, ...buildAutoRecommendationAnswers(selected, flow.answers), locationId: value, locationLabel: flow.answers.locationLabel, locationCultivationType: flow.answers.locationCultivationType }
        const answer = await answerGardenRecommendation(flow.answers)
        state.recommendFlow = null
        return answer
      }
    }
    flow.step += 1
    if (flow.step < activeRecommendationSteps(flow.answers).length) return renderRecommendationQuestion()
    const answer = await answerGardenRecommendation(flow.answers)
    state.recommendFlow = null
    return answer
  }

  async function answerGardenRecommendation(answers = {}) {
    const { locations, instances } = await loadBaseData()
    const selectedLoc = locations.find(loc => loc.id === answers.locationId)
    if (!selectedLoc) {
      return { html: '추천할 정원 구역이 아직 없어요. 정원에서 구역을 먼저 만들어 주세요.', actions: [{ label: '정원으로 이동', href: 'garden.html' }] }
    }

    const plants = await loadRecommendationPlants()
    const existingByLoc = new Map()
    instances.forEach(inst => {
      const arr = existingByLoc.get(inst.location_id) ?? []
      arr.push(inst)
      existingByLoc.set(inst.location_id, arr)
    })
    const selectedOption = state.recommendFlow?.locationOptions?.find(item => item.value === answers.locationId)
    const locationPressure = selectedOption?.meta?.pressure || analyzeLocationPressure(selectedLoc, existingByLoc.get(selectedLoc.id) ?? [])

    function buildScoredCandidates(relaxed = false) {
      const rows = []
      plants.forEach(plant => {
        if (!passesRecommendationFilters(plant, answers, relaxed)) return
        ;[selectedLoc].forEach(loc => {
          const sun = window.locationUtil?.getEffectiveSunlight ? window.locationUtil.getEffectiveSunlight(loc.id, locations).value : loc.sunlight_type
          const sunEval = sunlightScore(plant.sun, sun)
          const soilEval = soilScore(plant.soil, loc)
          const neighbors = existingByLoc.get(loc.id) ?? []
          const companionEval = companionScore(plant, neighbors)
          const pressureEval = pressureScore(plant, locationPressure)
          const rawStyleScore = scoreByStyle(plant, answers.gardenStyle)
          const rawTagScore = scoreByTags(plant, answers.tags)
          const styleScore = relaxed ? Math.max(0, rawStyleScore) : rawStyleScore
          const tagScore = relaxed ? Math.max(0, rawTagScore) : rawTagScore
          const needScore = (answers.tags ?? []).includes('앞쪽 낮게') ? scoreByNeed(plant, '앞쪽 낮은 식물') : 0
          const reviewedBoost = plant.confidence === 'reviewed' ? 0.8 : plant.confidence === 'ai' ? 0.3 : 0
          const relaxedBoost = relaxed ? 1.2 : 0
          const score = styleScore + tagScore + needScore + sunEval.score + soilEval.score + companionEval.score + pressureEval.score + reviewedBoost + relaxedBoost - Math.min(neighbors.length, 6) * 0.08
          if (score > (relaxed ? -2 : 1)) rows.push({ plant, loc, neighbors, companionEval, pressureEval, score, relaxed })
        })
      })
      return rows
    }

    let scored = buildScoredCandidates(false)
    if (!scored.length) scored = buildScoredCandidates(true)
    if (!scored.length && plants.length) {
      scored = plants
        .filter(plant => !(['꽃 위주', '꽃+허브'].includes(answers.gardenStyle) && isFruitOrCropPlant(plant)))
        .map(plant => {
          const loc = selectedLoc
          const sun = window.locationUtil?.getEffectiveSunlight ? window.locationUtil.getEffectiveSunlight(loc.id, locations).value : loc.sunlight_type
          const neighbors = existingByLoc.get(loc.id) ?? []
          const companionEval = companionScore(plant, neighbors)
          const pressureEval = pressureScore(plant, locationPressure)
          const reviewedBoost = plant.confidence === 'reviewed' ? 0.8 : plant.confidence === 'ai' ? 0.3 : 0
          const score = Math.max(0, scoreByStyle(plant, answers.gardenStyle))
            + Math.max(0, scoreByTags(plant, answers.tags))
            + Math.max(0, sunlightScore(plant.sun, sun).score)
            + Math.max(0, soilScore(plant.soil, loc).score)
            + Math.max(0, companionEval.score)
            + Math.max(0, pressureEval.score)
            + reviewedBoost
          return { plant, loc, neighbors, companionEval, pressureEval, score, relaxed: true }
        })
        .filter(item => item.score > 0)
    }
    scored.sort((a, b) => b.score - a.score)
    const themes = recommendationComboThemes(answers)
    const combos = themes
      .map(theme => ({ ...theme, items: pickComboItems(scored, answers, theme) }))
      .filter(combo => combo.items.length)

    if (!combos.length) {
      return {
        html: '조건에 딱 맞는 추천을 찾지 못했어요. 조건을 조금 넓혀서 다시 추천받아 보세요.',
        actions: [{ label: '다시 추천받기', question: '정원에 무얼 심을까?' }],
      }
    }

    const scale = recommendationScale(answers)
    const allItems = combos.flatMap(combo => combo.items)
    const imageMap = await loadPlantImageMap(allItems.map(item => item.plant.id))
    const renderPlantCard = item => {
      const { plant, loc, neighbors } = item
      const count = countForPlant(plant, answers)
      const reason = formatRecommendationReason(plant, loc, locations, answers)
      const role = roleForPlant(plant)
      const image = imageMap[plant.id]
      const methods = startMethodsForPlant(plant)
      const companion = item.companionEval || companionScore(plant, neighbors)
      const pressure = item.pressureEval || pressureScore(plant, locationPressure)
      return `<section class="butler-reco-card">
        ${image ? `<img class="butler-reco-image" src="${escapeHtml(image)}" alt="${escapeHtml(plant.name)}">` : `<div class="butler-reco-image butler-reco-image-empty">이미지 준비중</div>`}
        <div class="butler-reco-main">
          <div class="butler-reco-head">
            <strong>${escapeHtml(plant.name)}</strong>
            <span>${escapeHtml(count)}개</span>
          </div>
          <p class="butler-reco-meta">${escapeHtml(locLabel(loc, locations))} · ${escapeHtml(role)} · ${escapeHtml(reason.style)}</p>
          <div class="butler-reco-tags">
            <span>${escapeHtml(reason.sunText)}</span>
            <span>${escapeHtml(reason.soilText)}</span>
            <span>${escapeHtml(companion.text)}</span>
            ${pressure.note ? `<span>${escapeHtml(pressure.note)}</span>` : ''}
            ${plant.bloom ? `<span>${escapeHtml(plant.bloom)}</span>` : ''}
          </div>
          <p class="butler-reco-note">${escapeHtml(plant.design_note || plant.recommendation_note || neighborAdvice(plant, neighbors))}</p>
          <details class="butler-start-methods">
            <summary>시작 방법 보기</summary>
            <div class="butler-method-list">
              ${methods.map(method => {
                const keyword = methodSearchKeyword(plant, method)
                return `<a href="${naverShoppingUrl(keyword)}" target="_blank" rel="noopener">${escapeHtml(method)}<small>${escapeHtml(keyword)} 검색</small></a>`
              }).join('')}
            </div>
          </details>
          <a class="butler-place-plant-btn" href="flowerbed.html?add=1&plant=${encodeURIComponent(plant.id)}&loc=${encodeURIComponent(loc.id)}">이 식물 추가</a>
        </div>
      </section>`
    }
    const comboData = combos.map(combo => {
      const summaryItems = combo.items.map(item => {
        const count = countForPlant(item.plant, answers)
        return {
          plant: item.plant,
          location: locLabel(item.loc, locations),
          count,
          style: formatRecommendationReason(item.plant, item.loc, locations, answers).style,
          role: roleForPlant(item.plant),
          companion: item.companionEval || companionScore(item.plant, item.neighbors),
          pressure: item.pressureEval || pressureScore(item.plant, locationPressure),
        }
      })
      return {
        ...combo,
        summaryItems,
        totalCount: summaryItems.reduce((sum, item) => sum + item.count, 0),
      }
    })
    const aiSummary = await aiRecommendationSummary({ answers, scale, items: comboData[0].summaryItems })
    const tagText = (answers.tags ?? []).length ? ` · ${answers.tags.join(' · ')}` : ''
    const selectedNeighbors = existingByLoc.get(selectedLoc.id) ?? []
    const existingCount = selectedNeighbors.length
    const existingSummary = existingPlantSummary(selectedNeighbors)
    const compatibilityText = compatibilityContextText(selectedNeighbors, locationPressure)
    const tabId = `butler-combo-${Date.now()}-${Math.round(Math.random() * 1000)}`
    const tabs = comboData.map((combo, index) => `
      <input class="butler-combo-radio" type="radio" name="${tabId}" id="${tabId}-${index}" ${index === 0 ? 'checked' : ''}>
      <label class="butler-combo-tab" for="${tabId}-${index}">${escapeHtml(combo.title)}</label>
    `).join('')
    const panels = comboData.map((combo, index) => `
      <section class="butler-combo-panel butler-combo-panel-${index}">
        <section class="butler-combo-card">
          <div class="butler-combo-head">
            <div>
              <p>${escapeHtml(combo.title)}</p>
              <strong>${escapeHtml(locLabel(selectedLoc, locations))} · ${escapeHtml(scale.label)}</strong>
            </div>
            <span>총 ${escapeHtml(combo.totalCount)}개</span>
          </div>
          <p class="butler-combo-summary">${escapeHtml(((index === 0 && aiSummary) ? aiSummary : `${combo.title} 기준으로 ${combo.items.length}종을 골랐어요.`) + (index === 0 ? tagText : ''))}</p>
          ${existingCount ? `<div class="butler-existing-context">
            <b>현재 심어진 식물</b>
            <span>${escapeHtml(existingSummary)}</span>
          </div>` : ''}
          <p class="butler-combo-context">${escapeHtml(compatibilityText)}</p>
          <div class="butler-layout-lines">
            ${combo.summaryItems.map(item => `<p><b>${escapeHtml(item.role)}</b><span>${escapeHtml(item.plant.name)} ${escapeHtml(item.count)}개</span></p>`).join('')}
          </div>
        </section>
        <div class="butler-reco-cards">${combo.items.map(renderPlantCard).join('')}</div>
      </section>
    `).join('')

    return {
      html: `<div class="butler-combo-tabs">${tabs}${panels}</div>
      <p class="butler-note">사진을 보고 마음에 드는 식물을 고른 뒤, 시작 방법에서 모종·묘목·씨앗 검색을 바로 열 수 있어요.</p>`,
      actions: [
        { label: '다시 추천받기', question: '정원에 무얼 심을까?' },
        { label: '정원식물 보기', href: 'flowerbed.html' },
      ],
    }
  }

  async function answerWatering(text) {
    if (!window.wateringUtil) return simpleAnswer('물주기 기준을 불러오지 못했어요.')
    const { locations, instances } = await loadBaseData()
    const scope = findScopeText(text, locations, instances)
    const rows = filterInstancesByScope(instances, locations, scope)
    if (!rows.length) {
      return {
        html: '확인할 정원식물이 없어요. 먼저 정원식물을 등록해 주세요.',
        actions: [{ label: '정원식물로 이동', href: 'flowerbed.html' }],
      }
    }

    const rainByLocation = await loadRainByLocation(rows, locations)
    const grouped = groupWaterStatuses(rows, locations, rainByLocation)
    const rain = rainDecision(rainByLocation)
    const title = scope.plantName
      ? `${scope.plantName} 기준으로 확인했어요.`
      : scope.loc
        ? `${scope.loc.name} 기준으로 확인했어요.`
        : '전체 정원 기준으로 확인했어요.'
    const parts = [
      `<p>${escapeHtml(title)}</p>`,
      rain
        ? `<p><b>${escapeHtml(rain.title)}</b><br>${escapeHtml(rain.text)}</p>`
        : `<p>오늘 물주기 필요한 식물은 <b>${grouped.due.length}개</b>, 흙마름 확인은 <b>${grouped.check.length}개</b>예요.</p>`,
    ]
    if (grouped.due.length) {
      parts.push(`<p class="butler-subtitle">${rain ? '비 후 흙마름 확인' : '물 줘도 좋아요'}</p>${itemList(grouped.due)}`)
    }
    if (grouped.check.length) parts.push(`<p class="butler-subtitle">흙을 만져보고 주세요</p>${itemList(grouped.check)}`)
    if (!grouped.due.length && !grouped.check.length && !rain) parts.push('<p>오늘은 대부분 쉬어도 괜찮아 보여요.</p>')
    if (grouped.none.length) parts.push(`<p class="text-gray-400">물주기 기록이 없는 식물 ${grouped.none.length}개는 첫 기록이 필요해요.</p>`)
    return {
      html: parts.join(''),
      actions: [
        { label: '정원식물 보기', href: 'flowerbed.html' },
        { label: '달력 보기', href: 'calendar.html' },
      ],
    }
  }

  async function answerTodayTasks() {
    const { locations, instances } = await loadBaseData()
    const rainByLocation = await loadRainByLocation(instances, locations)
    const grouped = window.wateringUtil ? groupWaterStatuses(instances, locations, rainByLocation) : { due: [], check: [] }
    let tasks = []
    try {
      tasks = window.tasksApi?.listAll ? await window.tasksApi.listAll() : []
    } catch (_) {
      tasks = []
    }
    const today = todayStr()
    const openTasks = tasks.filter(task => !task.completed_at && (!task.due_date || task.due_date <= today))
    const sowing = instances.filter(inst => inst.status === '파종')
    const cutting = instances.filter(inst => inst.status === '삽목')
    const byInstanceId = new Map(instances.map(inst => [inst.id, inst]))
    let activeHealth = []
    try {
      activeHealth = window.healthApi?.listActiveForInstances
        ? await window.healthApi.listActiveForInstances(instances.map(inst => inst.id))
        : []
    } catch (_) {
      activeHealth = []
    }

    const total = grouped.due.length + grouped.check.length + openTasks.length + sowing.length + cutting.length + activeHealth.length
    const taskItems = openTasks.map(task => {
      const inst = byInstanceId.get(task.plant_instance_id)
      return {
        name: task.title || task.task_type || '일정 확인',
        location: inst ? locLabel(locationForInstance(inst, locations), locations) : '',
      }
    })
    const sowingItems = sowing.map(inst => ({
      name: inst.plants?.name ?? '식물',
      location: locLabel(locationForInstance(inst, locations), locations),
    }))
    const cuttingItems = cutting.map(inst => ({
      name: inst.plants?.name ?? '식물',
      location: locLabel(locationForInstance(inst, locations), locations),
    }))
    const healthItems = activeHealth.map(log => {
      const inst = byInstanceId.get(log.garden_plant_id)
      return {
        name: inst?.plants?.name ?? log.issue_name ?? '건강 확인',
        location: inst ? locLabel(locationForInstance(inst, locations), locations) : '',
      }
    })
    const html = total
      ? [
          `<p>오늘 챙길 일이 <b>${total}개</b> 있어요.</p>`,
          `<div class="butler-summary-grid">
            <span>물주기 ${grouped.due.length}</span>
            <span>흙확인 ${grouped.check.length}</span>
            <span>일정 ${openTasks.length}</span>
            <span>파종 ${sowing.length}</span>
            <span>삽목 ${cutting.length}</span>
            <span>건강 ${activeHealth.length}</span>
          </div>`,
          grouped.due.length ? `<p class="butler-subtitle">먼저 물줄 식물</p>${itemList(grouped.due, 4)}` : '',
          grouped.check.length ? `<p class="butler-subtitle">흙마름 확인</p>${itemList(grouped.check, 4)}` : '',
          openTasks.length ? `<p class="butler-subtitle">등록한 일정</p>${itemList(taskItems, 4)}` : '',
          sowing.length ? `<p class="butler-subtitle">파종 확인</p>${itemList(sowingItems, 4)}` : '',
          cutting.length ? `<p class="butler-subtitle">삽목 확인</p>${itemList(cuttingItems, 4)}` : '',
          activeHealth.length ? `<p class="butler-subtitle">건강 관리</p>${itemList(healthItems, 4)}` : '',
        ].join('')
      : '오늘은 특별히 챙길 일이 없어 보여요. 정원 상태만 가볍게 둘러봐 주세요.'
    return {
      html,
      actions: [
        { label: '달력 보기', href: 'calendar.html' },
        { label: '정원식물 보기', href: 'flowerbed.html' },
      ],
    }
  }

  function extractSearchTerm(text) {
    return text
      .replace(/[?？!！.,。]/g, ' ')
      .replace(/도감|내|정원|식물|찾아줘|찾기|검색|어디|있어|에서|으로|를|을|좀|해줘|해/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function removeLocationText(text, loc) {
    let term = String(text ?? '')
    if (loc?.name) {
      const escaped = String(loc.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      term = term.replace(new RegExp(`${escaped}\\s*(에|에서|으로|로|안에|쪽에)?`, 'g'), ' ')
    }
    return term
  }

  function extractPlantingTerm(text, loc = null) {
    return removeLocationText(text, loc)
      .replace(/[?？!！.,。]/g, ' ')
      .replace(/\d+\s*(개|포기|주|그루|송이)?/g, ' ')
      .replace(/(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)\s*(개|포기|주|그루|송이)/g, ' ')
      .replace(/어디에|어디|어느|심는게|심는\s*게|심어야|심을까|심으면|심기|심어|좋아|좋을까|좋을|같아|배치|추천|해줘|해야|해주세요|주면|해|돼|되|를|을|은|는|좀/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function isDirectPlantingCommand(text) {
    const q = String(text ?? '')
    const explicitAction = /(심어\s*$|심어[.!！。]?$|심어\s*줘|심어줘|심어\s*달|심어\s*주|심어둘|심어놔|심어라|심어주세요|파종\s*해|파종해|씨\s*뿌려|씨앗\s*뿌려|삽목\s*해|삽목해|꺾꽂이\s*해)/.test(q)
    const softAction = /(심어\s*주면|심으면\s*좋|심는\s*게\s*좋|심는게\s*좋)/.test(q) && parseQuantity(q)
    const placementQuestion = /(어디|어느|어디에|추천|심어야|무얼|뭐|무엇)/.test(q)
    return (explicitAction || softAction) && !placementQuestion
  }

  function plantingStatusFromText(text) {
    if (/삽목|꺾꽂이/.test(text)) return '삽목'
    if (/파종|씨\s*뿌|씨앗\s*뿌/.test(text)) return '파종'
    return '생육중'
  }

  function normalizePlantText(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[()\[\]{}'"`.,?？!！。·ㆍ\-_/\\]/g, '')
      .replace(/\s+/g, '')
      .trim()
  }

  function plantSearchTerms(term) {
    const base = String(term ?? '').trim()
    const normalized = normalizePlantText(base)
    const terms = [base]
    const aliases = {
      니켈라: ['니겔라', 'nigella'],
      니겔라: ['니켈라', 'nigella'],
      nigella: ['니겔라', '니켈라'],
    }
    ;(aliases[normalized] ?? []).forEach(alias => terms.push(alias))
    return [...new Set(terms.filter(Boolean))]
  }

  async function findCatalogPlants(term) {
    if (!window.plantsApi?.list) return []
    const terms = plantSearchTerms(term)
    const rows = []
    for (const q of terms) {
      try {
        const found = await window.plantsApi.list(q, '')
        rows.push(...found)
      } catch (_) {}
    }
    const unique = [...new Map(rows.map(row => [row.id, row])).values()]
    const wanted = normalizePlantText(term)
    return unique.sort((a, b) => {
      const an = normalizePlantText(a.name)
      const bn = normalizePlantText(b.name)
      if (an === wanted && bn !== wanted) return -1
      if (bn === wanted && an !== wanted) return 1
      if (a.id?.includes(wanted) && !b.id?.includes(wanted)) return -1
      if (b.id?.includes(wanted) && !a.id?.includes(wanted)) return 1
      return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ko')
    })
  }

  async function answerCatalogSearch(text) {
    const term = extractSearchTerm(text)
    if (!term) {
      return { html: '찾고 싶은 식물 이름을 같이 말해 주세요. 예: “도감에서 감국 찾아줘”', actions: [{ label: '도감 열기', href: 'mybook.html' }] }
    }
    const rows = window.plantsApi?.list ? await window.plantsApi.list(term, '') : []
    if (!rows.length) {
      return { html: `"${escapeHtml(term)}"은 도감에서 찾지 못했어요. 사진으로 식물 찾기를 이용해 보세요.`, actions: [{ label: '도감 열기', href: 'mybook.html' }] }
    }
    const list = rows.slice(0, 5).map(plant => `<li><a href="plant-detail.html#${plant.id}">${escapeHtml(plant.name)}${plant.category ? ` · ${escapeHtml(plant.category)}` : ''}</a></li>`).join('')
    return {
      html: `<p>도감에서 ${rows.length}개를 찾았어요.</p><ul class="butler-list">${list}</ul>`,
      actions: [{ label: '도감으로 이동', href: `mybook.html?q=${encodeURIComponent(term)}` }],
    }
  }

  async function answerGardenPlantSearch(text) {
    const term = extractSearchTerm(text)
    const { locations, instances } = await loadBaseData()
    const q = term.replace(/\s+/g, '')
    let rows = instances
    if (q) {
      rows = instances.filter(inst => String(inst.plants?.name ?? '').replace(/\s+/g, '').includes(q))
    }
    if (!rows.length) {
      return { html: q ? `"${escapeHtml(term)}"은 정원식물에서 찾지 못했어요.` : '찾고 싶은 내 식물 이름을 같이 말해 주세요.', actions: [{ label: '정원식물 보기', href: 'flowerbed.html' }] }
    }
    const list = rows.slice(0, 6).map(inst => {
      const loc = locLabel(locationForInstance(inst, locations), locations)
      return `<li><a href="instance-detail.html#${inst.id}">${escapeHtml(inst.plants?.name ?? '식물')} · ${escapeHtml(loc)}</a></li>`
    }).join('')
    return {
      html: `<p>정원식물에서 ${rows.length}개를 찾았어요.</p><ul class="butler-list">${list}</ul>`,
      actions: [{ label: '정원식물 보기', href: 'flowerbed.html' }],
    }
  }

  function parseCm(value) {
    const raw = String(value ?? '')
    const nums = [...raw.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]))
    if (!nums.length) return null
    return Math.max(...nums)
  }

  function sunlightScore(plantSun, locSun) {
    if (!plantSun || !locSun) return { score: 0, text: '일조량 정보가 부족해 직접 확인이 필요해요.' }
    if (locSun.includes(plantSun) || plantSun.includes(locSun)) return { score: 3, text: `${locSun} 조건이 잘 맞아요.` }
    if ((plantSun.includes('양지') || plantSun.includes('직사')) && (locSun.includes('직사') || locSun.includes('양지'))) return { score: 3, text: `${locSun}라 햇빛 조건이 좋아요.` }
    if ((plantSun.includes('반') || plantSun.includes('반음지')) && (locSun.includes('반') || locSun.includes('반음지'))) return { score: 3, text: '반음지 조건이 잘 맞아요.' }
    if (plantSun.includes('음지') && locSun.includes('음지')) return { score: 3, text: '음지 조건이 잘 맞아요.' }
    if (plantSun.includes('반') && (locSun.includes('양지') || locSun.includes('직사'))) return { score: 1, text: '햇빛이 강할 수 있어 앞쪽보다 살짝 가려지는 자리가 좋아요.' }
    if ((plantSun.includes('양지') || plantSun.includes('직사')) && locSun.includes('음지')) return { score: -2, text: '햇빛이 부족할 수 있어요.' }
    return { score: 0, text: `${plantSun} 선호라 ${locSun} 환경을 한 번 더 확인해 주세요.` }
  }

  function soilScore(plantSoil, loc) {
    const soil = String(plantSoil ?? '').trim()
    const locSoil = String(loc?.soil_type ?? '').trim()
    const memo = `${loc?.name ?? ''} ${locSoil} ${loc?.note ?? ''}`.toLowerCase()
    if (!soil) return { score: 0, text: '토양 정보가 부족해요.' }
    if (!locSoil) return { score: 0, text: `${soil} 선호. 구역 흙 정보를 입력하면 더 정확해요.` }
    const tokens = ['배수', '양토', '사질', '건조', '마른', '습한', '산성', '중성', '비옥', '점토', '분갈이', '배합토', '마사토', '상토', '화분']
    const matched = tokens.filter(token => soil.includes(token) && memo.includes(token))
    if (matched.length) return { score: 2.5, text: `${locSoil}라 ${matched.join(', ')} 조건이 맞아 보여요.` }
    return { score: -0.5, text: `${locSoil}예요. ${soil} 선호와 맞는지 확인해 주세요.` }
  }

  function heightPosition(heightCm) {
    if (heightCm == null) return '중간'
    if (heightCm >= 120) return '뒤쪽'
    if (heightCm <= 45) return '앞쪽'
    return '중간'
  }

  function neighborAdvice(plant, neighbors) {
    if (!neighbors.length) return '주변 식물이 적어 간격을 넉넉히 잡기 좋아요.'
    const targetH = parseCm(plant.height)
    const shorter = neighbors.filter(inst => parseCm(inst.plants?.height) != null && parseCm(inst.plants?.height) < (targetH ?? 80))
    const similar = neighbors.filter(inst => inst.plants?.category && inst.plants.category === plant.category)
    if (similar.length) return `${similar[0].plants.name} 근처는 관리 조건이 비슷할 가능성이 있어요.`
    if (shorter.length && targetH && targetH >= 80) return `${shorter[0].plants.name} 뒤쪽에 두면 키 차이가 자연스러워요.`
    return `${neighbors[0].plants?.name ?? '기존 식물'} 옆은 간격과 통풍을 확인해 주세요.`
  }

  async function answerPlantingPlace(text) {
    const { locations, instances } = await loadBaseData()
    const locMention = findLocationMention(text, locations)
    const term = extractPlantingTerm(text, locMention)
    if (!term) {
      return {
        html: '어디에 심을지 추천하려면 식물 이름을 같이 말해 주세요. 예: “감국 어디에 심어야 해?”',
        actions: [{ label: '도감에서 찾기', question: '도감에서 찾아줘' }],
      }
    }
    const matches = await findCatalogPlants(term)
    if (!matches.length) {
      return {
        html: `"${escapeHtml(term)}"은 도감에서 찾지 못했어요. 먼저 도감에서 식물을 확인해 주세요.`,
        actions: [{ label: '도감 열기', href: 'mybook.html' }],
      }
    }
    const plant = window.plantsApi?.getById ? await window.plantsApi.getById(matches[0].id) : matches[0]
    const scopedChildren = locMention ? childLocationsOf(locMention, locations) : []
    const candidates = scopedChildren.length
      ? scopedChildren
      : locMention
        ? [locMention]
        : locations.filter(loc => loc.level === 2 || !locations.some(child => child.parent_id === loc.id))
    if (!candidates.length) {
      return { html: '추천할 정원 구역이 아직 없어요. 정원에서 구역을 먼저 만들어 주세요.', actions: [{ label: '정원으로 이동', href: 'garden.html' }] }
    }

    const scored = candidates.map(loc => {
      const sun = window.locationUtil?.getEffectiveSunlight ? window.locationUtil.getEffectiveSunlight(loc.id, locations).value : loc.sunlight_type
      const sunEval = sunlightScore(plant.sun, sun)
      const soilEval = soilScore(plant.soil, loc)
      const neighbors = instances.filter(inst => inst.location_id === loc.id)
      const position = heightPosition(parseCm(plant.height))
      const score = sunEval.score + soilEval.score + Math.min(neighbors.length, 3) * 0.2
      return { loc, sun, sunEval, soilEval, neighbors, position, score }
    }).sort((a, b) => b.score - a.score).slice(0, 3)

    const cards = scored.map((item, index) => `
      <section class="butler-place-card">
        <div class="butler-place-head">
          <span class="butler-place-rank">${index + 1}</span>
          <strong class="butler-place-name">${escapeHtml(locLabel(item.loc, locations))}</strong>
          <span class="butler-place-pos">${escapeHtml(item.position)} 자리</span>
        </div>
        <div class="butler-place-lines">
          <p class="butler-place-line"><b>햇빛</b><span>${escapeHtml(item.sunEval.text)}</span></p>
          <p class="butler-place-line"><b>흙</b><span>${escapeHtml(item.soilEval.text)}</span></p>
          <p class="butler-place-line"><b>주변</b><span>${escapeHtml(neighborAdvice(plant, item.neighbors))}</span></p>
        </div>
        <a class="butler-place-plant-btn" href="flowerbed.html?add=1&plant=${encodeURIComponent(plant.id)}&loc=${encodeURIComponent(item.loc.id)}">이 구역에 심기</a>
      </section>
    `).join('')

    return {
      html: `<p class="butler-place-intro"><b>${escapeHtml(topicLabel(plant.name))}</b> 아래 순서로 확인해 보세요.</p><div class="butler-place-cards">${cards}</div><p class="butler-note">도감의 햇빛, 토양, 키와 현재 구역의 주변 식물 정보를 기준으로 추천했어요.</p>`,
      actions: [
        { label: '정원식물 등록', href: 'flowerbed.html' },
        { label: '도감 상세', href: `plant-detail.html#${plant.id}` },
      ],
    }
  }

  function findLocationMention(text, locations) {
    const q = normalizePlantText(text)
    return [...locations]
      .sort((a, b) => String(b.name ?? '').length - String(a.name ?? '').length)
      .find(loc => loc.name && q.includes(normalizePlantText(loc.name))) ?? null
  }

  function childLocationsOf(loc, locations) {
    if (!loc?.id) return []
    return locations.filter(row => row.parent_id === loc.id)
  }

  function extractPlantNameForPlanting(text, loc) {
    let term = String(text ?? '')
      .replace(/[?？!！.,。]/g, ' ')
      .replace(/심어\s*줘요|심어\s*주세요|심어\s*줘|심어줘|심어\s*달라|심어\s*달라고|심어\s*주라|심어\s*줘라|심어라/g, ' ')
      .replace(/파종\s*해줘요|파종\s*해주세요|파종\s*해줘|파종해줘|파종\s*해|파종해|씨\s*뿌려줘|씨앗\s*뿌려줘|삽목\s*해줘요|삽목\s*해주세요|삽목\s*해줘|삽목해줘|삽목\s*해|삽목해|꺾꽂이\s*해/g, ' ')
      .replace(/\d+\s*(개|포기|주|그루|송이)?/g, ' ')
      .replace(/(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)\s*(개|포기|주|그루|송이)/g, ' ')
      .replace(/를|을|은|는|좀|여기|저기/g, ' ')
    if (loc?.name) {
      const escaped = String(loc.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      term = term.replace(new RegExp(`${escaped}\\s*(에|에서|으로|로)?`, 'g'), ' ')
    }
    return term.replace(/\s+/g, ' ').trim()
  }

  function parseQuantity(text) {
    const raw = String(text ?? '').trim()
    const num = Number(raw.match(/\d+/)?.[0])
    if (Number.isFinite(num) && num > 0) return Math.min(999, Math.floor(num))
    const korean = {
      한: 1, 하나: 1, 한개: 1, 한포기: 1,
      두: 2, 둘: 2, 두개: 2, 두포기: 2,
      세: 3, 셋: 3, 세개: 3, 세포기: 3,
      네: 4, 넷: 4, 네개: 4, 네포기: 4,
      다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
    }
    const compact = raw.replace(/\s+/g, '')
    for (const [word, value] of Object.entries(korean)) {
      if (compact.includes(word)) return value
    }
    return null
  }

  function quantityActions() {
    return [1, 3, 5, 10].map(num => ({
      label: `${num}개`,
      question: `${num}개`,
      mode: 'planting-quantity',
      value: String(num),
    }))
  }

  function plantingQuantityQuestion(flow) {
    const verb = flow.status === '파종' ? '파종할게요' : flow.status === '삽목' ? '삽목할게요' : '심을게요'
    const ask = flow.status === '파종' ? '몇 개 파종할까요?' : flow.status === '삽목' ? '몇 개 삽목할까요?' : '몇 개 심을까요?'
    return {
      html: `<p><b>${escapeHtml(flow.plant.name)}</b>을 <b>${escapeHtml(locLabel(flow.location, flow.locations))}</b>에 ${verb}.</p><p class="butler-note">${ask}</p>`,
      actions: quantityActions(),
    }
  }

  function plantChoiceActions(matches) {
    return matches.slice(0, 6).map(plant => ({
      label: plant.name,
      question: plant.name,
      mode: 'planting-plant',
      value: plant.id,
    }))
  }

  function locationChoiceActions(locations, allLocs) {
    return locations.slice(0, 8).map(loc => ({
      label: loc.name,
      question: locLabel(loc, allLocs),
      mode: 'planting-location',
      value: loc.id,
    }))
  }

  function plantingLocationQuestion(flow) {
    return {
      html: `<p><b>${escapeHtml(flow.parentLocation.name)}</b> 안에 구역이 ${flow.locationOptions.length}개 있어요.</p><p class="butler-note">어느 구역에 넣을까요?</p>`,
      actions: locationChoiceActions(flow.locationOptions, flow.locations),
    }
  }

  function nextPlantingStep(flow) {
    if (!flow.plant && flow.matches?.length) {
      return {
        html: `<p><b>${escapeHtml(flow.term || '식물')}</b> 후보가 ${flow.matches.length}개 있어요.</p><p class="butler-note">어떤 식물을 심을까요?</p>`,
        actions: plantChoiceActions(flow.matches),
      }
    }
    if (!flow.location && flow.locationOptions?.length) return plantingLocationQuestion(flow)
    if (flow.quantity) return answerPlantingQuantity(String(flow.quantity))
    return plantingQuantityQuestion(flow)
  }

  async function startDirectPlantingFlow(text) {
    const { locations } = await loadBaseData()
    const quantity = parseQuantity(text)
    const status = plantingStatusFromText(text)
    const loc = findLocationMention(text, locations)
    if (!loc) {
      return {
        html: '어느 정원에 심을지 같이 말해 주세요. 예: “감국 하우스에 심어줘”',
        actions: [{ label: '정원식물 등록', href: 'flowerbed.html' }],
      }
    }
    const term = extractPlantNameForPlanting(text, loc)
    if (!term) {
      return {
        html: '심을 식물 이름을 같이 말해 주세요. 예: “감국 하우스에 심어줘”',
        actions: [{ label: '도감 열기', href: 'mybook.html' }],
      }
    }
    const matches = await findCatalogPlants(term)
    if (!matches.length) {
      return {
        html: `"${escapeHtml(term)}"은 도감에서 찾지 못했어요. 먼저 도감에서 식물을 확인해 주세요.`,
        actions: [{ label: '도감 열기', href: `mybook.html?q=${encodeURIComponent(term)}` }],
      }
    }
    const children = childLocationsOf(loc, locations)
    const plant = matches.length === 1
      ? (window.plantsApi?.getById ? await window.plantsApi.getById(matches[0].id) : matches[0])
      : null
    state.plantingFlow = {
      term,
      matches: matches.length > 1 ? matches : null,
      plant,
      parentLocation: children.length ? loc : null,
      location: children.length ? null : loc,
      locationOptions: children,
      locations,
      quantity,
      status,
    }
    return nextPlantingStep(state.plantingFlow)
  }

  async function answerPlantingPlant(value) {
    const flow = state.plantingFlow
    if (!flow?.matches?.length) return simpleAnswer('심을 식물을 다시 알려주세요.')
    const plantId = String(value ?? '').trim()
    const found = flow.matches.find(plant => plant.id === plantId || plant.name === plantId) ?? flow.matches[0]
    const plant = window.plantsApi?.getById ? await window.plantsApi.getById(found.id) : found
    state.plantingFlow = { ...flow, plant, matches: null }
    return nextPlantingStep(state.plantingFlow)
  }

  function answerPlantingLocation(value) {
    const flow = state.plantingFlow
    if (!flow?.locationOptions?.length) return simpleAnswer('심을 구역을 다시 알려주세요.')
    const selected = flow.locationOptions.find(loc => loc.id === value || loc.name === value || locLabel(loc, flow.locations) === value)
    if (!selected) {
      return {
        html: '목록에 있는 구역 중에서 골라주세요.',
        actions: locationChoiceActions(flow.locationOptions, flow.locations),
      }
    }
    state.plantingFlow = { ...flow, location: selected, locationOptions: [] }
    return nextPlantingStep(state.plantingFlow)
  }

  function parseDayRangeText(value) {
    const nums = String(value ?? '').match(/\d+/g)?.map(Number) ?? []
    if (nums.length >= 2) return { min: nums[0], max: nums[1] }
    if (nums.length === 1) return { min: nums[0], max: nums[0] }
    return null
  }

  function sowingRange(plant) {
    const min = Number(plant?.germination_days_min)
    const max = Number(plant?.germination_days_max)
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max }
    return parseDayRangeText(plant?.germination) || { min: 7, max: 14, fallback: true }
  }

  function cuttingRange(plant) {
    const min = Number(plant?.cutting_root_days_min)
    const max = Number(plant?.cutting_root_days_max)
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max }
    return { min: 14, max: 28, fallback: true }
  }

  async function createPlantingCareTasks(instanceId, status, baseDate, plant) {
    if (!window.tasksApi?.add) return
    const start = baseDate || todayStr()
    if (status === '파종') {
      const range = sowingRange(plant)
      await window.tasksApi.add({
        plant_instance_id: instanceId,
        title: '발아 확인',
        task_type: '발아 확인',
        due_date: addDaysKey(start, range.min),
        memo: range.fallback ? '일반 기준으로 발아 상태를 확인하세요.' : `${range.min}~${range.max}일 기준으로 발아 상태를 확인하세요.`,
      })
    } else if (status === '삽목') {
      const range = cuttingRange(plant)
      await window.tasksApi.add({
        plant_instance_id: instanceId,
        title: '삽목 상태 확인',
        task_type: '삽목 확인',
        due_date: addDaysKey(start, 7),
        memo: '잎 마름, 곰팡이, 과습 여부를 확인하세요.',
      })
      await window.tasksApi.add({
        plant_instance_id: instanceId,
        title: '뿌리 확인',
        task_type: '뿌리 확인',
        due_date: addDaysKey(start, range.min),
        memo: range.fallback ? '일반 기준으로 발근 여부를 확인하세요.' : `${range.min}~${range.max}일 기준으로 발근 여부를 확인하세요.`,
      })
    }
  }

  async function answerPlantingQuantity(value) {
    const flow = state.plantingFlow
    if (!flow) return simpleAnswer('심을 식물과 정원을 먼저 알려주세요. 예: “감국 하우스에 심어줘”')
    if (!flow.plant && flow.matches?.length) return answerPlantingPlant(value)
    if (!flow.location && flow.locationOptions?.length) return answerPlantingLocation(value)
    const quantity = parseQuantity(value)
    if (!quantity) {
      return {
        html: '몇 개 심을지 숫자로 알려주세요. 예: “3개”',
        actions: quantityActions(),
      }
    }
    const payload = {
      plant_id: flow.plant.id,
      location_id: flow.location.id,
      location: locLabel(flow.location, flow.locations),
      status: flow.status || '생육중',
      quantity,
      planted_date: todayStr(),
      cultivation_type: flow.location.cultivation_type || '노지',
    }
    const inst = await window.gardenApi.insert(payload)
    await createPlantingCareTasks(inst.id, payload.status, payload.planted_date, flow.plant)
    state.plantingFlow = null
    const doneVerb = payload.status === '파종' ? '파종했어요' : payload.status === '삽목' ? '삽목했어요' : '심었어요'
    const taskNote = ['파종', '삽목'].includes(payload.status) ? '<p class="butler-note">확인 일정도 달력에 함께 넣어두었습니다.</p>' : '<p class="butler-note">정원식물에 바로 반영했습니다.</p>'
    return {
      html: `<p><b>${escapeHtml(flow.plant.name)} ${quantity}개</b>를 ${escapeHtml(locLabel(flow.location, flow.locations))}에 ${doneVerb}.</p>${taskNote}`,
      actions: [
        { label: '등록한 식물 보기', href: `instance-detail.html#${inst.id}` },
        { label: '정원식물 보기', href: 'flowerbed.html' },
      ],
    }
  }

  function simpleAnswer(html, actions = []) {
    return { html, actions }
  }

  function isWateringQuestion(text) {
    return /(물\s*(줘|줄|주기|줬|줬어|줬니|줘도|주면|주까|줄까)|물줘|물주기|급수|흙마름|마름\s*확인|줘도\s*돼|줘야\s*해)/.test(text)
  }

  function isPlantRecommendationQuestion(text) {
    const q = String(text ?? '').replace(/\s+/g, '')
    if (!q) return false
    const hasContext = /(정원|화단|자리|구역|텃밭|꽃밭|빈자리|빈공간|여기|거기|앞쪽|뒤쪽|가운데|중앙|옆|근처)/.test(q)
    const hasQuestionWord = /(무얼|무엇|뭐|뭘|어떤|어느|추천|후보|식물)/.test(q)
    const hasPlantingIntent = /(심|식재|추가|더넣|넣을|넣지|채우|보완|어울|추천|꾸미|배치)/.test(q)
    const hasPlantNoun = /(식물|꽃|허브|나무|관목|채소|모종|묘목|구근)/.test(q)

    if (/식물추천|추천식물|심을만한|심기좋은|추가할만한|어울리는식물/.test(q)) return true
    if (hasContext && hasQuestionWord && hasPlantingIntent) return true
    if (hasQuestionWord && hasPlantingIntent && hasPlantNoun) return true
    if (/(무얼|무엇|뭐|뭘|어떤).*(더)?(심을까|심지|심어|심으면|심는게|심는게좋|넣지|넣을까|채울까|어울|추천)/.test(q)) return true
    if (/(더심을까|뭘심지|뭐심지|무얼심지|무엇심지|뭐넣지|뭘넣지|뭐가어울려|뭘추가하지)/.test(q)) return true
    return false
  }

  function unsupportedAnswer() {
    return simpleAnswer('아직 할 수 없는 기능이에요.', [
      { label: '오늘 할일', question: '오늘 할일 알려줘' },
      { label: '물주기 확인', question: '오늘 물 줘도 돼?' },
    ])
  }

  async function routeQuestion(text) {
    const q = text.trim()
    if (!q) return simpleAnswer('무엇을 도와드릴까요?')
    if (state.plantingFlow) return answerPlantingQuantity(q)
    if (state.recommendFlow) return answerGardenRecommendationChoice(q)
    if (isPlantRecommendationQuestion(q)) return startRecommendationFromText(q)
    if (isDirectPlantingCommand(q)) return startDirectPlantingFlow(q)
    if (/(심|배치|어디에|어디|어느).*(좋|추천|까|해|돼|지)|어디에|어디\s*심/.test(q) && !/심었/.test(q)) return answerPlantingPlace(q)
    if (isWateringQuestion(q)) return answerWatering(q)
    if (/오늘|할일|할 일|일정|해야/.test(q)) return answerTodayTasks()
    if (/상태|아파|아픈|벌레|병|곰팡이|가루|잎/.test(q)) {
      return simpleAnswer('상태 상담은 정원식물 상세에서 증상을 눌러 기록하면 가장 정확해요.', [
        { label: '정원식물 보기', href: 'flowerbed.html' },
      ])
    }
    if (/추가|등록|심었|심기/.test(q)) {
      return simpleAnswer('정원식물 등록 화면으로 이동해서 위치와 수량을 확인해 주세요.', [
        { label: '식물 등록하기', href: 'flowerbed.html' },
      ])
    }
    if (/도감/.test(q)) return answerCatalogSearch(q)
    if (/(내\s*)?(식물|정원식물).*(찾|검색|어디)|찾아줘|검색해/.test(q)) return answerGardenPlantSearch(q)
    return unsupportedAnswer()
  }

  function renderMessages() {
    const body = document.getElementById('butler-messages')
    if (!body) return
    body.innerHTML = state.messages.map(msg => {
      const actions = msg.actions?.length
        ? `<div class="butler-actions">${msg.actions.map(action => {
            if (action.href) return `<a class="butler-action" href="${action.href}">${escapeHtml(action.label)}</a>`
            return `<button class="butler-action ${action.selected ? 'selected' : ''}" type="button"
              data-butler-question="${escapeHtml(action.question ?? action.label)}"
              ${action.mode ? `data-butler-mode="${escapeHtml(action.mode)}"` : ''}
              ${action.value ? `data-butler-value="${escapeHtml(action.value)}"` : ''}>${escapeHtml(action.label)}</button>`
          }).join('')}</div>`
        : ''
      return `<div class="butler-msg butler-msg-${msg.role}"><div class="butler-bubble">${msg.html}</div>${actions}</div>`
    }).join('')
    body.scrollTop = body.scrollHeight
  }

  function setStatus(text) {
    const el = document.getElementById('butler-status')
    if (el) el.textContent = text || ''
  }

  function isSilentMultiSelectAction(action = {}) {
    if (action.mode !== 'recommend-choice' || !state.recommendFlow) return false
    const steps = activeRecommendationSteps(state.recommendFlow.answers)
    const step = steps[state.recommendFlow.step]
    return Boolean(step?.multi && String(action.value ?? '') !== '__done__')
  }

  function replaceLastBotMessage(answer) {
    const index = [...state.messages].map(msg => msg.role).lastIndexOf('bot')
    const next = { role: 'bot', html: answer.html, actions: answer.actions ?? [] }
    if (index >= 0) state.messages[index] = next
    else state.messages.push(next)
  }

  async function ask(text, action = {}) {
    const input = document.getElementById('butler-input')
    const question = String(text ?? input?.value ?? '').trim()
    const answerValue = String(action.value || question).trim()
    if (!question || state.loading) return
    if (input) input.value = ''
    state.draft = ''
    const silentMultiSelect = isSilentMultiSelectAction(action)
    if (!silentMultiSelect) state.messages.push({ role: 'user', html: escapeHtml(question) })
    state.loading = true
    if (!silentMultiSelect) {
      setStatus('정원집사가 확인 중이에요...')
      renderMessages()
    }
    saveCache('')
    try {
      const answer = action.mode === 'recommend-choice'
        ? await answerGardenRecommendationChoice(answerValue)
        : action.mode === 'planting-plant'
          ? await answerPlantingPlant(answerValue)
        : action.mode === 'planting-location'
          ? await answerPlantingLocation(answerValue)
        : action.mode === 'planting-quantity'
          ? await answerPlantingQuantity(answerValue)
        : action.mode === 'start-recommend'
          ? await startRecommendationFlow({ locationId: answerValue })
          : await routeQuestion(question)
      if (silentMultiSelect) replaceLastBotMessage(answer)
      else state.messages.push({ role: 'bot', html: answer.html, actions: answer.actions ?? [] })
    } catch (err) {
      console.warn('butler failed', err)
      const detail = String(err?.message || '').trim()
      const errorAnswer = {
        html: detail
          ? `확인 중 문제가 생겼어요.<br><span class="butler-note">${escapeHtml(detail)}</span>`
          : '확인 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.',
      }
      if (silentMultiSelect) replaceLastBotMessage(errorAnswer)
      else state.messages.push({ role: 'bot', html: errorAnswer.html })
    } finally {
      state.loading = false
      setStatus('')
      renderMessages()
      saveCache('')
    }
  }

  function openButler() {
    loadCache()
    state.open = true
    document.getElementById('butler-root')?.classList.add('open')
    const input = document.getElementById('butler-input')
    if (input && state.draft) input.value = state.draft
    setTimeout(() => input?.focus(), 120)
    if (!state.messages.length) {
      state.messages.push({
        role: 'bot',
        html: '안녕하세요. 저는 정원집사예요. 물주기, 오늘 할일, 식물 찾기를 도와드릴게요.',
      })
      renderMessages()
      saveCache()
    } else {
      renderMessages()
    }
  }

  function closeButler() {
    state.open = false
    saveCache()
    document.getElementById('butler-root')?.classList.remove('open')
    stopVoice()
  }

  function setupVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const btn = document.getElementById('butler-voice')
    if (!btn) return
    if (!SpeechRecognition) {
      btn.disabled = true
      btn.title = '이 브라우저는 음성 입력을 지원하지 않아요.'
      return
    }
    const recognition = new SpeechRecognition()
    recognition.lang = 'ko-KR'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onstart = () => {
      state.listening = true
      btn.classList.add('listening')
      setStatus('듣고 있어요...')
    }
    recognition.onend = () => {
      state.listening = false
      btn.classList.remove('listening')
      setStatus('')
    }
    recognition.onerror = () => {
      state.listening = false
      btn.classList.remove('listening')
      setStatus('마이크 권한을 확인해 주세요.')
    }
    recognition.onresult = event => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? ''
      const input = document.getElementById('butler-input')
      if (input) input.value = transcript
      saveCache(transcript)
      setStatus('음성을 입력했어요. 전송을 눌러주세요.')
    }
    state.recognition = recognition
  }

  function toggleVoice() {
    if (!state.recognition) return
    if (state.listening) {
      stopVoice()
      return
    }
    try {
      state.recognition.start()
    } catch (_) {}
  }

  function stopVoice() {
    if (state.recognition && state.listening) {
      try { state.recognition.stop() } catch (_) {}
    }
  }

  function mount() {
    if (document.getElementById('butler-root')) return
    loadCache()
    const root = document.createElement('div')
    root.id = 'butler-root'
    root.innerHTML = `
      <button id="butler-fab" type="button" aria-label="정원집사 열기">
        <span class="butler-fab-icon" aria-hidden="true"></span>
        <span class="butler-fab-label">정원집사</span>
      </button>
      <div id="butler-panel" role="dialog" aria-label="정원집사">
        <div class="butler-handle"></div>
        <div class="butler-head">
          <div>
            <p class="butler-title">정원집사</p>
            <p id="butler-status" class="butler-status"></p>
          </div>
          <button id="butler-close" type="button" aria-label="닫기">×</button>
        </div>
        <div class="butler-quick">
          ${QUICK_QUESTIONS.map(q => `<button type="button" data-butler-question="${escapeHtml(q.question)}">${escapeHtml(q.label)}</button>`).join('')}
        </div>
        <div id="butler-messages"></div>
        <div class="butler-input-row">
          <button id="butler-voice" type="button" aria-label="음성 입력"></button>
          <input id="butler-input" type="text" placeholder="예: 오늘 물 줘도 돼?" autocomplete="off" />
          <button id="butler-send" type="button">전송</button>
        </div>
      </div>`
    document.body.appendChild(root)

    document.getElementById('butler-fab').addEventListener('click', openButler)
    document.getElementById('butler-close').addEventListener('click', closeButler)
    document.getElementById('butler-send').addEventListener('click', () => ask())
    root.addEventListener('click', event => {
      const btn = event.target.closest('[data-butler-question]')
      if (!btn || !root.contains(btn)) return
      event.preventDefault()
      ask(btn.dataset.butlerQuestion, {
        mode: btn.dataset.butlerMode,
        value: btn.dataset.butlerValue,
      })
    })
    const input = document.getElementById('butler-input')
    if (input) {
      input.value = state.draft || ''
      input.addEventListener('input', event => saveCache(event.target.value))
    }
    document.getElementById('butler-input').addEventListener('keydown', event => {
      if (event.key === 'Enter') ask()
    })
    document.getElementById('butler-voice').addEventListener('click', toggleVoice)
    setupVoice()
    if (state.messages.length) renderMessages()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }

  function recommend(locationId = '') {
    openButler()
    setTimeout(() => ask('이 정원에 무얼 심을까?', {
      mode: locationId ? 'start-recommend' : undefined,
      value: locationId,
    }), 80)
  }

  window.gardenButler = { open: openButler, close: closeButler, ask, recommend }
})()
