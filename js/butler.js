// ============================================================
// js/butler.js
// 정원집사: 저장하지 않는 대화형 정원 도우미
// ============================================================

;(function () {
  const QUICK_QUESTIONS = [
    '오늘 물 줘도 돼?',
    '오늘 할일 알려줘',
    '어디에 심어야 해?',
    '내 식물 찾아줘',
    '도감에서 찾아줘',
    '상태 상담',
  ]

  const state = {
    open: false,
    listening: false,
    messages: [],
    recognition: null,
    loading: false,
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]))
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
    const title = scope.plantName
      ? `${scope.plantName} 기준으로 확인했어요.`
      : scope.loc
        ? `${scope.loc.name} 기준으로 확인했어요.`
        : '전체 정원 기준으로 확인했어요.'
    const parts = [
      `<p>${escapeHtml(title)}</p>`,
      `<p>오늘 물주기 필요한 식물은 <b>${grouped.due.length}개</b>, 흙마름 확인은 <b>${grouped.check.length}개</b>예요.</p>`,
    ]
    if (grouped.due.length) parts.push(`<p class="butler-subtitle">물 줘도 좋아요</p>${itemList(grouped.due)}`)
    if (grouped.check.length) parts.push(`<p class="butler-subtitle">흙을 만져보고 주세요</p>${itemList(grouped.check)}`)
    if (!grouped.due.length && !grouped.check.length) parts.push('<p>오늘은 대부분 쉬어도 괜찮아 보여요.</p>')
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
    let activeHealth = []
    try {
      activeHealth = window.healthApi?.listActiveForInstances
        ? await window.healthApi.listActiveForInstances(instances.map(inst => inst.id))
        : []
    } catch (_) {
      activeHealth = []
    }

    const total = grouped.due.length + grouped.check.length + openTasks.length + sowing.length + cutting.length + activeHealth.length
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
      .replace(/도감|내|정원|식물|찾아줘|찾기|검색|어디|있어|에서|으로|를|을|좀|해줘/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function extractPlantingTerm(text) {
    return text
      .replace(/어디에|어디|심어야|심을까|심으면|심기|심어|좋아|좋을까|배치|추천|해줘|해야|돼|되|를|을|은|는|좀/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
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
    const memo = `${loc?.name ?? ''} ${loc?.note ?? ''}`.toLowerCase()
    if (!soil) return { score: 0, text: '토양 선호 정보는 아직 부족해요.' }
    const tokens = ['배수', '양토', '사질', '건조', '습한', '산성', '중성', '비옥']
    const matched = tokens.filter(token => soil.includes(token) && memo.includes(token))
    if (matched.length) return { score: 2, text: `메모 기준으로 ${matched.join(', ')} 조건이 맞아 보여요.` }
    return { score: 0, text: `${soil} 토양을 좋아해요. 해당 구역 흙 상태를 확인해 주세요.` }
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
    const matches = window.plantsApi?.list ? await window.plantsApi.list(term, '') : []
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

    const rows = scored.map(item => `
      <li>
        <b>${escapeHtml(locLabel(item.loc, locations))}</b>
        <br><span>${escapeHtml(item.position)}에 심는 걸 추천해요. ${escapeHtml(item.sunEval.text)}</span>
        <br><span>${escapeHtml(item.soilEval.text)}</span>
        <br><span>${escapeHtml(neighborAdvice(plant, item.neighbors))}</span>
      </li>
    `).join('')

    return {
      html: `<p><b>${escapeHtml(plant.name)}</b>은 아래 구역부터 확인해 보세요.</p><ul class="butler-list">${rows}</ul><p class="text-gray-400">상성은 현재 도감 정보의 햇빛, 토양, 키, 주변 식물 구성을 기준으로 본 1차 추천이에요.</p>`,
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
            return `<button class="butler-action" type="button" data-butler-question="${escapeHtml(action.question ?? action.label)}">${escapeHtml(action.label)}</button>`
          }).join('')}</div>`
        : ''
      return `<div class="butler-msg butler-msg-${msg.role}"><div class="butler-bubble">${msg.html}</div>${actions}</div>`
    }).join('')
    body.querySelectorAll('[data-butler-question]').forEach(btn => {
      btn.addEventListener('click', () => ask(btn.dataset.butlerQuestion))
    })
    body.scrollTop = body.scrollHeight
  }

  function setStatus(text) {
    const el = document.getElementById('butler-status')
    if (el) el.textContent = text || ''
  }

  async function ask(text) {
    const input = document.getElementById('butler-input')
    const question = String(text ?? input?.value ?? '').trim()
    if (!question || state.loading) return
    if (input) input.value = ''
    state.messages.push({ role: 'user', html: escapeHtml(question) })
    state.loading = true
    setStatus('정원집사가 확인 중이에요...')
    renderMessages()
    try {
      const answer = await routeQuestion(question)
      state.messages.push({ role: 'bot', html: answer.html, actions: answer.actions ?? [] })
    } catch (err) {
      console.warn('butler failed', err)
      state.messages.push({ role: 'bot', html: '확인 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.' })
    } finally {
      state.loading = false
      setStatus('')
      renderMessages()
    }
  }

  function openButler() {
    state.open = true
    document.getElementById('butler-root')?.classList.add('open')
    const input = document.getElementById('butler-input')
    setTimeout(() => input?.focus(), 120)
    if (!state.messages.length) {
      state.messages.push({
        role: 'bot',
        html: '안녕하세요. 저는 정원집사예요. 물주기, 오늘 할일, 식물 찾기를 도와드릴게요.',
      })
      renderMessages()
    }
  }

  function closeButler() {
    state.open = false
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
          ${QUICK_QUESTIONS.map(q => `<button type="button" data-butler-question="${q}">${q}</button>`).join('')}
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
    document.getElementById('butler-input').addEventListener('keydown', event => {
      if (event.key === 'Enter') ask()
    })
    document.getElementById('butler-voice').addEventListener('click', toggleVoice)
    root.querySelectorAll('[data-butler-question]').forEach(btn => {
      btn.addEventListener('click', () => ask(btn.dataset.butlerQuestion))
    })
    setupVoice()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }

  window.gardenButler = { open: openButler, close: closeButler, ask }
})()
