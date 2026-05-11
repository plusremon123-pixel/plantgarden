// ============================================================
// supabase/functions/identify-plant-image/index.ts
//
// 식물 사진 후보 인식 프록시
//
// 배포:
//   npx supabase secrets set GROQ_API_KEY=your_groq_key
//   npx supabase functions deploy identify-plant-image --no-verify-jwt
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
]

function cleanApiKey(value: unknown) {
  return String(value ?? "").replace(/[^\x20-\x7E]/g, "").trim()
}

function parseJson(raw: string) {
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim()
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("JSON 블록을 찾을 수 없습니다.")
  s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch (_) {
    s = s.replace(/,\s*([}\]])/g, "$1")
    return JSON.parse(s)
  }
}

async function readGroqKeyFromTable() {
  const url = Deno.env.get("SUPABASE_URL")
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.replace(/[^\x20-\x7E]/g, "").trim()
  if (!url || !serviceKey) return ""

  const res = await fetch(`${url}/rest/v1/app_secrets?key=eq.groq_api_key&select=value&limit=1`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  })
  if (!res.ok) return ""
  const rows = await res.json().catch(() => [])
  return cleanApiKey(rows?.[0]?.value ?? "")
}

async function getGroqKey() {
  return cleanApiKey(Deno.env.get("GROQ_API_KEY")) || await readGroqKeyFromTable()
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const { base64, mimeType = "image/jpeg" } = await req.json()
    if (!base64) throw new Error("base64 이미지가 필요합니다.")

    const apiKey = await getGroqKey()
    if (!apiKey) throw new Error("GROQ_API_KEY 없음")
    if (!apiKey.startsWith("gsk_")) throw new Error("Groq API 키 형식이 올바르지 않습니다.")

    const dataUrl = String(base64).startsWith("data:")
      ? String(base64)
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

    let lastError = ""
    for (const model of VISION_MODELS) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          }],
          temperature: 0.1,
          max_completion_tokens: 900,
          response_format: { type: "json_object" },
        }),
      })

      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        const msg = e?.error?.message ?? res.statusText
        if (res.status === 401 || /invalid api key/i.test(msg)) {
          throw new Error("Groq API 키가 유효하지 않습니다.")
        }
        lastError = `${model} 사용 불가: ${msg}`
        if ([400, 429, 503].includes(res.status)) continue
        throw new Error(lastError)
      }

      const json = await res.json()
      const raw = json?.choices?.[0]?.message?.content ?? ""
      if (!raw) {
        lastError = `${model} 빈 응답`
        continue
      }

      const parsed = parseJson(raw)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          is_plant: parsed.is_plant !== false,
          candidates: Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 5) : [],
        },
      }), { headers: { ...CORS, "Content-Type": "application/json" } })
    }

    throw new Error(lastError || "식물 사진 인식을 사용할 수 없습니다.")
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const status = /키|GROQ_API_KEY|API/i.test(message) ? 401 : 500
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }
})
