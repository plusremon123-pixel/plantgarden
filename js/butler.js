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

  function locLabel(loc, allLocs) {
    if (!loc) return '위치 없음'
    if (!loc.parent_id) return loc.name
    const parent = allLocs.find(row => row.id === loc.parent_id)
    return parent ? `${parent.name}/${loc.name}` : loc.name
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
    const loc = locations.find(row => q.includes(String(row.name ?? '').replace(/\s+/g, '')))
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
      note: '이미 만들어둔 정원 중에서 기준이 될 곳을 먼저 골라주세요.',
      dynamic: 'locations',
    },
    {
      key: 'need',
      title: '어떤 자리가 필요하세요?',
      note: '앞쪽을 채울지, 뒤쪽에 키 큰 식물이 필요한지 알려주세요.',
      options: ['앞쪽 낮은 식물', '중간 자리', '뒤쪽 키 큰 식물', '포인트 식물', '비어있는 곳 채우기', '상관없음'],
    },
    {
      key: 'color',
      title: '필요한 색감이 있나요?',
      note: '주변 꽃과 어울릴 색을 고르면 더 자연스럽게 추천할게요.',
      options: ['흰색', '노랑', '분홍', '빨강', '보라', '파랑', '상관없음'],
    },
    {
      key: 'type',
      title: '어떤 종류를 볼까요?',
      note: '꽃, 나무, 채소처럼 큰 분류만 골라주세요.',
      options: ['꽃', '나무', '채소', '허브', '구근', '섞어서'],
    },
  ]

  const TYPE_TO_CATEGORY = {
    꽃: ['꽃', '장미'],
    나무: ['나무'],
    채소: ['채소'],
    허브: ['허브'],
    구근: ['구근'],
  }

  const SCALE_META = {
    '작은 자리': { sqm: 1, kinds: 2, label: '1평 미만' },
    '보통 화단': { sqm: 3.3, kinds: 3, label: '1~3평' },
    '넓은 화단': { sqm: 6.6, kinds: 5, label: '3평 이상' },
    '화분 몇 개': { sqm: 0.8, kinds: 2, label: '화분 2~4개' },
    '잘 모르겠음': { sqm: 2, kinds: 3, label: '작은 화단 기준' },
  }

  async function recommendationLocationOptions() {
    const { locations } = await loadBaseData()
    const hasChildren = new Set(locations.map(loc => loc.parent_id).filter(Boolean))
    const rows = locations.filter(loc => loc.level === 2 || !hasChildren.has(loc.id))
    return rows.map(loc => ({
      label: locLabel(loc, locations),
      value: loc.id,
    }))
  }

  async function startRecommendationFlow(seed = {}) {
    state.recommendFlow = {
      step: seed.locationId ? 1 : 0,
      answers: {
        locationId: seed.locationId || '',
        locationLabel: seed.locationLabel || '',
        type: seed.type || '',
        need: seed.need || '',
        color: seed.color || '',
        scale: seed.scale || '잘 모르겠음',
      },
      locationOptions: seed.locationOptions || await recommendationLocationOptions(),
    }
    return renderRecommendationQuestion()
  }

  function renderRecommendationQuestion() {
    const flow = state.recommendFlow
    const step = RECOMMEND_STEPS[flow?.step ?? 0]
    if (!flow || !step) return null
    const options = step.dynamic === 'locations'
      ? flow.locationOptions.map(item => ({ label: item.label, value: item.value }))
      : step.options.map(option => ({ label: option, value: option }))
    if (!options.length) {
      state.recommendFlow = null
      return { html: '추천할 정원이 아직 없어요. 먼저 정원을 만들어 주세요.', actions: [{ label: '정원으로 이동', href: 'garden.html' }] }
    }
    const choices = options.map(option => ({
      label: option.label,
      question: option.label,
      mode: 'recommend-choice',
      value: option.value,
    }))
    return {
      html: `<p><b>${escapeHtml(step.title)}</b></p><p class="butler-note">${escapeHtml(step.note || '제가 정원 조건을 보고 제안할게요.')}</p>`,
      actions: choices,
    }
  }

  function selectedRecommendationLocation(flow, locations) {
    const id = flow?.answers?.locationId
    if (!id) return null
    return locations.find(loc => loc.id === id) ?? null
  }

  function scoreByNeed(plant, need) {
    if (!need || need === '상관없음') return 0.5
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
    if (!color || color === '상관없음') return 0.5
    const colors = plant.flower_colors ?? []
    const text = `${plant.name ?? ''} ${plant.feature ?? ''} ${plant.recommendation_note ?? ''}`
    return colors.includes(color) || text.includes(color) ? 2 : 0
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

  function scoreByType(plant, type) {
    if (!type || type === '섞어서') return 1
    return matchesSelectedType(plant, type) ? 3 : -6
  }

  function matchesSelectedType(plant, type) {
    if (!type || type === '섞어서') return true
    const categories = TYPE_TO_CATEGORY[type] ?? [type]
    const category = String(plant.category ?? '').trim()
    if (category) return categories.includes(category)
    const tags = plant.plant_types ?? []
    return tags.includes(type)
  }

  function countForPlant(plant, scale) {
    const meta = SCALE_META[scale] ?? SCALE_META['잘 모르겠음']
    const perSqm = parseNumber(plant.plants_per_sqm)
    if (perSqm) {
      const count = Math.max(1, Math.round(perSqm * meta.sqm))
      return Math.min(count, Number(plant.recommended_count_max) || count)
    }
    const min = Number(plant.recommended_count_min) || (meta.sqm <= 1 ? 3 : 5)
    const max = Number(plant.recommended_count_max) || (meta.sqm <= 1 ? 5 : 9)
    return Math.max(1, Math.min(max, min))
  }

  function formatRecommendationReason(plant, loc, locations, answers) {
    const sun = window.locationUtil?.getEffectiveSunlight ? window.locationUtil.getEffectiveSunlight(loc.id, locations).value : loc.sunlight_type
    const sunText = sunlightScore(plant.sun, sun).score > 0 ? '햇빛이 잘 맞아요' : '햇빛은 한번 확인해 주세요'
    const soilText = soilScore(plant.soil, loc).score > 0 ? '흙 조건도 괜찮아요' : '흙 상태는 보완이 필요할 수 있어요'
    const style = plant.grouping_style || (countForPlant(plant, answers.scale) >= 5 ? '군락형' : '포인트형')
    return { sunText, soilText, style }
  }

  async function loadRecommendationPlants() {
    if (!window._supabase) return []
    const { data, error } = await window._supabase
      .from('plants_with_recommendation')
      .select('id, name, category, sun, soil, height, width, bloom, sowing, cutting_note, feature, plant_types, flower_colors, bloom_seasons, start_methods, design_roles, grouping_style, spacing_cm_min, spacing_cm_max, plants_per_sqm, recommended_count_min, recommended_count_max, spread_type, care_difficulty, companion_tags, avoid_tags, design_note, recommendation_note, confidence')
      .limit(120)
    if (error) throw error
    return data ?? []
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
    const step = RECOMMEND_STEPS[flow.step]
    if (step.key === 'locationId') {
      const matched = flow.locationOptions?.find(item => item.value === value || item.label === value)
      if (matched) value = matched.value
    }
    flow.answers[step.key] = value
    if (step.key === 'locationId') flow.answers.locationLabel = recommendationAnswerLabel(flow, step.key, value)
    flow.step += 1
    if (flow.step < RECOMMEND_STEPS.length) return renderRecommendationQuestion()
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

    const scored = []
    plants.forEach(plant => {
      if (!matchesSelectedType(plant, answers.type)) return
      ;[selectedLoc].forEach(loc => {
        const sun = window.locationUtil?.getEffectiveSunlight ? window.locationUtil.getEffectiveSunlight(loc.id, locations).value : loc.sunlight_type
        const sunEval = sunlightScore(plant.sun, sun)
        const soilEval = soilScore(plant.soil, loc)
        const neighbors = existingByLoc.get(loc.id) ?? []
        const typeScore = scoreByType(plant, answers.type)
        const needScore = scoreByNeed(plant, answers.need)
        const colorScore = scoreByColor(plant, answers.color)
        const reviewedBoost = plant.confidence === 'reviewed' ? 0.8 : plant.confidence === 'ai' ? 0.3 : 0
        const score = typeScore + needScore + colorScore + sunEval.score + soilEval.score + reviewedBoost - Math.min(neighbors.length, 6) * 0.08
        if (score > 1) scored.push({ plant, loc, neighbors, score })
      })
    })

    const unique = []
    const seenPlants = new Set()
    scored.sort((a, b) => b.score - a.score).forEach(item => {
      if (seenPlants.has(item.plant.id) || unique.length >= (SCALE_META[answers.scale]?.kinds ?? 3)) return
      seenPlants.add(item.plant.id)
      unique.push(item)
    })

    if (!unique.length) {
      return {
        html: '조건에 딱 맞는 추천을 찾지 못했어요. 조건을 조금 넓혀서 다시 추천받아 보세요.',
        actions: [{ label: '다시 추천받기', question: '정원에 무얼 심을까?' }],
      }
    }

    const scale = SCALE_META[answers.scale] ?? SCALE_META['잘 모르겠음']
    const summaryItems = []
    const cards = unique.map(item => {
      const { plant, loc, neighbors } = item
      const count = countForPlant(plant, answers.scale)
      const reason = formatRecommendationReason(plant, loc, locations, answers)
      const role = plant.design_roles?.[0] || heightPosition(parseCm(plant.height))
      summaryItems.push({ plant, location: locLabel(loc, locations), count, style: reason.style, role })
      return `<section class="butler-reco-card">
        <div class="butler-reco-main">
          <div class="butler-reco-head">
            <strong>${escapeHtml(plant.name)}</strong>
            <span>${escapeHtml(count)}개</span>
          </div>
          <p class="butler-reco-meta">${escapeHtml(locLabel(loc, locations))} · ${escapeHtml(role)} · ${escapeHtml(reason.style)}</p>
          <div class="butler-reco-tags">
            <span>${escapeHtml(reason.sunText)}</span>
            <span>${escapeHtml(reason.soilText)}</span>
            ${plant.bloom ? `<span>${escapeHtml(plant.bloom)}</span>` : ''}
          </div>
          <p class="butler-reco-note">${escapeHtml(plant.design_note || plant.recommendation_note || neighborAdvice(plant, neighbors))}</p>
          <a class="butler-place-plant-btn" href="flowerbed.html?add=1&plant=${encodeURIComponent(plant.id)}&loc=${encodeURIComponent(loc.id)}">이 식물 추가</a>
        </div>
      </section>`
    }).join('')
    const aiSummary = await aiRecommendationSummary({ answers, scale, items: summaryItems })

    return {
      html: `<p class="butler-place-intro"><b>${escapeHtml(locLabel(selectedLoc, locations))}</b>에 어울리는 식물 ${unique.length}종을 골라봤어요.</p>${aiSummary ? `<p class="butler-note">${escapeHtml(aiSummary)}</p>` : ''}<div class="butler-reco-cards">${cards}</div><p class="butler-note">수량과 앞/중간/뒤쪽 역할은 추천 DB와 이 정원의 햇빛·흙·주변 식물 정보를 기준으로 계산하고, 설명은 AI가 보기 쉽게 정리해요.</p>`,
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

  function extractPlantingTerm(text) {
    return text
      .replace(/[?？!！.,。]/g, ' ')
      .replace(/어디에|어디|심어야|심을까|심으면|심기|심어|좋아|좋을까|배치|추천|해줘|해야|해|돼|되|를|을|은|는|좀/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
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
    const tokens = ['배수', '양토', '사질', '건조', '마른', '습한', '산성', '중성', '비옥', '점토']
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
    const term = extractPlantingTerm(text)
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
    const { locations, instances } = await loadBaseData()
    const candidates = locations.filter(loc => loc.level === 2 || !locations.some(child => child.parent_id === loc.id))
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

  function simpleAnswer(html, actions = []) {
    return { html, actions }
  }

  function isWateringQuestion(text) {
    return /(물\s*(줘|줄|주기|줬|줬어|줬니|줘도|주면|주까|줄까)|물줘|물주기|급수|흙마름|마름\s*확인|줘도\s*돼|줘야\s*해)/.test(text)
  }

  async function routeQuestion(text) {
    const q = text.trim()
    if (!q) return simpleAnswer('무엇을 도와드릴까요?')
    if (state.recommendFlow) return answerGardenRecommendationChoice(q)
    if (/(정원|화단|자리).*(무얼|뭐|무엇).*(심|추천)|식물\s*추천|무얼\s*심|뭐\s*심/.test(q)) return startRecommendationFlow()
    if (/심|배치|어디에/.test(q) && !/심었/.test(q)) return answerPlantingPlace(q)
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
    if (/내|정원|어디/.test(q)) return answerGardenPlantSearch(q)
    if (/찾|검색/.test(q)) return answerGardenPlantSearch(q)
    return simpleAnswer('제가 먼저 도와드릴 수 있는 건 물주기, 오늘 할일, 도감 찾기, 내 식물 찾기예요.', [
      { label: '오늘 할일', question: '오늘 할일 알려줘' },
      { label: '물주기 확인', question: '오늘 물 줘도 돼?' },
    ])
  }

  function renderMessages() {
    const body = document.getElementById('butler-messages')
    if (!body) return
    body.innerHTML = state.messages.map(msg => {
      const actions = msg.actions?.length
        ? `<div class="butler-actions">${msg.actions.map(action => {
            if (action.href) return `<a class="butler-action" href="${action.href}">${escapeHtml(action.label)}</a>`
            return `<button class="butler-action" type="button"
              data-butler-question="${escapeHtml(action.question ?? action.label)}"
              ${action.mode ? `data-butler-mode="${escapeHtml(action.mode)}"` : ''}
              ${action.value ? `data-butler-value="${escapeHtml(action.value)}"` : ''}>${escapeHtml(action.label)}</button>`
          }).join('')}</div>`
        : ''
      return `<div class="butler-msg butler-msg-${msg.role}"><div class="butler-bubble">${msg.html}</div>${actions}</div>`
    }).join('')
    body.querySelectorAll('[data-butler-question]').forEach(btn => {
      btn.addEventListener('click', () => ask(btn.dataset.butlerQuestion, {
        mode: btn.dataset.butlerMode,
        value: btn.dataset.butlerValue,
      }))
    })
    body.scrollTop = body.scrollHeight
  }

  function setStatus(text) {
    const el = document.getElementById('butler-status')
    if (el) el.textContent = text || ''
  }

  async function ask(text, action = {}) {
    const input = document.getElementById('butler-input')
    const question = String(text ?? input?.value ?? '').trim()
    const answerValue = String(action.value || question).trim()
    if (!question || state.loading) return
    if (input) input.value = ''
    state.draft = ''
    state.messages.push({ role: 'user', html: escapeHtml(question) })
    state.loading = true
    setStatus('정원집사가 확인 중이에요...')
    renderMessages()
    saveCache('')
    try {
      const answer = action.mode === 'recommend-choice'
        ? await answerGardenRecommendationChoice(answerValue)
        : action.mode === 'start-recommend'
          ? await startRecommendationFlow({ locationId: answerValue })
          : await routeQuestion(question)
      state.messages.push({ role: 'bot', html: answer.html, actions: answer.actions ?? [] })
    } catch (err) {
      console.warn('butler failed', err)
      state.messages.push({ role: 'bot', html: '확인 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.' })
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
    const input = document.getElementById('butler-input')
    if (input) {
      input.value = state.draft || ''
      input.addEventListener('input', event => saveCache(event.target.value))
    }
    document.getElementById('butler-input').addEventListener('keydown', event => {
      if (event.key === 'Enter') ask()
    })
    document.getElementById('butler-voice').addEventListener('click', toggleVoice)
    root.querySelectorAll('[data-butler-question]').forEach(btn => {
      btn.addEventListener('click', () => ask(btn.dataset.butlerQuestion, {
        mode: btn.dataset.butlerMode,
        value: btn.dataset.butlerValue,
      }))
    })
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
