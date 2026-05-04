// ============================================================
// supabase/functions/generate-plant-image/index.ts
//
// 흐름: Gemini API → 학명 변환 → iNaturalist 검색 → Storage 저장
//
// 배포:
//   npx supabase secrets set GEMINI_API_KEY=your_key
//   npx supabase functions deploy generate-plant-image --no-verify-jwt
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// ── Gemini로 학명 변환 ────────────────────────────────────
async function getScientificName(koreanName: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw new Error("GEMINI_API_KEY 환경변수 없음")

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `다음 한국 식물 이름의 학명(scientific name)을 알려주세요. 학명만 한 단어 또는 두 단어로 답하세요. 설명, 기호, 줄바꿈 없이 학명만: ${koreanName}`
        }]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 50 }
    })
  })
  if (!res.ok) throw new Error(`Gemini API 오류 (HTTP ${res.status})`)
  const json = await res.json()
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ""
  if (!text) throw new Error("Gemini 응답 없음")
  return text
}

// ── iNaturalist 이미지 검색 ───────────────────────────────
async function getINatImage(query: string): Promise<string | null> {
  try {
    const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(query)}&limit=5`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const json = await res.json()
    for (const taxon of (json?.results ?? [])) {
      const photoUrl = taxon?.default_photo?.medium_url
      if (photoUrl) return photoUrl
    }
    return null
  } catch {
    return null
  }
}

// ── 이미지 URL 검색 ───────────────────────────────────────
async function findImageUrl(plant: { name: string; image_prompt: string | null }): Promise<string> {
  // 1. Gemini로 학명 변환 후 iNaturalist 검색
  let scientificName = ""
  try {
    scientificName = await getScientificName(plant.name)
    console.log(`🔬 [${plant.name}] → 학명: ${scientificName}`)
    const img = await getINatImage(scientificName)
    if (img) return img
  } catch (e) {
    console.warn(`Gemini 실패: ${e}`)
  }

  // 2. 한국어 이름으로 직접 iNaturalist 검색
  const img2 = await getINatImage(plant.name)
  if (img2) return img2

  throw new Error(`이미지를 찾을 수 없음 (학명: ${scientificName || "변환 실패"})`)
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    const body = await req.json().catch(() => ({}))
    const { plant_id, process_all, limit = 3 } = body

    let plants: { id: string; name: string; image_prompt: string | null }[] = []

    if (process_all) {
      const { data, error } = await supabase
        .from("plants")
        .select("id, name, image_prompt")
        .or("image_url.is.null,image_url.eq.")
        .limit(limit)
      if (error) throw error
      plants = data ?? []
    } else if (plant_id) {
      const { data, error } = await supabase
        .from("plants")
        .select("id, name, image_prompt, image_url")
        .eq("id", plant_id)
        .maybeSingle()
      if (error) throw error
      if (data && !data.image_url) plants = [data]
    }

    if (plants.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, total: 0, success: 0, failed: 0, message: "처리할 식물 없음" }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      )
    }

    let success = 0
    let failed = 0
    const errors: string[] = []

    for (const plant of plants) {
      try {
        const imageUrl = await findImageUrl(plant)

        // 이미지 다운로드
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) })
        if (!imgRes.ok) throw new Error(`이미지 다운로드 실패 (HTTP ${imgRes.status})`)

        const imgBytes = await imgRes.arrayBuffer()
        const contentType = imgRes.headers.get("content-type") ?? "image/jpeg"
        const ext = contentType.includes("png") ? "png" : "jpg"
        const fileName = `${plant.id}.${ext}`

        // Storage 업로드 (버킷: plant)
        const { error: upErr } = await supabase.storage
          .from("plant")
          .upload(fileName, imgBytes, { contentType, upsert: true })
        if (upErr) throw new Error(`Storage 업로드 실패: ${upErr.message}`)

        const { data: urlData } = supabase.storage
          .from("plant")
          .getPublicUrl(fileName)

        // DB 업데이트
        const { error: updErr } = await supabase
          .from("plants")
          .update({ image_url: urlData.publicUrl })
          .eq("id", plant.id)
        if (updErr) throw new Error(`DB 업데이트 실패: ${updErr.message}`)

        success++
        console.log(`✅ [${plant.name}] → ${urlData.publicUrl}`)
      } catch (e: unknown) {
        const msg = `[${plant.name}] ${e instanceof Error ? e.message : String(e)}`
        console.error(`❌ ${msg}`)
        errors.push(msg)
        failed++
      }
    }

    return new Response(
      JSON.stringify({ ok: true, total: plants.length, success, failed, errors }),
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
