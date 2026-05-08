// ============================================================
// js/garden.js
// plant_instances CRUD
//
// 모든 select는 .eq('user_id', window.MY_USER_ID) 자동 적용
// 모든 insert는 user_id 자동 첨부
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
        planted_date, plant_age, source_type, cultivation_type, last_watered_at,
        plants ( id, name, category, min_temp, max_temp, water_need, watering_interval_min, watering_interval_max, watering_note, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) )
      `)
      .eq('user_id', window.MY_USER_ID)
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
        planted_date, plant_age, source_type, source_note, cultivation_type, last_watered_at,
        plants ( id, name, category, germination, germination_days_min, germination_days_max, cutting_root_days_min, cutting_root_days_max, bloom_after, min_temp, max_temp, water_need, watering_interval_min, watering_interval_max, watering_note, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) )
      `)
      .eq('user_id', window.MY_USER_ID)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** plant_instances 등록 — user_id 자동 첨부 */
  async insert(payload) {
    const withUser = { ...payload, user_id: window.MY_USER_ID }
    const { data, error } = await window._supabase
      .from('plant_instances')
      .insert(withUser)
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
        id, status, quantity, plant_age, source_type, source_note, cultivation_type, last_watered_at,
        planted_date, created_at, location_id,
        plants ( id, name, category, sun, soil, bloom, sowing, germination, germination_type, sowing_cover_depth_mm_min, sowing_cover_depth_mm_max, germination_days_min, germination_days_max, germination_temp_min, germination_temp_max, sowing_water_note, sowing_note, cutting_root_days_min, cutting_root_days_max, cutting_note, min_temp, max_temp, water_need, watering_interval_min, watering_interval_max, watering_note, feature, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) )
      `)
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
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
      .eq('user_id', window.MY_USER_ID)
    if (error) throw error
  },

  /** plants 카탈로그 조회 (식물추가 선택 드롭다운용) — plants는 공유 데이터라 user_id 필터 없음 */
  async getPlantOptions() {
    const { data, error } = await window._supabase
      .from('plants')
      .select('id, name, category, sowing, germination, germination_type, sowing_cover_depth_mm_min, sowing_cover_depth_mm_max, germination_days_min, germination_days_max, germination_temp_min, germination_temp_max, sowing_water_note, sowing_note, cutting_root_days_min, cutting_root_days_max, cutting_note, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main)')
      .order('name')
    if (error) throw error
    return data ?? []
  },
}

window.gardenApi = gardenApi

/**
 * 심은 날짜 → "N일째 / N주째 / N개월째 / N년째" 자동 계산
 */
function calcPlantAge(dateStr) {
  if (!dateStr) return null
  const planted = new Date(dateStr)
  const today   = new Date()
  const days    = Math.floor((today - planted) / 86400000)
  if (days < 0)  return null
  if (days === 0) return '오늘 심었어요'
  if (days < 7)  return `${days}일째`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}주째`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}개월째`
  const years     = Math.floor(months / 12)
  const remMonths = months % 12
  return remMonths === 0 ? `${years}년째` : `${years}년 ${remMonths}개월째`
}
window.calcPlantAge = calcPlantAge
