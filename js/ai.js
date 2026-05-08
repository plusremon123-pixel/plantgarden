// ============================================================
// js/ai.js — AI 식물 정보 생성 모듈 (Groq API)
//
// 의존: js/supabase.js (window._supabase)
// 사용: window.aiUtil.generatePlantData(name, onStatus)
// ============================================================

;(function () {
  let _groqKeyCache = null   // 페이지 단위 메모리 캐시

  // ── Supabase app_secrets에서 Groq 키 조회 ─────────────────
  async function fetchKey() {
    if (_groqKeyCache) return _groqKeyCache
    try {
      const { data, error } = await window._supabase
        .from('app_secrets')
        .select('value')
        .eq('key', 'groq_api_key')
        .single()
      if (!error && data?.value) {
        _groqKeyCache = data.value
        return data.value
      }
    } catch (_) {}
    return localStorage.getItem('groq_api_key') || ''
  }

  // ── JSON 파싱 헬퍼 ─────────────────────────────────────────
  function parseJson(raw) {
    let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const start = s.indexOf('{')
    const end   = s.lastIndexOf('}')
    if (start === -1 || end === -1)
      throw new Error('JSON 블록을 찾을 수 없습니다: ' + s.slice(0, 200))
    s = s.slice(start, end + 1)
    try { return JSON.parse(s) } catch (_) {}
    s = s.replace(/"((?:[^"\\]|\\[\s\S])*)"/g, m => m.replace(/\r?\n/g, '\\n'))
    try { return JSON.parse(s) } catch (_) {}
    s = s.replace(/,\s*([}\]])/g, '$1')
    try { return JSON.parse(s) } catch (_) {}
    s = s.replace(/[\x00-\x1F\x7F]/g, m => m === '\n' ? '\\n' : '')
    return JSON.parse(s)
  }

  // ── Groq API 호출 (모델 폴백 포함) ────────────────────────
  async function callGroq(prompt) {
    const apiKey = await fetchKey()
    if (!apiKey) throw new Error('Groq API 키가 없습니다. 관리자 페이지에서 키를 설정해주세요.')

    const MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it']
    let lastErr = null

    for (const model of MODELS) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 1024,
            response_format: { type: 'json_object' },
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          if (res.status === 429 || res.status === 503) { lastErr = new Error(`${model} 한도 초과`); continue }
          throw new Error(`Groq 오류 (${res.status}): ${e?.error?.message ?? ''}`)
        }
        const json = await res.json()
        const raw  = json?.choices?.[0]?.message?.content ?? ''
        if (!raw) { lastErr = new Error(`${model} 빈 응답`); continue }
        return parseJson(raw)
      } catch (e) {
        if (e.message.includes('한도') || e.message.includes('503') || e.message.includes('JSON') || e.message.includes('블록')) {
          lastErr = e; continue
        }
        throw e
      }
    }
    throw lastErr ?? new Error('Groq 사용 불가 — 잠시 후 다시 시도해주세요.')
  }

  // ── 식물 정보 2-pass 생성 ──────────────────────────────────
  // @param name       - 식물 이름 (한글/영문)
  // @param onStatus   - (msg: string) => void  상태 메시지 콜백
  // @returns          - plants 테이블 insert payload
  async function generatePlantData(name, onStatus = () => {}) {
    onStatus('1차: AI가 식물 정보를 검색 중...')

    const prompt1 = `다음 식물에 대한 정보를 JSON으로 반환해주세요.
식물명: ${name}

아래 형식의 JSON만 반환하고 설명, 마크다운, 코드블록 없이 순수 JSON만 응답하세요.
null 없이 모든 필드를 채워주세요:
{
  "id": "영어 소문자 kebab-case (카테고리 영어 접두어 포함, 예: rose-rosa-canina, flower-chrysanthemum, herb-lavender, bulb-tulip, tree-maple, grass-miscanthus)",
  "category": "반드시 다음 중 정확히 하나만: 장미, 허브, 꽃, 나무, 그라스, 구근, 채소",
  "soil": "선호 토양 한 문장 (예: 배수가 잘 되는 건조한 토양)",
  "sun": "햇빛 조건 (예: 양지, 반양지, 음지)",
  "height": "식물 키 범위 (예: 30~50cm)",
  "width": "식물 너비 범위 (예: 20~30cm)",
  "bloom": "개화 시기 (예: 5~7월, 해당 없으면 빈 문자열)",
  "bloom_after": "파종 후 개화까지 기간 (예: 60~80일, 해당 없으면 빈 문자열)",
  "sowing": "파종 적기 (예: 3~4월, 해당 없으면 빈 문자열)",
  "germination": "발아 기간 (예: 7~14일, 해당 없으면 빈 문자열)",
  "min_temp": "내한 한계 기온 정수 (섭씨)",
  "max_temp": "고온 한계 기온 정수 (섭씨)",
  "feature": "식물 특징과 재배 포인트 2~3문장. 줄바꿈 없이 한 줄로."
}
규칙: JSON 외 다른 텍스트 없이 순수 JSON만. 모든 문자열 값은 한 줄로.`

    const data1 = await callGroq(prompt1)

    onStatus('2차: 값 검증 및 수정 중...')

    const prompt2 = `당신은 식물학 전문가입니다. 아래는 "${name}" 식물에 대한 1차 추출 결과입니다.
각 필드가 식물학적으로 정확한지 학명(속명/과)을 기준으로 엄격하게 검증하고, 잘못된 값은 반드시 수정하세요.

[1차 추출 결과]
${JSON.stringify(data1, null, 2)}

[검증 기준]
- category: 학명의 속(genus)과 과(family)에 따라 분류. 반드시 다음 중 하나: 장미, 허브, 꽃, 나무, 그라스, 구근, 채소
- min_temp / max_temp: 식물학 자료 기준 내한/고온 한계 기온 (정수)
- height/width: 성숙 식물의 실제 크기 범위 (cm 단위)
- bloom: 한국 노지 기준 실제 개화 시기 (월)

[지시사항]
1차 결과를 기준으로 잘못된 값만 수정, 정확하면 그대로. 동일한 JSON 키 구조로 반환.
규칙: JSON 외 다른 텍스트 없이 순수 JSON만.`

    let dataFinal = data1
    try {
      const data2 = await callGroq(prompt2)
      dataFinal = { ...data1, ...data2 }
    } catch (_) {
      // 2차 실패 시 1차 사용
    }

    // normalized_name 자동 생성
    const normalized_name = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w가-힣-]/g, '')
      .trim() || null

    return {
      id:              dataFinal.id || normalized_name || name.toLowerCase().replace(/\s+/g, '-'),
      name,
      category:        dataFinal.category || '',
      soil:            dataFinal.soil     || null,
      sun:             dataFinal.sun      || null,
      height:          dataFinal.height   || null,
      width:           dataFinal.width    || null,
      bloom:           dataFinal.bloom    || null,
      bloom_after:     dataFinal.bloom_after || null,
      sowing:          dataFinal.sowing   || null,
      germination:     dataFinal.germination || null,
      min_temp:        Number.isInteger(Number(dataFinal.min_temp)) ? Number(dataFinal.min_temp) : null,
      max_temp:        Number.isInteger(Number(dataFinal.max_temp)) ? Number(dataFinal.max_temp) : null,
      feature:         dataFinal.feature  || null,
      normalized_name,
    }
  }

  window.aiUtil = { fetchKey, parseJson, callGroq, generatePlantData }
})()
