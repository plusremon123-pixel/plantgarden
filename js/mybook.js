// ============================================================
// js/mybook.js
// my_plants 테이블 API — 사용자의 "내 도감"
//
// 모든 select는 .eq('user_id', window.MY_USER_ID) 자동 적용
// 모든 insert는 user_id 자동 첨부
// ============================================================

const myPlantsApi = {

  /**
   * 내 도감 목록 (plants JOIN + 내가 올린 사진 + 카탈로그 이미지)
   * 카드 표시용: 식물 메타 + 대표 이미지(my_plant_photos 최신 → plant_images main → null)
   */
  async list() {
    const { data, error } = await window._supabase
      .from('my_plants')
      .select(`
        id, plant_id, nickname, memo, status, added_at, updated_at,
        plants ( id, name, category, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) ),
        my_plant_photos ( id, image_url, taken_at, created_at )
      `)
      .eq('user_id', window.MY_USER_ID)
      .order('added_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** 단건 조회 (my_plant_id 기준) */
  async getById(id) {
    const { data, error } = await window._supabase
      .from('my_plants')
      .select(`
        id, plant_id, nickname, memo, status, added_at, updated_at,
        plants ( id, name, category, sun, height, width, bloom, bloom_after, feature, soil, plant_images!plant_images_plant_id_fkey(image_url, sort_order, is_main) ),
        my_plant_photos ( id, image_url, memo, taken_at, created_at )
      `)
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
      .single()
    if (error) throw error
    return data
  },

  /**
   * 도감에 식물 추가 (이미 있으면 그대로 반환)
   * @param {string} plantId — plants.id
   * @param {object} extras — { nickname, memo, status }
   */
  async add(plantId, extras = {}) {
    const payload = {
      user_id: window.MY_USER_ID,
      plant_id: plantId,
      ...extras,
    }
    const { data, error } = await window._supabase
      .from('my_plants')
      .upsert(payload, { onConflict: 'user_id,plant_id', ignoreDuplicates: false })
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 도감에서 제거 */
  async remove(id) {
    const { error } = await window._supabase
      .from('my_plants')
      .delete()
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
    if (error) throw error
  },

  /** 메모/상태/별명 수정 */
  async update(id, payload) {
    const { data, error } = await window._supabase
      .from('my_plants')
      .update(payload)
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 특정 plant_id 가 이미 도감에 있는지 확인 */
  async hasPlant(plantId) {
    const { data, error } = await window._supabase
      .from('my_plants')
      .select('id')
      .eq('user_id', window.MY_USER_ID)
      .eq('plant_id', plantId)
      .maybeSingle()
    if (error) throw error
    return !!data
  },
}

window.myPlantsApi = myPlantsApi

// ── 대표 이미지 결정 ────────────────────────────────────────
// 우선순위: my_plant_photos 최신 → plants.plant_images 의 sortedImages 첫 번째 → null
function myPlantThumb(myPlant) {
  const photos = myPlant.my_plant_photos ?? []
  if (photos.length > 0) {
    const newest = [...photos].sort((a, b) =>
      new Date(b.created_at || b.taken_at || 0) - new Date(a.created_at || a.taken_at || 0)
    )[0]
    if (newest?.image_url) return newest.image_url
  }
  if (myPlant.plants && window.plantImageUrl) {
    return window.plantImageUrl(myPlant.plants)
  }
  return null
}
window.myPlantThumb = myPlantThumb
