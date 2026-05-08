// ============================================================
// js/plant-finder.js
// 전역 식물 찾기 모달: 사진 후보 추천 + 이름 검색 + 내 도감 추가
// ============================================================

;(function () {
  const PLANT_ADD_MODE = 'direct'
  let _lastQuery = ''
  let _foundPlants = []
  let _candidates = []

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]))
  }

  function ensureModal() {
    if (document.getElementById('plant-finder-modal')) return
    document.body.insertAdjacentHTML('beforeend', `
      <div id="plant-finder-modal" class="modal-backdrop hidden" onclick="plantFinder.close(event)">
        <div class="modal-sheet" onclick="event.stopPropagation()">
          <div class="modal-header">
            <h3 class="font-bold text-gray-800">식물 찾기</h3>
            <button onclick="plantFinder.close()" class="modal-close">✕</button>
          </div>

          <input id="pf-camera-file" type="file" accept="image/*" capture="environment" class="hidden" onchange="plantFinder.onFile(event)" />
          <input id="pf-gallery-file" type="file" accept="image/*" class="hidden" onchange="plantFinder.onFile(event)" />
          <button onclick="plantFinder.openPhotoOptions()"
            class="w-full mb-3 flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-green-300 text-green-700 text-sm font-semibold bg-green-50 hover:bg-green-100 transition-colors active:scale-95">
            <span aria-hidden="true">📷</span><span>사진으로 식물 찾기</span>
          </button>
          <div id="pf-photo-options" class="hidden mb-3 grid grid-cols-2 gap-2">
            <button type="button" onclick="plantFinder.pickCamera()"
              class="rounded-xl border border-green-200 bg-white px-3 py-3 text-sm font-semibold text-green-700 hover:bg-green-50">
              카메라 촬영
            </button>
            <button type="button" onclick="plantFinder.pickGallery()"
              class="rounded-xl border border-green-200 bg-white px-3 py-3 text-sm font-semibold text-green-700 hover:bg-green-50">
              갤러리 선택
            </button>
          </div>

          <div id="pf-preview-wrap" class="hidden mb-3 relative rounded-xl overflow-hidden bg-gray-100">
            <img id="pf-preview-img" class="w-full max-h-48 object-cover" alt="선택한 식물 사진" />
            <div id="pf-preview-badge" class="absolute bottom-0 left-0 right-0 px-3 py-2 bg-black/55 text-white text-sm font-semibold text-center truncate"></div>
          </div>

          <div id="pf-candidates" class="hidden mb-3">
            <p class="text-xs font-semibold text-gray-500 mb-2">사진으로 찾은 후보</p>
            <div id="pf-candidate-list" class="space-y-2"></div>
          </div>

          <p class="text-xs font-semibold text-gray-500 mb-2">또는 이름으로 검색</p>
          <div class="flex gap-2 mb-3">
            <input id="pf-query" type="text" placeholder="식물 이름 입력..."
              class="input flex-1" onkeydown="if(event.key==='Enter')plantFinder.search()" />
            <button onclick="plantFinder.search()" class="btn-primary flex-shrink-0 px-4">검색</button>
          </div>

          <p id="pf-status" class="hidden text-sm text-green-700 font-medium mb-2"></p>
          <p id="pf-error" class="hidden text-sm text-red-500 mb-2"></p>
          <div id="pf-results" class="hidden">
            <div id="pf-result-list" class="space-y-2 max-h-64 overflow-y-auto pr-1"></div>
            <button id="pf-ai-btn" onclick="plantFinder.createUnknown()"
              class="hidden w-full mt-2 text-xs text-green-700 py-2 border border-dashed border-green-300 rounded-xl hover:bg-green-50 transition-colors">
              목록에 없음 — AI로 새로 등록
            </button>
          </div>
        </div>
      </div>`)
  }

  function setStatus(msg) {
    const el = document.getElementById('pf-status')
    el.textContent = msg
    el.classList.remove('hidden')
  }

  function setError(msg) {
    const el = document.getElementById('pf-error')
    el.textContent = msg
    el.classList.remove('hidden')
  }

  function clearFeedback() {
    document.getElementById('pf-status')?.classList.add('hidden')
    document.getElementById('pf-error')?.classList.add('hidden')
  }

  function open() {
    ensureModal()
    clearFeedback()
    document.getElementById('plant-finder-modal').classList.remove('hidden')
    document.activeElement?.blur?.()
  }

  function close(e) {
    if (e && e.target !== e.currentTarget) return
    document.getElementById('pf-photo-options')?.classList.add('hidden')
    document.getElementById('plant-finder-modal')?.classList.add('hidden')
  }

  function openPhotoOptions() {
    ensureModal()
    clearFeedback()
    document.getElementById('pf-photo-options')?.classList.toggle('hidden')
  }

  function pickCamera() {
    document.getElementById('pf-photo-options')?.classList.add('hidden')
    document.getElementById('pf-camera-file')?.click()
  }

  function pickGallery() {
    document.getElementById('pf-photo-options')?.classList.add('hidden')
    document.getElementById('pf-gallery-file')?.click()
  }

  async function compressImage(file) {
    const img = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = URL.createObjectURL(file)
    })
    const max = 800
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.75)
    return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' }
  }

  async function onFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    ensureModal()
    clearFeedback()
    document.getElementById('pf-candidates').classList.add('hidden')
    document.getElementById('pf-results').classList.add('hidden')
    const previewWrap = document.getElementById('pf-preview-wrap')
    const previewImg = document.getElementById('pf-preview-img')
    const badge = document.getElementById('pf-preview-badge')
    previewImg.src = URL.createObjectURL(file)
    badge.textContent = '식물 인식 중...'
    previewWrap.classList.remove('hidden')
    try {
      const compressed = await compressImage(file)
      const result = await window.aiUtil.identifyPlantFromImage(compressed.base64, compressed.mimeType)
      if (!result.is_plant || result.candidates.length === 0) {
        badge.textContent = '식물로 인식되지 않았어요'
        setError('식물 후보를 찾지 못했어요. 이름으로 직접 검색할 수 있습니다.')
        return
      }
      badge.textContent = `${result.candidates[0].name_ko ?? result.candidates[0].name_en ?? '후보'} 외 ${Math.max(0, result.candidates.length - 1)}개`
      renderCandidates(result.candidates)
    } catch (err) {
      badge.textContent = '인식 실패'
      setError(err.message)
    } finally {
      event.target.value = ''
    }
  }

  function renderCandidates(candidates) {
    _candidates = candidates
    const list = document.getElementById('pf-candidate-list')
    list.innerHTML = candidates.map((c, i) => {
      const name = c.name_ko || c.name_en || c.scientific_name || ''
      const pct = c.confidence == null ? '' : `${Math.round(Number(c.confidence) * 100)}%`
      return `<div class="flex items-center gap-2 rounded-xl border border-gray-100 bg-white p-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <p class="font-semibold text-sm text-gray-800 truncate">${esc(name)}</p>
            ${pct ? `<span class="text-[11px] text-green-600 font-bold">${pct}</span>` : ''}
          </div>
          <p class="text-xs text-gray-400 truncate">${esc(c.scientific_name || c.name_en || '')}</p>
          ${c.hint ? `<p class="text-xs text-gray-500 mt-1 line-clamp-2">${esc(c.hint)}</p>` : ''}
        </div>
        <button onclick="plantFinder.searchCandidate(${i})" class="btn-primary text-xs px-3 py-1.5 flex-shrink-0">검색</button>
      </div>`
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
    setStatus('도감에서 검색 중...')
    try {
      const { data, error } = await window._supabase
        .from('plants')
        .select('id, name, category, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main)')
        .ilike('name', `%${query}%`)
        .limit(20)
      if (error) throw error
      _foundPlants = data ?? []
      if (_foundPlants.length > 0) {
        setStatus(`검색 결과 ${_foundPlants.length}개`)
        await renderResults()
        document.getElementById('pf-ai-btn').classList.remove('hidden')
      } else {
        setStatus('도감에 없음 — AI로 새 식물 정보를 생성할 수 있어요.')
        document.getElementById('pf-result-list').innerHTML = ''
        document.getElementById('pf-ai-btn').classList.remove('hidden')
        document.getElementById('pf-results').classList.remove('hidden')
      }
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
    document.getElementById('pf-result-list').innerHTML = _foundPlants.map(p => {
      const url = plantImageUrl(p)
      const already = alreadyMap.get(p.id)
      return `<div class="flex items-center gap-3 p-2 rounded-xl border border-gray-100 bg-gray-50">
        <div class="w-12 h-12 rounded-lg bg-green-50 overflow-hidden flex-shrink-0 flex items-center justify-center text-xl">
          ${url ? `<img src="${url}" class="w-full h-full object-cover" alt="${esc(p.name)}" />` : '🌿'}
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-gray-800 truncate">${esc(p.name)}</p>
          <p class="text-xs text-gray-400">${esc(p.category ?? '')}</p>
        </div>
        ${already
          ? `<span class="text-xs text-green-600 font-semibold px-3 py-1.5 border border-green-200 rounded-lg bg-white whitespace-nowrap">추가됨</span>`
          : `<button onclick="plantFinder.addToMybook('${p.id}')" class="btn-primary text-xs px-3 py-1.5 flex-shrink-0 whitespace-nowrap">추가</button>`}
      </div>`
    }).join('')
    document.getElementById('pf-results').classList.remove('hidden')
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
      setStatus('AI로 식물 정보를 생성 중...')
      const payload = await window.aiUtil.generatePlantData(_lastQuery, setStatus)
      setStatus('도감에 등록 중...')
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
  window.plantFinder = { open, close, openPhotoOptions, pickCamera, pickGallery, onFile, search, searchCandidate, addToMybook, createUnknown }
})()
