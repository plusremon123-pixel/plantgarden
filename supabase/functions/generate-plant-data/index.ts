// ============================================================
// supabase/functions/generate-plant-data/index.ts
//
// 식물명 입력 → Gemini API → 식물 데이터 JSON 반환
//
// 배포:
//   npx supabase functions deploy generate-plant-data --no-verify-jwt
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const { plant_name } = await req.json()
    if (!plant_name) throw new Error("plant_name 필요")

    const apiKey = Deno.env.get("GEMINI_API_KEY")
    if (!apiKey) throw new Error("GEMINI_API_KEY 없음")

    const prompt = `다음 식물에 대한 정보를 JSON으로 반환해주세요.
식물명: ${plant_name}

아래 형식의 JSON만 반환하고 설명, 마크다운, 코드블록 없이 순수 JSON만 응답하세요.
null 없이 모든 필드를 채워주세요:
{
  "id": "영어 소문자 kebab-case (카테고리 영어 접두어 포함, 예: flower-chrysanthemum, herb-lavender, bulb-tulip, tree-maple, grass-miscanthus, vegetable-tomato)",
  "category": "꽃 또는 나무 또는 허브 또는 그라스 또는 구근 또는 채소 중 하나",
  "sun": "햇빛 조건 (예: 양지, 반양지, 음지)",
  "height": "식물 키 범위 (예: 30~50cm)",
  "width": "식물 너비 범위 (예: 20~30cm)",
  "bloom": "개화 시기 (예: 5~7월, 해당 없으면 빈 문자열)",
  "bloom_after": "파종 후 개화까지 기간 (예: 60~80일, 해당 없으면 빈 문자열)",
  "sowing": "파종 적기 (예: 3~4월, 해당 없으면 빈 문자열)",
  "germination": "발아 기간 (예: 7~14일, 해당 없으면 빈 문자열)",
  "feature": "식물 특징과 재배 포인트 2~3문장",
  "image_prompt": "영어로 된 식물 이미지 생성 프롬프트 (학명 또는 영어명 포함)"
}`

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }),
    })

    if (!res.ok) throw new Error(`Gemini API 오류 (HTTP ${res.status})`)

    const geminiJson = await res.json()
    const raw = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""

    // JSON 파싱 (마크다운 코드블록 제거)
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    const plantData = JSON.parse(cleaned)

    return new Response(
      JSON.stringify({ ok: true, data: plantData }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    )
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    )
  }
})
