-- ============================================================
-- plant_instances.location (text) → location_id (uuid) 마이그레이션
-- Supabase SQL Editor에서 아래 STEP을 순서대로 실행하세요.
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- STEP 1: location_id 컬럼 추가
-- ──────────────────────────────────────────────────────────
ALTER TABLE plant_instances
  ADD COLUMN IF NOT EXISTS location_id uuid;


-- ──────────────────────────────────────────────────────────
-- STEP 2: 데이터 마이그레이션
--   "시골/우측화단" → level=1(시골) + level=2(우측화단) 매핑
-- ──────────────────────────────────────────────────────────

-- 2-A: "부모/자식" 형식 (슬래시 포함)
UPDATE plant_instances pi
SET    location_id = (
  SELECT l2.id
  FROM   locations l2
  JOIN   locations l1 ON l2.parent_id = l1.id
  WHERE  l1.level = 1
    AND  l2.level = 2
    AND  l1.name  = SPLIT_PART(pi.location, '/', 1)
    AND  l2.name  = SPLIT_PART(pi.location, '/', 2)
  LIMIT 1
)
WHERE  pi.location LIKE '%/%'
  AND  pi.location_id IS NULL;

-- 2-B: 단독 이름 형식 (슬래시 없음) — level=2 우선, 없으면 level=1
UPDATE plant_instances pi
SET    location_id = (
  SELECT id FROM locations
  WHERE  name = pi.location
  ORDER  BY level  -- level=2 우선 (낮은 숫자 아님, 2가 더 구체적이므로 DESC 또는 직접 지정)
  LIMIT 1
)
WHERE  pi.location NOT LIKE '%/%'
  AND  pi.location IS NOT NULL
  AND  pi.location_id IS NULL;


-- ──────────────────────────────────────────────────────────
-- STEP 3: 매핑 결과 확인 (실행 후 눈으로 검토)
-- ──────────────────────────────────────────────────────────
SELECT
  pi.id,
  pi.location        AS old_location,
  pi.location_id,
  l.name             AS matched_location_name,
  l.level
FROM   plant_instances pi
LEFT   JOIN locations l ON l.id = pi.location_id
ORDER  BY pi.location;


-- ──────────────────────────────────────────────────────────
-- STEP 4: FK 제약 추가 (STEP 3 확인 후 실행)
-- ──────────────────────────────────────────────────────────
ALTER TABLE plant_instances
  ADD CONSTRAINT fk_plant_instances_location_id
  FOREIGN KEY (location_id)
  REFERENCES locations (id)
  ON DELETE SET NULL;


-- ──────────────────────────────────────────────────────────
-- STEP 5: 기존 location 컬럼 제거 (최종 확인 후 실행)
-- ──────────────────────────────────────────────────────────
ALTER TABLE plant_instances
  DROP COLUMN IF EXISTS location;
