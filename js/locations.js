// ============================================================
// js/locations.js
// locations 테이블 API
//
// 모든 select는 .eq('user_id', window.MY_USER_ID) 자동 적용
// 모든 insert는 user_id 자동 첨부
// ============================================================

const locationsApi = {

  /** level=1 전체 조회 */
  async getLevel1() {
    const { data, error } = await window._supabase
      .from('locations')
      .select('*')
      .eq('user_id', window.MY_USER_ID)
      .eq('level', 1)
      .order('display_order', { nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** level=2 조회 (parent_id 기준) */
  async getLevel2(parentId) {
    const { data, error } = await window._supabase
      .from('locations')
      .select('*')
      .eq('user_id', window.MY_USER_ID)
      .eq('level', 2)
      .eq('parent_id', parentId)
      .order('display_order', { nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** 모든 level=1 + level=2 한번에 (정원추가 드롭다운용) */
  async getAll() {
    const { data, error } = await window._supabase
      .from('locations')
      .select('*')
      .eq('user_id', window.MY_USER_ID)
      .order('level')
      .order('display_order', { nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** 위치 생성 — user_id 자동 첨부 */
  async insert(payload) {
    const withUser = { ...payload, user_id: window.MY_USER_ID }
    let { data, error } = await window._supabase
      .from('locations')
      .insert(withUser)
      .select()
      .single()
    if (isMissingCultivationColumn(error) && withUser.cultivation_type !== undefined) {
      console.warn('locations.cultivation_type column is missing. Retrying without cultivation_type.')
      const retryPayload = { ...withUser }
      delete retryPayload.cultivation_type
      ;({ data, error } = await window._supabase
        .from('locations')
        .insert(retryPayload)
        .select()
        .single())
    }
    if (error) throw error
    return data
  },

  /** 위치 수정 */
  async update(id, payload) {
    if (window.modooGardenProfile?.updateGuestLocation?.(id, payload)) {
      return { id, ...payload }
    }
    let { data, error } = await window._supabase
      .from('locations')
      .update(payload)
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
      .select()
      .single()
    if (isMissingCultivationColumn(error) && payload.cultivation_type !== undefined) {
      console.warn('locations.cultivation_type column is missing. Retrying without cultivation_type.')
      const retryPayload = { ...payload }
      delete retryPayload.cultivation_type
      ;({ data, error } = await window._supabase
        .from('locations')
        .update(retryPayload)
        .eq('id', id)
        .eq('user_id', window.MY_USER_ID)
        .select()
        .single())
    }
    if (error) throw error
    return data
  },

  /** 위치 삭제 */
  async remove(id) {
    if (window.modooGardenProfile?.deleteGuestLocation?.(id)) return
    const { error } = await window._supabase
      .from('locations')
      .delete()
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
    if (error) throw error
  },
}

function isMissingCultivationColumn(error) {
  return error?.code === '42703' && String(error?.message || '').includes('cultivation_type')
}

window.locationsApi = locationsApi

function getEffectiveSunlight(locationId, locations = []) {
  const loc = locations.find(l => l.id === locationId)
  if (!loc) return { value: null, source: null, location: null, inherited: false }

  if (loc.level === 2) {
    if (loc.sunlight_type) {
      return { value: loc.sunlight_type, source: loc, location: loc, inherited: false }
    }
    const parent = locations.find(l => l.id === loc.parent_id)
    return {
      value: parent?.sunlight_type ?? null,
      source: parent ?? null,
      location: loc,
      inherited: Boolean(parent?.sunlight_type),
    }
  }

  return {
    value: loc.sunlight_type ?? null,
    source: loc.sunlight_type ? loc : null,
    location: loc,
    inherited: false,
  }
}

function formatSunlightContext(context, fallback = '일조량 미설정') {
  if (!context?.value) return fallback
  return context.inherited ? `${context.value} · 상위 기준` : context.value
}

window.locationUtil = {
  getEffectiveSunlight,
  formatSunlightContext,
}
