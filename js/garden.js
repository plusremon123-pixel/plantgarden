// ============================================================
// js/garden.js
// plant_instances CRUD
//
// ※ plant_instances 테이블에 아래 컬럼이 필요합니다:
//    location_id  uuid  (FK → locations.id)
// ============================================================

const gardenApi = {

  /**
   * 특정 위치(location_id)의 plant_instances 조회
   * plants 테이블 JOIN (이름·이미지 표시용)
   */
  async listByLocation(locationId) {
    const { data, error } = await window._supabase
      .from('plant_instances')
      .select(`
        id, quantity, status, source_note,
        planted_date, plant_age, source_type,
        plants ( id, name, category, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) )
      `)
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** 전체 plant_instances 조회 (꽃밭 전체보기용) */
  async listAll() {
    const { data, error } = await window._supabase
      .from('plant_instances')
      .select(`
        id, quantity, status, location_id,
        planted_date, plant_age, source_type, source_note,
        plants ( id, name, category, germination, bloom_after, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) )
      `)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** plant_instances 등록 */
  async insert(payload) {
    const { data, error } = await window._supabase
      .from('plant_instances')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** plant_instances 단일 상세 조회 (plants JOIN, location은 별도 조회) */
  async getById(id) {
    const { data, error } = await window._supabase
      .from('plant_instances')
      .select(`
        id, status, quantity, plant_age, source_type, source_note,
        planted_date, created_at, location_id,
        plants ( id, name, category, sun, feature, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) )
      `)
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  /** plant_instances 삭제 */
  async remove(id) {
    const { error } = await window._supabase
      .from('plant_instances')
      .delete()
      .eq('id', id)
    if (error) throw error
  },

  /** plants 카탈로그 조회 (식물추가 선택 드롭다운용) */
  async getPlantOptions() {
    const { data, error } = await window._supabase
      .from('plants')
      .select('id, name, category, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main)')
      .order('name')
    if (error) throw error
    return data ?? []
  },
}

window.gardenApi = gardenApi
