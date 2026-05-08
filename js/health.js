// ============================================================
// js/health.js
// Plant health issue guides, products, and logs
// ============================================================

const healthApi = {
  async listOptions() {
    const { data, error } = await window._supabase
      .from('health_symptom_options')
      .select('id, step, label, issue_type, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (error) throw error
    return data ?? []
  },

  async listGuides() {
    const { data, error } = await window._supabase
      .from('health_issue_guides')
      .select('id, issue_type, issue_name, match_symptoms, match_locations, summary, first_action, organic_action, next_action, warning, priority')
      .eq('is_active', true)
      .order('priority', { ascending: true })
    if (error) throw error
    return data ?? []
  },

  async listProducts() {
    const { data, error } = await window._supabase
      .from('health_care_products')
      .select('id, issue_type, issue_names, product_level, product_type, display_name, example_products, use_place, caution, priority')
      .eq('is_active', true)
      .order('priority', { ascending: true })
    if (error) throw error
    return data ?? []
  },

  async listLogs(instanceId) {
    const { data, error } = await window._supabase
      .from('plant_health_logs')
      .select('id, garden_plant_id, issue_type, issue_name, symptom_tags, location_tags, severity, guide_id, status, started_at, resolved_at, created_at')
      .eq('garden_plant_id', instanceId)
      .or(`user_id.eq.${window.MY_USER_ID},user_id.is.null`)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async listActiveForInstances(instanceIds = []) {
    if (!instanceIds.length) return []
    const { data, error } = await window._supabase
      .from('plant_health_logs')
      .select('id, garden_plant_id, issue_type, issue_name, severity, status, started_at')
      .in('garden_plant_id', instanceIds)
      .eq('status', '진행중')
      .or(`user_id.eq.${window.MY_USER_ID},user_id.is.null`)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async addLog(payload) {
    const body = { ...payload, user_id: window.MY_USER_ID }
    const query = () => window._supabase
      .from('plant_health_logs')
      .insert(body)
      .select()
      .single()

    let { data, error } = await query()
    if (error && /row-level|policy|permission/i.test(error.message ?? '')) {
      const fallback = { ...payload, user_id: null }
      ;({ data, error } = await window._supabase
        .from('plant_health_logs')
        .insert(fallback)
        .select()
        .single())
    }
    if (error) throw error
    return data
  },

  async resolveLog(id) {
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await window._supabase
      .from('plant_health_logs')
      .update({ status: '해결', resolved_at: today, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },

  async resolveActive(instanceId) {
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await window._supabase
      .from('plant_health_logs')
      .update({ status: '해결', resolved_at: today, updated_at: new Date().toISOString() })
      .eq('garden_plant_id', instanceId)
      .eq('status', '진행중')
    if (error) throw error
  },

  matchGuide({ issueType, symptoms = [], locations = [] }, guides = []) {
    const target = guides.filter(g => g.issue_type === issueType)
    let best = target[0] ?? null
    let bestScore = -1
    target.forEach(guide => {
      const symptomScore = (guide.match_symptoms ?? []).filter(s => symptoms.includes(s)).length * 3
      const locationScore = (guide.match_locations ?? []).filter(l => locations.includes(l)).length * 2
      const score = symptomScore + locationScore - (Number(guide.priority) || 100) / 1000
      if (score > bestScore) {
        best = guide
        bestScore = score
      }
    })
    return best
  },

  productsFor(issueType, issueName, products = []) {
    const levelRank = { manual: 0, organic: 1, general: 2, expert: 3 }
    return products
      .filter(product => {
        if (product.issue_type !== issueType && product.product_level !== 'expert') return false
        const names = product.issue_names ?? []
        return names.length === 0 || names.includes(issueName) || product.product_level === 'expert'
      })
      .sort((a, b) => (levelRank[a.product_level] ?? 9) - (levelRank[b.product_level] ?? 9) || (a.priority ?? 100) - (b.priority ?? 100))
      .slice(0, 4)
  },
}

window.healthApi = healthApi
