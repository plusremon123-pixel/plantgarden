// ============================================================
// js/auth.js
// Supabase Auth 헬퍼 — 로그인·회원가입·로그아웃·세션 확인
// ============================================================

const auth = {
  /** 현재 세션 반환 (없으면 null) */
  async getSession() {
    const { data: { session } } = await window._supabase.auth.getSession()
    return session
  },

  /** 현재 로그인 사용자 반환 (없으면 null) */
  async getUser() {
    const session = await this.getSession()
    return session?.user ?? null
  },

  /** 이메일 + 비밀번호 로그인 */
  async signIn(email, password) {
    const { data, error } = await window._supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  },

  /** 이메일 + 비밀번호 회원가입 */
  async signUp(email, password) {
    const { data, error } = await window._supabase.auth.signUp({ email, password })
    if (error) throw error
    return data
  },

  /** 로그아웃 */
  async signOut() {
    const { error } = await window._supabase.auth.signOut()
    if (error) throw error
  },

  /**
   * 로그인 상태 확인 → 미로그인이면 login.html 로 이동
   * 보호가 필요한 페이지 최상단에서 호출
   */
  async requireAuth() {
    const user = await this.getUser()
    if (!user) {
      window.location.href = 'login.html'
    }
    return user
  },

  /**
   * 로그인 상태이면 garden.html 로 이동
   * login.html 에서 이미 로그인된 유저가 다시 오지 않도록
   */
  async redirectIfLoggedIn() {
    const user = await this.getUser()
    if (user) {
      window.location.href = 'garden.html'
    }
  },
}

window.auth = auth
