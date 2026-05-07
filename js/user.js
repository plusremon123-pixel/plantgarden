// ============================================================
// js/user.js
// 고정 사용자 ID — 회원가입 도입 전까지 모든 user_id 컬럼에 사용
//
// 사용:
//   insert: { user_id: window.MY_USER_ID, ... }
//   select: .eq('user_id', window.MY_USER_ID)
//
// 회원가입 도입 시:
//   window.MY_USER_ID = (await window.auth.getUser())?.id
//   로 대체하면 됨 (DB의 기존 user_id 값도 본인 auth.uid()로 일괄 UPDATE)
// ============================================================

window.MY_USER_ID = 'f3a713bd-4f89-4d90-bc71-3780155133ec'
