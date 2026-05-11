// ============================================================
// js/plant-finder.js
// 전역 식물 찾기: 사진 중심 풀스크린 검색 + 이름 보조 검색
// ============================================================

;(function () {
  const PLANT_ADD_MODE = 'direct'
  let _lastQuery = ''
  let _foundPlants = []
  let _candidates = []
  let _selectedFile = null
  let _previewUrl = ''

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]))
  }

  function plantFinderStyles() {
    if (document.getElementById('plant-finder-styles')) return ''
    return `
      <style id="plant-finder-styles">
        .pf-modal {
          position: fixed;
          inset: 0;
          z-index: 80;
          background: rgba(15, 23, 42, .45);
          color: #111827;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        .pf-page {
          width: 100%;
          max-width: 42rem;
          height: auto;
          max-height: min(88vh, 46rem);
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          background: #fff;
          border-radius: 1.35rem 1.35rem 0 0;
          overflow: hidden;
        }
        .pf-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          min-height: 3.5rem;
          padding: .75rem 1rem;
          border-bottom: 1px solid #eef2f7;
          background: rgba(255,255,255,.96);
        }
        .pf-close {
          width: 2.5rem;
          height: 2.5rem;
          border-radius: 9999px;
          color: #9ca3af;
          font-size: 1.5rem;
          line-height: 1;
        }
        .pf-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: .9rem .9rem 1rem;
          background: #fff;
        }
        .pf-hero {
          padding: .25rem 0 0;
        }
        .pf-action-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: .75rem;
        }
        .pf-action {
          min-height: 6.1rem;
          border-radius: 1.1rem;
          border: 1px solid #bbf7d0;
          background: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: .55rem;
          padding: 1rem .75rem;
          color: #047857;
          font-weight: 900;
          box-shadow: 0 8px 18px rgba(16,185,129,.07);
          transition: transform .12s ease, border-color .12s ease, background .12s ease;
        }
        .pf-action:active { transform: scale(.98); }
        .pf-action.primary {
          background: #16a34a;
          color: #fff;
          border-color: #16a34a;
        }
        .pf-action-icon {
          width: 2rem;
          height: 2rem;
          border-radius: .8rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(255,255,255,.2);
          font-size: 1.2rem;
        }
        .pf-action:not(.primary) .pf-action-icon { background: #ecfdf5; }
        .pf-preview-card,
        .pf-section {
          border-radius: 1.25rem;
          border: 1px solid #edf2f7;
          background: #fff;
          box-shadow: 0 8px 22px rgba(15,23,42,.045);
        }
        .pf-preview-img {
          width: 100%;
          aspect-ratio: 4 / 3;
          object-fit: cover;
          display: block;
          border-radius: 1rem;
          background: #f3f4f6;
        }
        .pf-result-card {
          display: flex;
          gap: .8rem;
          align-items: stretch;
          border-radius: 1rem;
          border: 1px solid #eef2f7;
          background: #fff;
          padding: .7rem;
        }
        .pf-result-img {
          width: 4.8rem;
          height: 4.8rem;
          border-radius: .85rem;
          background: #ecfdf5;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          color: #16a34a;
          font-weight: 900;
        }
        .pf-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 9999px;
          padding: .3rem .6rem;
          font-size: .72rem;
          font-weight: 800;
          background: #ecfdf5;
          color: #047857;
        }
        .pf-bottom {
          width: 100%;
          padding: .65rem .9rem calc(.65rem + env(safe-area-inset-bottom));
          background: #fff;
          border-top: 1px solid #eef2f7;
        }
        .pf-search-row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: .5rem;
          align-items: center;
          border-radius: 1rem;
          border: 1px solid #e5e7eb;
          background: #f9fafb;
          padding: .35rem;
        }
        .pf-search-row input {
          width: 100%;
          min-width: 0;
          border: 0;
          background: transparent;
          padding: .7rem .65rem;
          font-size: .9rem;
          outline: none;
        }
      </style>`
  }

  function ensureModal() {
    if (document.getElementById('plant-finder-modal')) return
    document.head.insertAdjacentHTML('beforeend', plantFinderStyles())
    document.body.insertAdjacentHTML('beforeend', `
      <div id="plant-finder-modal" class="pf-modal hidden" role="dialog" aria-modal="true" aria-labelledby="pf-title">
        <div class="pf-page">
          <div class="pf-header">
            <h3 id="pf-title" class="text-lg font-black text-gray-900">식물 찾기</h3>
            <button onclick="plantFinder.close()" class="pf-close" aria-label="닫기">×</button>
          </div>

          <div class="pf-body">
            <input id="pf-camera-file" type="file" accept="image/*" capture="environment" class="hidden" onchange="plantFinder.onFile(event)" />
            <input id="pf-gallery-file" type="file" accept="image/*" class="hidden" onchange="plantFinder.onFile(event)" />
            <input id="pf-photo-file" type="file" accept="image/*" class="hidden" onchange="plantFinder.onFile(event)" />

            <section id="pf-start" class="pf-hero hidden">
              <div class="pf-action-grid">
                <button type="button" onclick="plantFinder.pickPhoto()" class="pf-action primary">
                  <span class="pf-action-icon">▣</span>
                  <span>사진 선택</span>
                </button>
                <button type="button" onclick="plantFinder.pickGallery()" class="pf-action">
                  <span class="pf-action-icon">▤</span>
                  <span>앨범</span>
                </button>
              </div>
            </section>

            <section id="pf-preview-wrap" class="pf-preview-card hidden mt-4 p-3">
              <img id="pf-preview-img" class="pf-preview-img" alt="선택한 식물 사진" />
              <div class="mt-3 flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p id="pf-preview-title" class="text-sm font-black text-gray-900">사진 선택됨</p>
                  <p id="pf-preview-badge" class="mt-1 text-xs text-gray-500 truncate">분석 전</p>
                </div>
                <button type="button" onclick="plantFinder.pickPhoto()" class="rounded-full border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500">다시 선택</button>
              </div>
              <button id="pf-analyze-btn" type="button" onclick="plantFinder.analyzePhoto()" class="btn-primary w-full mt-3 py-3 rounded-xl font-black">
                이 사진으로 찾기
              </button>
            </section>

            <section id="pf-candidates" class="hidden mt-4">
              <div class="mb-2 flex items-end justify-between gap-2">
                <p class="text-sm font-black text-gray-900">후보 선택</p>
                <button type="button" onclick="plantFinder.pickPhoto()" class="text-xs font-bold text-green-700">다른 사진</button>
              </div>
              <div id="pf-candidate-list" class="space-y-2"></div>
            </section>

            <section id="pf-name-section" class="mt-4 hidden">
              <button type="button" onclick="plantFinder.toggleNameSearch()" class="w-full flex items-center justify-between gap-3">
                <span class="text-sm font-black text-gray-900">이름으로 찾기</span>
                <span id="pf-name-toggle" class="text-xs font-bold text-green-700">열기</span>
              </button>
              <div id="pf-name-search" class="hidden mt-2">
                <div class="pf-search-row">
                  <input id="pf-query" type="text" placeholder="예: 감국, 장미, 라벤더"
                    onkeydown="if(event.key==='Enter')plantFinder.search()" />
                  <button onclick="plantFinder.search()" class="btn-primary flex-shrink-0 px-4 py-2 rounded-xl">검색</button>
                </div>
              </div>
            </section>

            <p id="pf-status" class="hidden mt-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700 font-bold"></p>
            <p id="pf-error" class="hidden mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-500 font-bold"></p>

            <section id="pf-results" class="hidden mt-4">
              <div class="mb-2 flex items-end justify-between gap-2">
                <div>
                  <p class="text-sm font-black text-gray-900">도감 검색 결과</p>
                  <p id="pf-result-subtitle" class="hidden text-xs text-gray-500 mt-0.5"></p>
                </div>
              </div>
              <div id="pf-result-list" class="space-y-2"></div>
              <button id="pf-ai-btn" onclick="plantFinder.createUnknown()"
                class="hidden w-full mt-3 text-sm font-black text-green-700 py-3 border border-dashed border-green-300 rounded-xl hover:bg-green-50 transition-colors">
                AI로 새 식물 등록
              </button>
            </section>
          </div>

          <div class="pf-bottom">
            <button type="button" onclick="plantFinder.pickPhoto()" class="btn-primary w-full py-3 rounded-2xl font-black">
              다른 사진 선택
            </button>
          </div>
        </div>
      </div>`)
  }

  function setStatus(msg) {
    const el = document.getElementById('pf-status')
    if (!el) return
    el.textContent = msg
    el.classList.remove('hidden')
  }

  function setError(msg) {
    const el = document.getElementById('pf-error')
    if (!el) return
    el.textContent = msg
    el.classList.remove('hidden')
  }

  function clearFeedback() {
    document.getElementById('pf-status')?.classList.add('hidden')
    document.getElementById('pf-error')?.classList.add('hidden')
  }

  function resetSearchState({ keepPhoto = false } = {}) {
    clearFeedback()
    _foundPlants = []
    _candidates = []
    document.getElementById('pf-candidates')?.classList.add('hidden')
    document.getElementById('pf-results')?.classList.add('hidden')
    document.getElementById('pf-ai-btn')?.classList.add('hidden')
    if (!keepPhoto) resetPhoto()
  }

  function open() {
    ensureModal()
    resetSearchState()
    document.activeElement?.blur?.()
    pickPhoto()
  }

  function close() {
    document.getElementById('plant-finder-modal')?.classList.add('hidden')
    document.body.style.overflow = ''
  }

  function toggleNameSearch() {
    const box = document.getElementById('pf-name-search')
    const label = document.getElementById('pf-name-toggle')
    const hidden = box.classList.toggle('hidden')
    label.textContent = hidden ? '열기' : '닫기'
    if (!hidden) setTimeout(() => document.getElementById('pf-query')?.focus(), 50)
  }

  function pickCamera() {
    ensureModal()
    document.getElementById('pf-camera-file')?.click()
  }

  function pickPhoto() {
    ensureModal()
    document.getElementById('pf-photo-file')?.click()
  }

  function pickGallery() {
    ensureModal()
    document.getElementById('pf-gallery-file')?.click()
  }

  async function compressImage(file) {
    const objectUrl = URL.createObjectURL(file)
    const img = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = objectUrl
    })
    const max = 900
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(objectUrl)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
    return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' }
  }

  function onFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    ensureModal()
    resetSearchState({ keepPhoto: true })
    _selectedFile = file
    if (_previewUrl) URL.revokeObjectURL(_previewUrl)
    _previewUrl = URL.createObjectURL(file)
    document.getElementById('pf-preview-img').src = _previewUrl
    document.getElementById('pf-preview-title').textContent = '사진 선택됨'
    document.getElementById('pf-preview-badge').textContent = '분석 전'
    document.getElementById('pf-preview-wrap').classList.remove('hidden')
    document.getElementById('pf-start').classList.add('hidden')
    document.getElementById('pf-name-section').classList.remove('hidden')
    document.getElementById('plant-finder-modal').classList.remove('hidden')
    document.body.style.overflow = 'hidden'
    document.getElementById('pf-preview-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' })
    event.target.value = ''
  }

  function resetPhoto() {
    _selectedFile = null
    if (_previewUrl) URL.revokeObjectURL(_previewUrl)
    _previewUrl = ''
    document.getElementById('pf-preview-wrap')?.classList.add('hidden')
    document.getElementById('pf-start')?.classList.add('hidden')
    document.getElementById('pf-candidates')?.classList.add('hidden')
  }

  async function analyzePhoto() {
    if (!_selectedFile) {
      setError('먼저 사진을 선택해주세요.')
      return
    }
    clearFeedback()
    const btn = document.getElementById('pf-analyze-btn')
    const badge = document.getElementById('pf-preview-badge')
    btn.disabled = true
    btn.textContent = '분석 중...'
    badge.textContent = '분석 중'
    try {
      const compressed = await compressImage(_selectedFile)
      const result = await window.aiUtil.identifyPlantFromImage(compressed.base64, compressed.mimeType)
      if (!result.is_plant || result.candidates.length === 0) {
        badge.textContent = '후보 없음'
        setError('다른 사진이나 이름 검색을 이용해 주세요.')
        return
      }
      badge.textContent = '후보 찾음'
      renderCandidates(result.candidates)
      document.getElementById('pf-candidates').scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      badge.textContent = '분석 실패'
      setError(err.message)
    } finally {
      btn.disabled = false
      btn.textContent = '다시 찾기'
    }
  }

  function confidenceLabel(value) {
    const pct = Number(value)
    if (!Number.isFinite(pct)) return '가능성 확인'
    if (pct >= 0.75) return '가능성 높음'
    if (pct >= 0.5) return '가능성 보통'
    return '비슷한 후보'
  }

  function renderCandidates(candidates) {
    _candidates = candidates.slice(0, 5)
    const list = document.getElementById('pf-candidate-list')
    list.innerHTML = _candidates.map((c, i) => {
      const name = c.name_ko || c.name_en || c.scientific_name || '이름 확인 필요'
      const pct = Number(c.confidence)
      const pctText = Number.isFinite(pct) ? `${Math.round(pct * 100)}%` : ''
      return `<button type="button" onclick="plantFinder.searchCandidate(${i})" class="pf-result-card w-full text-left">
        <div class="pf-result-img">${i + 1}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-base font-black text-gray-900 truncate">${esc(name)}</p>
              <p class="mt-0.5 text-xs text-gray-400 truncate">${esc(c.scientific_name || c.name_en || '')}</p>
            </div>
            <span class="pf-chip flex-shrink-0">${esc(confidenceLabel(c.confidence))}${pctText ? ` · ${pctText}` : ''}</span>
          </div>
          ${c.hint ? `<p class="mt-2 text-xs leading-5 text-gray-600">${esc(c.hint)}</p>` : ''}
        </div>
      </button>`
    }).join('')
    document.getElementById('pf-candidates').classList.remove('hidden')
  }

  async function searchCandidate(index) {
    const c = _candidates[index]
    const name = c?.name_ko || c?.name_en || c?.scientific_name || ''
    if (!name) return
    document.getElementById('pf-query').value = name
    await search()
  }

  async function search() {
    ensureModal()
    clearFeedback()
    const query = document.getElementById('pf-query').value.trim()
    if (!query) { setError('검색할 식물 이름을 입력해주세요.'); return }
    _lastQuery = query
    _foundPlants = []
    document.getElementById('pf-results').classList.add('hidden')
    setStatus('검색 중')
    try {
      const { data, error } = await window._supabase
        .from('plants')
        .select('id, name, category, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main)')
        .ilike('name', `%${query}%`)
        .limit(20)
      if (error) throw error
      _foundPlants = data ?? []
      if (_foundPlants.length > 0) {
        setStatus(`${_foundPlants.length}개 찾음`)
        await renderResults()
        document.getElementById('pf-ai-btn').classList.remove('hidden')
      } else {
        setStatus('도감에 없음')
        document.getElementById('pf-result-subtitle').textContent = `"${query}" 검색 결과 없음`
        document.getElementById('pf-result-list').innerHTML = ''
        document.getElementById('pf-ai-btn').classList.remove('hidden')
        document.getElementById('pf-results').classList.remove('hidden')
      }
      document.getElementById('pf-results').scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      document.getElementById('pf-status').classList.add('hidden')
      setError(err.message)
    }
  }

  function plantImageUrl(p) {
    if (window.plantImageUrl) return window.plantImageUrl(p)
    const imgs = [...(p?.plant_images ?? [])].sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99))
    return imgs[0]?.image_url || null
  }

  async function hasMyPlant(plantId) {
    const { data, error } = await window._supabase
      .from('my_plants')
      .select('id')
      .eq('user_id', window.MY_USER_ID)
      .eq('plant_id', plantId)
      .maybeSingle()
    if (error) throw error
    return !!data
  }

  async function renderResults() {
    const alreadyEntries = await Promise.all(_foundPlants.map(async p => [p.id, await hasMyPlant(p.id)]))
    const alreadyMap = new Map(alreadyEntries)
    document.getElementById('pf-result-subtitle').textContent = `${_foundPlants.length}개의 식물을 찾았어요.`
    document.getElementById('pf-result-list').innerHTML = _foundPlants.map(p => {
      const url = plantImageUrl(p)
      const already = alreadyMap.get(p.id)
      return `<div class="pf-result-card">
        <div class="pf-result-img">
          ${url ? `<img src="${url}" class="w-full h-full object-cover" alt="${esc(p.name)}" />` : '<span>식물</span>'}
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-base font-black text-gray-900 leading-tight">${esc(p.name)}</p>
          <p class="mt-1 text-xs text-gray-400">${esc(p.category ?? '')}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button onclick="plantFinder.openPlant('${esc(p.id)}')" class="rounded-full border border-green-200 bg-white px-3 py-1.5 text-xs font-bold text-green-700">상세 보기</button>
            ${already
              ? `<span class="rounded-full bg-green-50 px-3 py-1.5 text-xs font-bold text-green-700">내 도감에 있음</span>`
              : `<button onclick="plantFinder.addToMybook('${esc(p.id)}')" class="rounded-full bg-green-600 px-3 py-1.5 text-xs font-bold text-white">도감에 추가</button>`}
          </div>
        </div>
      </div>`
    }).join('')
    document.getElementById('pf-results').classList.remove('hidden')
  }

  function openPlant(plantId) {
    window.location.href = `plant-detail.html#${encodeURIComponent(plantId)}`
  }

  async function addToMybook(plantId) {
    try {
      const { error } = await window._supabase
        .from('my_plants')
        .upsert({ user_id: window.MY_USER_ID, plant_id: plantId }, { onConflict: 'user_id,plant_id', ignoreDuplicates: false })
      if (error) throw error
      setStatus('내 도감에 추가했어요.')
      await renderResults()
      if (window.loadMybook) await window.loadMybook()
    } catch (err) {
      setError('추가 실패: ' + err.message)
    }
  }

  async function createUnknown() {
    if (!_lastQuery) { setError('먼저 식물 이름을 검색해주세요.'); return }
    if (PLANT_ADD_MODE !== 'direct') {
      setStatus('등록 요청 기능은 준비 중입니다.')
      return
    }
    try {
      setStatus('AI로 식물 정보를 생성 중이에요.')
      const payload = await window.aiUtil.generatePlantData(_lastQuery, setStatus)
      setStatus('도감에 등록 중이에요.')
      const { data: newPlant, error } = await window._supabase
        .from('plants')
        .insert(payload)
        .select('id, name, category, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main)')
        .single()
      if (error) throw error
      _foundPlants = [newPlant]
      await addToMybook(newPlant.id)
    } catch (err) {
      setError('AI 등록 실패: ' + err.message)
    }
  }

  function wireButtons() {
    document.querySelectorAll('[data-plant-finder-open]').forEach(btn => {
      if (btn.dataset.plantFinderBound) return
      btn.dataset.plantFinderBound = '1'
      btn.addEventListener('click', open)
    })
  }

  document.addEventListener('DOMContentLoaded', wireButtons)
  window.plantFinder = {
    open,
    close,
    toggleNameSearch,
    pickCamera,
    pickPhoto,
    pickGallery,
    onFile,
    resetPhoto,
    analyzePhoto,
    search,
    searchCandidate,
    openPlant,
    addToMybook,
    createUnknown,
  }
})()
