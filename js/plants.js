// ============================================================
// js/plants.js
// plants 테이블 조회 · 검색 + plant_images 연동
// ============================================================

const plantsApi = {
  async list(query = '', category = '') {
    let req = window._supabase
      .from('plants')
      .select('id, name, category, sun, price, bloom, feature, plant_images!plant_images_plant_id_fkey(id, image_url, storage_path, sort_order, is_main)')
      .order('name')

    if (query.trim()) req = req.ilike('name', `%${query.trim()}%`)
    if (category)     req = req.eq('category', category)

    const { data, error } = await req
    if (error) throw error
    return data ?? []
  },

  async getById(id) {
    const { data, error } = await window._supabase
      .from('plants')
      .select('id, name, category, sun, height, width, bloom, bloom_after, sowing, germination, feature, price, created_at, plant_images!plant_images_plant_id_fkey(id, image_url, storage_path, sort_order, is_main)')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async getCategories() {
    const { data, error } = await window._supabase
      .from('plants')
      .select('category')
    if (error) throw error
    const cats = [...new Set((data ?? []).map(r => r.category).filter(Boolean))]
    return cats.sort()
  },
}

window.plantsApi = plantsApi

// ── plant_images 정렬 (is_main 우선, 이후 sort_order 오름차순) ──
function sortedImages(plant) {
  const imgs = plant.plant_images ?? []
  return [...imgs].sort((a, b) => {
    if (a.is_main && !b.is_main) return -1
    if (!a.is_main && b.is_main) return 1
    return (a.sort_order ?? 99) - (b.sort_order ?? 99)
  })
}
window.sortedImages = sortedImages

// ── 대표 이미지 URL (썸네일용) ────────────────────────────
// plant_images 중 is_main 우선, 없으면 sort_order 1번
function plantImageUrl(plant) {
  const imgs = sortedImages(plant)
  return imgs.length > 0 ? imgs[0].image_url : null
}
window.plantImageUrl = plantImageUrl

