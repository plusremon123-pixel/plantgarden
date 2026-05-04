// ============================================================
// js/locations.js
// locations 테이블 API
//
// 테이블 구조:
//   id (uuid), name (text), level (int), parent_id (uuid),
//   display_order (int), lat (float), lng (float),
//   sunlight_type (text), note (text)
// ============================================================

const locationsApi = {

  /** level=1 전체 조회 */
  async getLevel1() {
    const { data, error } = await window._supabase
      .from('locations')
      .select('*')
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
      .order('level')
      .order('display_order', { nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** 위치 생성 */
  async insert(payload) {
    const { data, error } = await window._supabase
      .from('locations')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 위치 수정 */
  async update(id, payload) {
    const { data, error } = await window._supabase
      .from('locations')
      .update(payload)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 위치 삭제 */
  async remove(id) {
    const { error } = await window._supabase
      .from('locations')
      .delete()
      .eq('id', id)
    if (error) throw error
  },
}

window.locationsApi = locationsApi
