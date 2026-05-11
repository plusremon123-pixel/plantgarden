// ============================================================
// supabase/functions/groq-chat/index.ts
//
// Groq JSON chat proxy
//
// 배포:
//   npx supabase functions deploy groq-chat --no-verify-jwt
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]

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
    s = s.replace(/"((?:[^"\\]|\\[\s\S])*)"/g, (match) => match.replace(/\r?\n/g, "\\n"))
    s = s.replace(/,\s*([}\]])/g, "$1")
    s = s.replace(/[\x00-\x1F\x7F]/g, (m) => m === "\n" ? "\\n" : "")
    return JSON.parse(s)
  }
}

async function readGroqKeyFromTable() {
  const url = Deno.env.get("SUPABASE_URL")
  const serviceKey = cleanApiKey(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))
  if (!url || !serviceKey) return ""

  const res = await fetch(`${url}/rest/v1/app_secrets?key=eq.groq_api_key&select=value&limit=1`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  })
  if (!res.ok) return ""
  const rows = await res.json().catch(() => [])
  return cleanApiKey(rows?.[0]?.value)
}

async function getGroqKey() {
  return cleanApiKey(Deno.env.get("GROQ_API_KEY")) || await readGroqKeyFromTable()
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const { prompt, maxTokens = 1400 } = await req.json()
    if (!prompt) throw new Error("prompt 필요")

    const apiKey = await getGroqKey()
    if (!apiKey) throw new Error("GROQ_API_KEY 없음")
    if (!apiKey.startsWith("gsk_")) throw new Error("Groq API 키 형식이 올바르지 않습니다.")

    let lastError = ""
    for (const model of MODELS) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_completion_tokens: Math.min(Math.max(Number(maxTokens) || 1024, 256), 4096),
          response_format: { type: "json_object" },
        }),
      })

      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        const msg = e?.error?.message ?? res.statusText
        if (res.status === 401 || /invalid api key/i.test(msg)) throw new Error("Groq API 키가 유효하지 않습니다.")
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

      return new Response(JSON.stringify({ ok: true, data: parseJson(raw) }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      })
    }

    throw new Error(lastError || "Groq 사용 불가")
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const status = /키|GROQ_API_KEY|API/i.test(message) ? 401 : 500
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }
})
