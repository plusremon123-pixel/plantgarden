// ============================================================
// js/supabase.js
// Supabase 클라이언트 싱글톤 — 모든 페이지에서 가장 먼저 로드
// ============================================================

const SUPABASE_URL = 'https://chievhpocismxriqnyyj.supabase.co'
const SUPABASE_KEY = 'sb_publishable_jg5abvxfZPDCWANxOyMdcA_-6SeQFgm'

const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)

// 전역으로 노출 (다른 JS 파일에서 window._supabase 로 사용)
window._supabase = _supabase
