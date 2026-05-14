// ============================================================
// js/onboarding-profile.js
// 로그인 전 온보딩/게스트 정원 프로필 저장 및 기존 화면 연결
// ============================================================

(function () {
  const PROFILE_KEY = 'modooGardenProfile'
  const COMPLETE_KEY = 'modooGardenOnboardingCompleted'
  const GUEST_KEY = 'modooGardenGuestSession'

  function readProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch (_) {
      return null
    }
  }

  function writeProfile(profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
    localStorage.setItem(COMPLETE_KEY, 'true')
    if (profile?.userType === 'guest') localStorage.setItem(GUEST_KEY, 'true')
  }

  function isGuest() {
    return localStorage.getItem(GUEST_KEY) === 'true'
  }

  function gardenTheme(type) {
    if (['베란다', '우리집'].includes(type)) return '실내'
    if (type === '하우스') return '하우스'
    return '야외'
  }

  function normalizeCultivationType(value) {
    const text = String(value ?? '').trim()
    if (!text || text === '잘 모르겠어요') return ''
    if (text.includes('집 안') || text.includes('실내')) return '실내 화분'
    if (text.includes('밖') || text.includes('실외')) return '실외 화분'
    if (text.includes('화분')) return '실외 화분'
    if (text.includes('하우스') || text.includes('온실')) return '온실/하우스'
    if (text.includes('땅') || text.includes('노지')) return '노지'
    return text
  }

  function normalizeSpace(space, index, garden, sunlight, soil, cultivationType) {
    const raw = typeof space === 'string' ? { name: space } : (space ?? {})
    const name = raw.name || `공간 ${index + 1}`
    return {
      id: raw.id || `${garden.id}_space_${index + 1}`,
      name,
      level: 2,
      parent_id: garden.id,
      user_id: window.MY_USER_ID || 'guest',
      sunlight_type: raw.sunlight || sunlight || null,
      cultivation_type: normalizeCultivationType(raw.cultivationType || cultivationType) || null,
      soil_type: raw.soil || soil || null,
      note: raw.note || null,
      display_order: index + 1,
      _guest: true,
    }
  }

  function toGuestLocations(profile) {
    const garden = profile?.garden
    if (!garden?.id || !garden?.name) return { l1s: [], allLocs: [] }

    const l1 = {
      id: garden.id,
      name: garden.name,
      level: 1,
      parent_id: null,
      user_id: window.MY_USER_ID || 'guest',
      note: garden.note || (garden.region ? `${garden.type || '정원'} · ${garden.region}` : garden.type || null),
      lat: garden.lat ?? null,
      lng: garden.lng ?? null,
      address_text: garden.addressText || garden.region || null,
      sunlight_type: garden.sunlight || null,
      garden_theme: garden.theme || gardenTheme(garden.type),
      display_order: -1,
      _guest: true,
    }
    const spaces = Array.isArray(garden.spaces) ? garden.spaces : []
    const l2s = spaces
      .filter(space => (typeof space === 'string' ? space : space?.name) && (typeof space === 'string' ? space : space?.name) !== '나중에 할게요')
      .map((space, index) => normalizeSpace(space, index, garden, garden.sunlight, garden.soil, garden.cultivationType))

    return { l1s: [l1], allLocs: [l1, ...l2s] }
  }

  function mergeGuestLocations(l1s = [], allLocs = []) {
    const profile = readProfile()
    if (!profile || !isGuest()) return { l1s, allLocs }

    const guest = toGuestLocations(profile)
    const guestId = guest.l1s[0]?.id
    if (!guestId) return { l1s, allLocs }

    const withoutGuestL1 = l1s.filter(loc => loc.id !== guestId)
    const withoutGuestAll = allLocs.filter(loc => loc.id !== guestId && loc.parent_id !== guestId)
    return {
      l1s: [...guest.l1s, ...withoutGuestL1],
      allLocs: [...guest.allLocs, ...withoutGuestAll],
    }
  }

  function updateGuestLocation(id, payload = {}) {
    const profile = readProfile()
    const garden = profile?.garden
    if (!garden?.id || garden.id !== id && !Array.isArray(garden.spaces)) return false

    if (garden.id === id) {
      if (payload.name !== undefined) garden.name = payload.name
      if (payload.note !== undefined) garden.note = payload.note
      if (payload.sunlight_type !== undefined) garden.sunlight = payload.sunlight_type || ''
      if (payload.garden_theme !== undefined) garden.theme = payload.garden_theme || garden.theme
      if (payload.lat !== undefined) garden.lat = payload.lat
      if (payload.lng !== undefined) garden.lng = payload.lng
      if (payload.address_text !== undefined) {
        garden.addressText = payload.address_text || ''
        if (payload.address_text) garden.region = payload.address_text
      }
      writeProfile(profile)
      return true
    }

    const spaces = Array.isArray(garden.spaces) ? garden.spaces : []
    const space = spaces.find(item => item?.id === id)
    if (!space) return false
    if (payload.name !== undefined) space.name = payload.name
    if (payload.note !== undefined) space.note = payload.note
    if (payload.sunlight_type !== undefined) space.sunlight = payload.sunlight_type || ''
    if (payload.cultivation_type !== undefined) space.cultivationType = payload.cultivation_type || ''
    if (payload.soil_type !== undefined) space.soil = payload.soil_type || ''
    writeProfile(profile)
    return true
  }

  function deleteGuestLocation(id) {
    const profile = readProfile()
    const garden = profile?.garden
    if (!garden?.id) return false

    if (garden.id === id) {
      localStorage.removeItem(PROFILE_KEY)
      localStorage.removeItem(COMPLETE_KEY)
      localStorage.removeItem(GUEST_KEY)
      return true
    }

    if (!Array.isArray(garden.spaces)) return false
    const before = garden.spaces.length
    garden.spaces = garden.spaces.filter(space => space?.id !== id)
    if (garden.spaces.length === before) return false
    writeProfile(profile)
    return true
  }

  function buildProfile(draft = {}) {
    const now = new Date().toISOString()
    const gardenId = draft.gardenId || `garden_${Date.now()}`
    const type = draft.type || '우리집'
    const spaces = Array.isArray(draft.spaces)
      ? draft.spaces.map((name, index) => ({
          id: `${gardenId}_space_${index + 1}`,
          name,
          sunlight: draft.sunlight || null,
          cultivationType: normalizeCultivationType(draft.cultivationType) || null,
          soil: draft.soil || null,
        }))
      : []

    return {
      userType: 'guest',
      onboardingCompleted: true,
      createdAt: now,
      garden: {
        id: gardenId,
        name: draft.name || `${type} 정원`,
        type,
        region: draft.region || '',
        lat: draft.lat ?? null,
        lng: draft.lng ?? null,
        addressText: draft.addressText || draft.region || '',
        theme: gardenTheme(type),
        sunlight: draft.sunlight || '',
        cultivationType: normalizeCultivationType(draft.cultivationType) || '',
        soil: draft.soil || '',
        weatherEnabled: draft.weatherEnabled !== false,
        spaces,
      },
    }
  }

  window.modooGardenProfile = {
    readProfile,
    writeProfile,
    isGuest,
    mergeGuestLocations,
    updateGuestLocation,
    deleteGuestLocation,
    buildProfile,
  }
})()
