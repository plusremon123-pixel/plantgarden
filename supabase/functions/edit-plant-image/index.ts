// ============================================================
// supabase/functions/edit-plant-image/index.ts
//
// Admin plant image edit flow:
// - current: return up to 3 existing image URLs
// - preview: each existing image -> AI generated preview only
// - replace: approved previews -> Storage upload only
//
// Deploy:
//   npx supabase functions deploy edit-plant-image --no-verify-jwt
// Required secret:
//   npx supabase secrets set GEMINI_API_KEY=your_key
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

type PlantImageRow = {
  image_url: string
  storage_path: string | null
  sort_order: number | null
  is_main: boolean | null
}

type PlantEditImage = PlantImageRow & {
  index: number
}

function stripDataUrl(data: string) {
  const match = data.match(/^data:([^;]+);base64,(.+)$/)
  return match
    ? { mimeType: match[1], base64: match[2] }
    : { mimeType: "image/png", base64: data }
}

function base64ToBytes(base64: string) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function sortImages(images: PlantImageRow[]) {
  return [...images].sort((a, b) => {
    if (a.is_main && !b.is_main) return -1
    if (!a.is_main && b.is_main) return 1
    return (a.sort_order ?? 99) - (b.sort_order ?? 99)
  })
}

function getPublicBucket(imageUrl: string) {
  try {
    const url = new URL(imageUrl)
    const marker = "/storage/v1/object/public/"
    const markerIndex = url.pathname.indexOf(marker)
    if (markerIndex === -1) return null
    const rest = url.pathname.slice(markerIndex + marker.length)
    return decodeURIComponent(rest.split("/")[0] ?? "") || null
  } catch {
    return null
  }
}

async function getPlant(supabase: ReturnType<typeof createClient>, plantId: string) {
  const { data, error } = await supabase
    .from("plants")
    .select("id, name, category, plant_images!plant_images_plant_id_fkey(image_url, storage_path, sort_order, is_main)")
    .eq("id", plantId)
    .maybeSingle()

  if (error) throw new Error(error.message ?? JSON.stringify(error))
  if (!data) throw new Error("식물을 찾을 수 없습니다.")

  const images = sortImages((data.plant_images ?? []) as PlantImageRow[])
    .filter((image) => image.image_url)
    .slice(0, 3)
    .map((image, index) => ({ ...image, index }))
  if (!images.length) throw new Error("수정할 기존 이미지가 없습니다.")

  return {
    id: data.id as string,
    name: data.name as string,
    category: data.category as string | null,
    imagePrompt: null,
    images,
  }
}

async function downloadImage(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`기존 이미지 로드 실패 (HTTP ${res.status})`)
  const contentType = res.headers.get("content-type") ?? "image/jpeg"
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { contentType, base64: bytesToBase64(bytes) }
}

async function generatePreview(plant: Awaited<ReturnType<typeof getPlant>>, source: PlantEditImage) {
  const apiKey = Deno.env.get("GEMINI_API_KEY")
  if (!apiKey) throw new Error("GEMINI_API_KEY 없음")

  const original = await downloadImage(source.image_url)
  const imageNumber = source.index + 1
  const prompt = `Create a new realistic botanical photo of the same plant species as the reference image.

Plant name: ${plant.name}
Category: ${plant.category ?? "unknown"}
Known visual prompt: ${plant.imagePrompt ?? ""}
Source image number: ${imageNumber}

Requirements:
- realistic botanical photo
- preserve the same plant species and recognizable botanical traits
- use a new composition, new camera angle, and different natural background
- natural daylight
- high resolution, sharp, photographic detail
- make this edited version clearly different from the reference in composition, angle, and background

Do not:
- copy the original image
- perform simple color correction
- reuse the same composition or angle
- create illustration, icon, watercolor, anime, game style, or stylized art

Return only the new image.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: original.contentType, data: original.base64 } },
          ],
        }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Gemini 이미지 생성 실패 (HTTP ${res.status}): ${err?.error?.message ?? ""}`)
  }

  const json = await res.json()
  const parts = json?.candidates?.[0]?.content?.parts ?? []
  const imagePart = parts.find((part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData?.data)
  const data = imagePart?.inlineData?.data
  const mimeType = imagePart?.inlineData?.mimeType ?? "image/png"
  if (!data) throw new Error("AI가 이미지 데이터를 반환하지 않았습니다.")

  return { base64: data, mimeType }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json().catch(() => ({}))
    const action = body.action as "current" | "preview" | "replace"
    const plantId = String(body.plant_id ?? "").trim()

    if (!plantId) throw new Error("plant_id 필요")
    if (action !== "current" && action !== "preview" && action !== "replace") {
      throw new Error("action은 current, preview, replace 중 하나여야 합니다.")
    }

    const plant = await getPlant(supabase, plantId)

    if (action === "current") {
      return new Response(
        JSON.stringify({
          ok: true,
          plant: { id: plant.id, name: plant.name },
          original_image_url: plant.images[0].image_url,
          original_images: plant.images.map((image) => ({
            index: image.index,
            image_url: image.image_url,
            storage_path: image.storage_path,
            sort_order: image.sort_order,
            is_main: image.is_main,
          })),
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    if (action === "preview") {
      const generated = []
      for (const source of plant.images) {
        const preview = await generatePreview(plant, source)
        generated.push({ source, preview })
      }
      const previewImages = generated.map(({ source, preview }) => ({
        index: source.index,
        original_image_url: source.image_url,
        storage_path: source.storage_path,
        sort_order: source.sort_order,
        is_main: source.is_main,
        preview_image: `data:${preview.mimeType};base64,${preview.base64}`,
        preview_mime_type: preview.mimeType,
      }))

      return new Response(
        JSON.stringify({
          ok: true,
          plant: { id: plant.id, name: plant.name },
          original_image_url: plant.images[0].image_url,
          preview_images: previewImages,
          preview_image: previewImages[0]?.preview_image,
          preview_mime_type: previewImages[0]?.preview_mime_type ?? "image/png",
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    const previewImages = Array.isArray(body.preview_images) ? body.preview_images : []
    if (!previewImages.length && body.preview_image) {
      previewImages.push({ index: 0, preview_image: body.preview_image })
    }
    if (!previewImages.length) throw new Error("preview_images 필요")

    const uploaded = []
    for (let i = 0; i < previewImages.length; i++) {
      const item = previewImages[i]
      const source = plant.images.find((image) => image.index === Number(item.index)) ?? plant.images[i]
      if (!source) throw new Error(`업로드할 원본 이미지 정보를 찾을 수 없습니다. (${i + 1})`)

      const rawPreview = String(item.preview_image ?? "")
      if (!rawPreview) throw new Error(`preview_image 필요 (${i + 1})`)

      const parsed = stripDataUrl(rawPreview)
      const bytes = base64ToBytes(parsed.base64)
      const extPath = source.storage_path?.trim()
      const fileName = extPath || `${plant.id}_${String(source.index + 1).padStart(2, "0")}.png`
      const bucket = getPublicBucket(source.image_url) ?? "plants"

      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(fileName, bytes, { contentType: "image/png", upsert: true })
      if (upErr) throw new Error(`Storage 업로드 실패 (${fileName}): ${upErr.message}`)

      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName)

      uploaded.push({
        index: source.index,
        public_url: `${urlData.publicUrl}?t=${Date.now()}`,
        storage_path: fileName,
        bucket,
      })
    }

    return new Response(
      JSON.stringify({
        ok: true,
        uploaded,
        public_url: uploaded[0]?.public_url,
        storage_path: uploaded[0]?.storage_path,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  }
})
