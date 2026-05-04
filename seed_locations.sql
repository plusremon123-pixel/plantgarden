-- ============================================================
-- seed_locations.sql
-- plant_instances의 location_id 기준으로 locations 데이터 생성
-- Supabase SQL Editor에서 실행하세요
-- ============================================================

-- STEP 1: 시골 (level=1) 추가
INSERT INTO locations (id, name, level, parent_id, display_order)
VALUES (
  gen_random_uuid(),  -- 새 UUID 자동 생성
  '시골',
  1,
  NULL,
  1
)
ON CONFLICT (id) DO NOTHING;

-- STEP 2: level=2 위치 추가 (plant_instances의 location_id와 동일한 UUID 사용)
-- 부모(시골)의 id를 서브쿼리로 참조

INSERT INTO locations (id, name, level, parent_id, display_order)
VALUES (
  '6131ddb3-57b6-4631-8eb0-3c66e9bdbb15',
  '우측화단',
  2,
  (SELECT id FROM locations WHERE name = '시골' AND level = 1 LIMIT 1),
  1
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO locations (id, name, level, parent_id, display_order)
VALUES (
  '4171b8f0-76ad-4cd7-83ee-3d99cb64a011',
  '창고앞',
  2,
  (SELECT id FROM locations WHERE name = '시골' AND level = 1 LIMIT 1),
  2
)
ON CONFLICT (id) DO NOTHING;

-- STEP 3: 결과 확인
SELECT
  l1.name AS "상위위치",
  l2.name AS "하위위치",
  l2.id   AS "location_id",
  (SELECT COUNT(*) FROM plant_instances pi WHERE pi.location_id = l2.id) AS "식물수"
FROM locations l2
LEFT JOIN locations l1 ON l2.parent_id = l1.id
WHERE l2.level = 2
ORDER BY l1.name, l2.display_order;
