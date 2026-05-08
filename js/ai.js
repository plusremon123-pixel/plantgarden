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

    const MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']  // gemma2-9b-it 종료됨
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
          const msg = e?.error?.message ?? ''
          if (res.status === 429 || res.status === 503) { lastErr = new Error(`${model} 한도 초과`); continue }
          if (res.status === 400 && (msg.includes('decommissioned') || msg.includes('not supported') || msg.includes('deprecated'))) {
            lastErr = new Error(`${model} 지원 종료`); continue
          }
          throw new Error(`Groq 오류 (${res.status}): ${msg}`)
        }
        const json = await res.json()
        const raw  = json?.choices?.[0]?.message?.content ?? ''
        if (!raw) { lastErr = new Error(`${model} 빈 응답`); continue }
        return parseJson(raw)
      } catch (e) {
        if (e.message.includes('한도') || e.message.includes('503') || e.message.includes('지원 종료') ||
            e.message.includes('JSON') || e.message.includes('블록')) {
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
  "germination": "파종 후 발아까지 소요 일수 — 반드시 '숫자~숫자일' 형식 (예: 7~14일, 10~21일). 계절·시기·월 절대 금지. 해당 없으면 빈 문자열",
  "min_temp": "내한 한계 기온 정수 (섭씨)",
  "max_temp": "고온 한계 기온 정수 (섭씨)",
  "water_need": "물 요구도 — 반드시 낮음, 보통, 높음 중 하나",
  "watering_interval_min": "생육기 기준 물주기/흙마름 확인 최소 권장 간격 일수 정수",
  "watering_interval_max": "생육기 기준 물주기/흙마름 확인 최대 권장 간격 일수 정수",
  "watering_note": "물주기 요령 한 문장. 노지/화분 차이와 과습 주의가 있으면 포함",
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
- water_need / watering_interval_min / watering_interval_max / watering_note: 한국 정원·화분 생육기 기준. 고정 급수 명령이 아니라 흙마름 확인 권장 간격으로 산정.
- height/width: 성숙 식물의 실제 크기 범위 (cm 단위)
- bloom: 한국 노지 기준 실제 개화 시기 (월)
- germination: 파종 후 발아까지 소요 일수 (N~N일 형식). "봄·여름·가을·겨울·월" 등 계절/시기가 입력된 경우 반드시 일수로 교체.

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
      water_need:      ['낮음','보통','높음'].includes(dataFinal.water_need) ? dataFinal.water_need : null,
      watering_interval_min: Number.isInteger(Number(dataFinal.watering_interval_min)) ? Number(dataFinal.watering_interval_min) : null,
      watering_interval_max: Number.isInteger(Number(dataFinal.watering_interval_max)) ? Number(dataFinal.watering_interval_max) : null,
      watering_note:   dataFinal.watering_note || null,
      feature:         dataFinal.feature  || null,
      normalized_name,
    }
  }

  async function identifyPlantFromImage(base64, mimeType = 'image/jpeg') {
    const apiKey = await fetchKey()
    if (!apiKey) throw new Error('Groq API 키가 없습니다. 관리자 페이지에서 키를 설정해주세요.')

    const VISION_MODELS = [
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'llama-3.2-11b-vision-preview',
    ]
    const dataUrl = base64.startsWith('data:')
      ? base64
      : `data:${mimeType};base64,${base64}`
    const prompt = `사진 속 대상이 식물인지 판단하고, 가능한 식물 후보를 3~5개 JSON으로 반환하세요.
한국어 이름을 우선하되, 확실하지 않으면 가장 가능성 높은 일반명으로 적으세요.
사진이 식물이 아니면 is_plant=false, candidates=[] 로 반환하세요.

반드시 순수 JSON만 반환하세요:
{
  "is_plant": true,
  "candidates": [
    {
      "name_ko": "라벤더",
      "name_en": "Lavender",
      "scientific_name": "Lavandula angustifolia",
      "confidence": 0.82,
      "hint": "보라색 꽃대와 은녹색 잎이 특징"
    }
  ]
}`

    let lastErr = null
    for (const model of VISION_MODELS) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            }],
            temperature: 0.1,
            max_tokens: 900,
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          const msg = e?.error?.message ?? ''
          if (res.status === 429 || res.status === 503 || res.status === 400) {
            lastErr = new Error(`${model} 사용 불가: ${msg}`)
            continue
          }
          throw new Error(`Groq Vision 오류 (${res.status}): ${msg}`)
        }
        const json = await res.json()
        const raw = json?.choices?.[0]?.message?.content ?? ''
        if (!raw) { lastErr = new Error(`${model} 빈 응답`); continue }
        const parsed = parseJson(raw)
        return {
          is_plant: parsed.is_plant !== false,
          candidates: Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 5) : [],
        }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error('식물 사진 인식을 사용할 수 없습니다.')
  }

  window.aiUtil = { fetchKey, parseJson, callGroq, generatePlantData, identifyPlantFromImage }
})()
