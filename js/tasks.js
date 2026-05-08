// ============================================================
// js/tasks.js — plant_tasks 테이블 API
//
// 모든 insert는 user_id 자동 첨부
// ============================================================

const tasksApi = {

  /** 특정 인스턴스의 할 일 목록 (미완료 → 완료 순) */
  async list(instanceId) {
    const { data, error } = await window._supabase
      .from('plant_tasks')
      .select('*')
      .eq('plant_instance_id', instanceId)
      .eq('user_id', window.MY_USER_ID)
      .order('completed_at', { ascending: true, nullsFirst: true })
      .order('due_date',     { ascending: true, nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** 달력 화면용 전체 할 일 목록 */
  async listAll() {
    const { data, error } = await window._supabase
      .from('plant_tasks')
      .select('*')
      .eq('user_id', window.MY_USER_ID)
      .order('completed_at', { ascending: true, nullsFirst: true })
      .order('due_date',     { ascending: true, nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** 할 일 추가 */
  async add(payload) {
    const withUser = {
      ...payload,
      user_id: window.MY_USER_ID,
    }
    const { data, error } = await window._supabase
      .from('plant_tasks')
      .insert(withUser)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 완료 처리 */
  async complete(id) {
    const { data, error } = await window._supabase
      .from('plant_tasks')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 미완료로 되돌리기 */
  async uncomplete(id) {
    const { data, error } = await window._supabase
      .from('plant_tasks')
      .update({ completed_at: null })
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** 삭제 */
  async remove(id) {
    const { error } = await window._supabase
      .from('plant_tasks')
      .delete()
      .eq('id', id)
      .eq('user_id', window.MY_USER_ID)
    if (error) throw error
  },
}

window.tasksApi = tasksApi
